import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CloseIcon, MicIcon } from "./icons";
import { speakText, transcribeAudio, type VoiceApiError } from "../lib/chat/voice/api";
import { logUsage, type UsageEntry } from "../lib/usage";

// Sprachmodus für MyBro.
//
// Vollbild-Overlay mit
// - großem, audio-reaktivem Kreis (Canvas), der beim Zuhören auf den
//   Mikrofon-Pegel und beim Sprechen auf den TTS-Playback-Pegel reagiert
// - Tap-to-talk-Bedienung (einmal antippen = Aufnahme, nochmal = senden)
// - klarem Zustandstext ("Ich höre zu", "Denke nach", …)
// - Fehlermeldungen statt stillem Hängenbleiben
//
// Der übergeordnete MyBroChat übergibt via `onTurn` eine Callback, die
// den transkribierten Text als reguläre Nutzernachricht persistiert,
// den LLM-Turn ausführt und die textuelle Antwort zurückgibt – so
// bleibt der komplette Sprachdialog Teil des normalen Chatverlaufs.

export type VoiceOverlayProps = {
  open: boolean;
  onClose: () => void;
  onTurn: (transcript: string) => Promise<string | null>;
  userId: string;
};

type Status =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

const STATUS_TEXT: Record<Status, string> = {
  idle: "Antippen, um zu sprechen",
  recording: "Ich höre zu … (nochmal antippen zum Senden)",
  transcribing: "Verstehe …",
  thinking: "Denke nach …",
  speaking: "Antworte …",
  error: "Etwas ist schiefgelaufen.",
};

const ACCENT_BRIGHT = "#e8c14a";

// Bevorzugte Audio-MIME-Types für MediaRecorder. Der erste vom Browser
// unterstützte gewinnt; leerer String = Browser-Default.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "",
];

function pickMimeType(): string {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }
  for (const c of MIME_CANDIDATES) {
    if (!c) return "";
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // ignore
    }
  }
  return "";
}

function userFriendlyError(err: unknown): string {
  if (!err) return "Unbekannter Fehler.";
  const anyErr = err as { name?: string; message?: string; status?: number };
  if (anyErr?.name === "NotAllowedError" || anyErr?.name === "SecurityError") {
    return "Mikrofonzugriff wurde verweigert. Bitte in den Browser-Einstellungen erlauben und erneut versuchen.";
  }
  if (anyErr?.name === "NotFoundError" || anyErr?.name === "OverconstrainedError") {
    return "Kein passendes Mikrofon gefunden.";
  }
  if (typeof anyErr?.message === "string" && anyErr.message.length > 0) {
    return anyErr.message;
  }
  if (typeof (err as VoiceApiError)?.message === "string") {
    return (err as VoiceApiError).message;
  }
  try {
    return String(err);
  } catch {
    return "Unbekannter Fehler.";
  }
}

export function VoiceOverlay({
  open,
  onClose,
  onTurn,
  userId,
}: VoiceOverlayProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Refs für Web-Audio / MediaRecorder-State, damit RAF-Callbacks nicht
  // gegen React-State-Closures kämpfen.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBufferRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);
  const statusRef = useRef<Status>("idle");

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef<number>(0);
  const recordingMimeRef = useRef<string>("");

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const currentAudioRevokeRef = useRef<(() => void) | null>(null);

  const cancelledRef = useRef(false);

  // Halte statusRef synchron, damit RAF-Callbacks den aktuellen
  // Zustand kennen ohne re-registrieren zu müssen.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const stopAnimationLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const releaseMicStream = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      mediaStreamRef.current = null;
    }
  }, []);

  const releaseAnalyser = useCallback(() => {
    analyserRef.current = null;
    analyserBufferRef.current = null;
  }, []);

  const releaseAudioElement = useCallback(() => {
    if (audioSourceNodeRef.current) {
      try {
        audioSourceNodeRef.current.disconnect();
      } catch {
        // ignore
      }
      audioSourceNodeRef.current = null;
    }
    const el = audioElementRef.current;
    if (el) {
      try {
        el.pause();
        el.src = "";
        el.load();
      } catch {
        // ignore
      }
      audioElementRef.current = null;
    }
    if (currentAudioRevokeRef.current) {
      try {
        currentAudioRevokeRef.current();
      } catch {
        // ignore
      }
      currentAudioRevokeRef.current = null;
    }
    currentAudioUrlRef.current = null;
  }, []);

  const releaseAll = useCallback(() => {
    stopAnimationLoop();
    releaseAnalyser();
    releaseAudioElement();
    releaseMicStream();
    const ctx = audioContextRef.current;
    if (ctx) {
      try {
        void ctx.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== "inactive") {
          mediaRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      mediaRecorderRef.current = null;
    }
    recordedChunksRef.current = [];
    smoothedLevelRef.current = 0;
  }, [
    stopAnimationLoop,
    releaseAnalyser,
    releaseAudioElement,
    releaseMicStream,
  ]);

  // ---------- Canvas-Animationsschleife ----------
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssSize = 320;
    if (canvas.width !== cssSize * dpr || canvas.height !== cssSize * dpr) {
      canvas.width = cssSize * dpr;
      canvas.height = cssSize * dpr;
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssSize}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);

    // Live-Pegel aus Analyser lesen.
    let rawLevel = 0;
    const analyser = analyserRef.current;
    const buffer = analyserBufferRef.current;
    if (analyser && buffer) {
      // getByteFrequencyData verlangt in aktuellen lib.dom-Typen ein
      // Uint8Array<ArrayBuffer>. Unser Buffer ist inhaltlich identisch,
      // aber TypeScript sieht Uint8Array<ArrayBufferLike> – daher hier
      // explizit casten.
      analyser.getByteFrequencyData(
        buffer as unknown as Uint8Array<ArrayBuffer>,
      );
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i];
      rawLevel = sum / buffer.length / 255; // 0..1
    }

    // Idle-Breathing, wenn kein aktiver Pegel-Quelltyp läuft.
    const currentStatus = statusRef.current;
    const useRealLevel =
      currentStatus === "recording" || currentStatus === "speaking";
    if (!useRealLevel) {
      const t = performance.now() / 1000;
      rawLevel = 0.05 + Math.sin(t * 1.5) * 0.02 + Math.sin(t * 0.7) * 0.02;
      rawLevel = Math.max(0, rawLevel);
    }

    // Zeitliches Glätten für weiche Kreisbewegungen.
    const smoothing = useRealLevel ? 0.4 : 0.08;
    const prev = smoothedLevelRef.current;
    const level = prev + (rawLevel - prev) * smoothing;
    smoothedLevelRef.current = level;

    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const baseRadius = 70;
    const maxExtra = 55;
    const radius = baseRadius + level * maxExtra;

    // Weiches Hintergrund-Glühen.
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2);
    glow.addColorStop(0, "rgba(201, 162, 39, 0.35)");
    glow.addColorStop(0.6, "rgba(201, 162, 39, 0.10)");
    glow.addColorStop(1, "rgba(201, 162, 39, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 2, 0, Math.PI * 2);
    ctx.fill();

    // Zwei umlaufende Ringe – der äußere pulsiert, der innere ist
    // dichter/stabiler. Wellenlinie erzeugt einen leicht organischen
    // Look, ohne die Marvel-Ästhetik zu kopieren.
    const now = performance.now() / 1000;
    const ringSegments = 96;

    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT_BRIGHT;
    ctx.beginPath();
    for (let i = 0; i <= ringSegments; i++) {
      const a = (i / ringSegments) * Math.PI * 2;
      const wobble =
        Math.sin(a * 6 + now * 2.5) * 3 * (0.4 + level) +
        Math.sin(a * 3 - now * 1.7) * 4 * (0.3 + level);
      const r = radius + 20 + wobble;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Kern-Kreis mit Verlauf.
    const core = ctx.createRadialGradient(cx, cy, 4, cx, cy, radius);
    core.addColorStop(0, "rgba(255, 235, 170, 0.95)");
    core.addColorStop(0.6, "rgba(217, 178, 58, 0.75)");
    core.addColorStop(1, "rgba(201, 162, 39, 0.15)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Fehler-Status: Kern rötlich einfärben.
    if (currentStatus === "error") {
      ctx.fillStyle = "rgba(220, 80, 80, 0.20)";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Recording-Statusring (roter Punkt oben).
    if (currentStatus === "recording") {
      ctx.fillStyle = "rgba(232, 90, 90, 0.95)";
      ctx.beginPath();
      ctx.arc(cx, cy - baseRadius - 12, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, []);

  const ensureAnimationLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);

  // ---------- Recording ----------

  const ensureAudioContext = useCallback((): AudioContext => {
    let ctx = audioContextRef.current;
    if (!ctx) {
      const Ctor: typeof AudioContext | undefined =
        (window as unknown as { AudioContext?: typeof AudioContext })
          .AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) throw new Error("Web Audio wird von diesem Browser nicht unterstützt.");
      ctx = new Ctor();
      audioContextRef.current = ctx;
    }
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
    return ctx;
  }, []);

  const attachAnalyser = useCallback((source: AudioNode) => {
    const ctx = source.context;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyserRef.current = analyser;
    analyserBufferRef.current = new Uint8Array(
      new ArrayBuffer(analyser.frequencyBinCount),
    );
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const ctx = ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const source = ctx.createMediaStreamSource(stream);
      attachAnalyser(source);

      const mimeType = pickMimeType();
      recordingMimeRef.current = mimeType;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      recordedChunksRef.current = [];
      recordingStartRef.current = performance.now();

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          recordedChunksRef.current.push(e.data);
        }
      };
      recorder.onerror = (e) => {
        console.error("[voice] MediaRecorder error", e);
        setError("Aufnahme fehlgeschlagen.");
        setStatus("error");
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setStatus("recording");
    } catch (err) {
      console.error("[voice] Aufnahme konnte nicht gestartet werden", err);
      setError(userFriendlyError(err));
      setStatus("error");
      releaseMicStream();
      releaseAnalyser();
    }
  }, [attachAnalyser, ensureAudioContext, releaseAnalyser, releaseMicStream]);

  const runVoiceTurn = useCallback(
    async (audioBlob: Blob, durationMs: number) => {
      if (cancelledRef.current) return;
      setStatus("transcribing");
      let transcript = "";
      try {
        const trResult = await transcribeAudio(audioBlob, durationMs);
        transcript = trResult.text.trim();
        if (trResult.usage.length > 0) {
          void logUsage(userId, trResult.usage as UsageEntry[]);
        }
      } catch (err) {
        console.error("[voice] Transkription fehlgeschlagen", err);
        if (cancelledRef.current) return;
        setError(userFriendlyError(err));
        setStatus("error");
        return;
      }

      if (!transcript) {
        setError("Ich habe nichts verstanden. Sprich bitte etwas lauter oder länger.");
        setStatus("error");
        return;
      }

      if (cancelledRef.current) return;
      setStatus("thinking");
      let assistantText: string | null = null;
      try {
        assistantText = await onTurn(transcript);
      } catch (err) {
        console.error("[voice] LLM-Turn fehlgeschlagen", err);
        if (cancelledRef.current) return;
        setError(userFriendlyError(err));
        setStatus("error");
        return;
      }

      if (cancelledRef.current) return;
      const spokenText = (assistantText ?? "").trim();
      if (!spokenText) {
        setStatus("idle");
        return;
      }

      setStatus("speaking");
      try {
        await playTts(spokenText);
      } catch (err) {
        console.error("[voice] TTS fehlgeschlagen", err);
        if (cancelledRef.current) return;
        setError(userFriendlyError(err));
        setStatus("error");
        return;
      }

      if (cancelledRef.current) return;
      setStatus("idle");
    },
    // playTts is stable via ref-based closure; we ignore lint here to
    // keep the callback identity stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onTurn, userId],
  );

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    const startedAt = recordingStartRef.current;
    const durationMs = performance.now() - startedAt;
    const mimeType = recordingMimeRef.current;

    // Warten, bis der letzte "dataavailable"-Chunk eingetrudelt ist.
    const stopped = new Promise<void>((resolve) => {
      const onStop = () => {
        recorder.removeEventListener("stop", onStop);
        resolve();
      };
      recorder.addEventListener("stop", onStop);
    });
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // ignore
    }
    await stopped;

    releaseAnalyser();
    releaseMicStream();
    mediaRecorderRef.current = null;

    const chunks = recordedChunksRef.current;
    recordedChunksRef.current = [];
    if (chunks.length === 0) {
      setStatus("idle");
      return;
    }
    const blob = new Blob(chunks, {
      type: mimeType || chunks[0]?.type || "audio/webm",
    });
    if (blob.size < 512) {
      setError("Aufnahme zu kurz. Bitte länger sprechen.");
      setStatus("error");
      return;
    }

    void runVoiceTurn(blob, durationMs);
  }, [releaseAnalyser, releaseMicStream, runVoiceTurn]);

  // ---------- TTS-Wiedergabe ----------
  const playTts = useCallback(
    async (text: string): Promise<void> => {
      const speak = await speakText(text);
      if (cancelledRef.current) {
        speak.revoke();
        return;
      }
      if (speak.usage.length > 0) {
        void logUsage(userId, speak.usage as UsageEntry[]);
      }

      // Vorheriges Audio aufräumen.
      releaseAudioElement();

      const ctx = ensureAudioContext();
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.src = speak.audioUrl;
      audioElementRef.current = audio;
      currentAudioUrlRef.current = speak.audioUrl;
      currentAudioRevokeRef.current = speak.revoke;

      try {
        const source = ctx.createMediaElementSource(audio);
        source.connect(ctx.destination);
        attachAnalyser(source);
        audioSourceNodeRef.current = source;
      } catch (err) {
        // Manche Browser erlauben nur einen MediaElementSource pro
        // Element; im Fehlerfall spielen wir das Audio wenigstens ohne
        // Analyser ab.
        console.warn("[voice] createMediaElementSource failed", err);
      }

      await new Promise<void>((resolve, reject) => {
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Audio konnte nicht abgespielt werden."));
        };
        const cleanup = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
        };
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        audio.play().catch((err) => {
          cleanup();
          reject(err);
        });
      });

      // Nach dem Ende Analyser lösen, damit der Kreis wieder ins Idle
      // fällt statt weiter zu spitzen.
      releaseAudioElement();
      releaseAnalyser();
    },
    [
      attachAnalyser,
      ensureAudioContext,
      releaseAnalyser,
      releaseAudioElement,
      userId,
    ],
  );

  // ---------- Tap-Handler ----------
  const handleMainTap = useCallback(async () => {
    if (status === "idle") {
      await startRecording();
      return;
    }
    if (status === "recording") {
      await stopRecording();
      return;
    }
    if (status === "error") {
      setError(null);
      setStatus("idle");
      return;
    }
    // In transcribing/thinking/speaking bewusst kein Tap – der Nutzer
    // wartet die aktuelle Antwort ab.
  }, [status, startRecording, stopRecording]);

  // ---------- Lifecycle ----------
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    ensureAnimationLoop();
    setStatus("idle");
    setError(null);

    // Body-Scroll unterbinden, solange das Overlay offen ist.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevOverflow;
      cancelledRef.current = true;
      releaseAll();
    };
  }, [open, ensureAnimationLoop, releaseAll]);

  // ESC schließt das Overlay.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const statusText = error ?? STATUS_TEXT[status];
  const canTap =
    status === "idle" || status === "recording" || status === "error";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MyBro Sprachmodus"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 backdrop-blur-md"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Sprachmodus schließen"
        className="absolute right-4 top-4 inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-muted transition-colors hover:text-text"
      >
        <CloseIcon className="h-5 w-5" />
      </button>

      <div className="flex flex-col items-center gap-8 px-6 text-center">
        <button
          type="button"
          onClick={() => {
            void handleMainTap();
          }}
          disabled={!canTap}
          aria-label={
            status === "recording"
              ? "Aufnahme stoppen und senden"
              : status === "idle"
                ? "Aufnahme starten"
                : "Sprachmodus"
          }
          className="group relative inline-flex h-[320px] w-[320px] items-center justify-center rounded-full outline-none focus-visible:ring-4 focus-visible:ring-accent/40 disabled:cursor-default"
        >
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          />
          <span className="pointer-events-none relative inline-flex h-16 w-16 items-center justify-center rounded-full border border-accent/60 bg-bg/40 text-accent shadow-lg backdrop-blur-sm">
            <MicIcon className="h-7 w-7" />
          </span>
        </button>

        <div className="min-h-[3rem] max-w-md">
          <p
            className={
              error
                ? "text-base text-red-300"
                : "text-base text-text-muted"
            }
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            {statusText}
          </p>
          {status === "recording" ? (
            <p className="mt-2 text-xs text-text-muted">
              Nochmal antippen, um deine Aufnahme zu senden.
            </p>
          ) : null}
          {status === "error" ? (
            <p className="mt-2 text-xs text-text-muted">
              Tippe den Kreis an, um erneut zu versuchen, oder schließe den Sprachmodus.
            </p>
          ) : null}
        </div>
      </div>

      <p className="absolute bottom-6 left-0 right-0 text-center text-xs text-text-muted/70">
        Deine Worte landen als normale Nachricht im Chatverlauf.
      </p>
    </div>
  );
}
