import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { CloseIcon } from "./icons";
import { speakText, transcribeAudio, type VoiceApiError } from "../lib/chat/voice/api";
import { logUsage, type UsageEntry } from "../lib/usage";

// Sprachmodus für MyBro.
//
// Bedienung:
// - Antippen startet die Aufnahme.
// - Automatische Sprachpausenerkennung (VAD): sobald ca. 1,6 s Stille
//   auf mindestens 300 ms echte Sprache folgen, wird gestoppt +
//   automatisch gesendet.
// - Erneutes Antippen während einer Aufnahme wirkt als Notfall-Stopp.
// - Ein transkribierter Text durchläuft weiterhin den normalen
//   Chat-Turn (persistiert als Nachricht, LLM-Antwort, TTS-Playback).

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
  idle: "Bereit",
  recording: "Hört zu…",
  transcribing: "Verstehe…",
  thinking: "Denkt nach…",
  speaking: "Antwortet…",
  error: "Fehler",
};

// VAD-Parameter (Voice Activity Detection).
const VOICE_LEVEL_THRESHOLD = 0.035; // gemittelter Analyser-Level > diesem = Sprache
const SILENCE_HOLD_MS = 1600;         // so lange Stille = Aufnahme beenden
const MIN_VOICE_MS = 300;             // erst nach so viel echter Sprache greift VAD
const MAX_RECORDING_MS = 30_000;      // Not-Aus falls VAD versagt

// Bevorzugte Audio-MIME-Types für MediaRecorder.
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
  const anyErr = err as {
    name?: string;
    message?: string;
    status?: number;
  };
  // Bewusst NUR echter Permission-Fehler mappt auf "verweigert" — kein
  // SecurityError, kein InvalidStateError, weil diese in der Praxis
  // andere Ursachen haben (AudioContext-Race, doppelter Node-Graph)
  // und der Nutzer sonst denkt, er hätte die Erlaubnis versaut.
  if (anyErr?.name === "NotAllowedError" || anyErr?.name === "PermissionDeniedError") {
    return "Mikrofonzugriff wurde verweigert. Bitte in den Browser-Einstellungen erlauben und erneut versuchen.";
  }
  if (anyErr?.name === "NotFoundError" || anyErr?.name === "OverconstrainedError") {
    return "Kein passendes Mikrofon gefunden.";
  }
  if (anyErr?.name === "NotReadableError") {
    return "Mikrofon ist gerade blockiert (nutzt es eine andere App?). Bitte erneut versuchen.";
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

// Farben (Messing-Akzent wie im Rest von MyBro).
const ACCENT = "#c9a227";
const ACCENT_BRIGHT = "#e8c14a";
const ACCENT_SOFT = "rgba(232, 193, 74, 0.35)";

type Particle = {
  angle: number;
  radius: number;
  speed: number;
  size: number;
  alpha: number;
};

function createParticles(): Particle[] {
  const arr: Particle[] = [];
  for (let i = 0; i < 24; i++) {
    arr.push({
      angle: Math.random() * Math.PI * 2,
      radius: 90 + Math.random() * 40,
      speed: 0.15 + Math.random() * 0.3,
      size: 0.6 + Math.random() * 1.2,
      alpha: 0.2 + Math.random() * 0.5,
    });
  }
  return arr;
}

export function VoiceOverlay({
  open,
  onClose,
  onTurn,
  userId,
}: VoiceOverlayProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Refs für Web-Audio / Recorder-State (RAF darf nicht gegen
  // React-State-Closures kämpfen).
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserBufferRef = useRef<Uint8Array | null>(null);
  const rafRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);
  const statusRef = useRef<Status>("idle");
  const particlesRef = useRef<Particle[]>(createParticles());

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordingStartRef = useRef<number>(0);
  const recordingMimeRef = useRef<string>("");

  // VAD-State.
  const voiceStartedAtRef = useRef<number>(0); // Zeitpunkt, ab dem Sprache erkannt wurde
  const lastVoiceAtRef = useRef<number>(0);    // letzter Zeitpunkt mit Level > THRESHOLD
  const autoStopTriggeredRef = useRef<boolean>(false);

  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioSourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const currentAudioRevokeRef = useRef<(() => void) | null>(null);

  const cancelledRef = useRef(false);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // ---------- Ressourcen-Aufräumen ----------
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
    const a = analyserRef.current;
    if (a) {
      try {
        a.disconnect();
      } catch {
        // ignore
      }
    }
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
  }, []);

  const closeAudioContext = useCallback(() => {
    const ctx = audioContextRef.current;
    if (ctx) {
      try {
        void ctx.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
  }, []);

  const releaseAll = useCallback(() => {
    stopAnimationLoop();
    releaseAnalyser();
    releaseAudioElement();
    releaseMicStream();
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
    closeAudioContext();
  }, [
    stopAnimationLoop,
    releaseAnalyser,
    releaseAudioElement,
    releaseMicStream,
    closeAudioContext,
  ]);

  // ---------- Web Audio Helpers ----------
  const ensureAudioContext = useCallback((): AudioContext => {
    let ctx = audioContextRef.current;
    if (!ctx || ctx.state === "closed") {
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

  // Vorwärtsdeklaration: stopRecording wird von drawFrame per Ref
  // aufgerufen (VAD-Trigger), definiert wird sie unten.
  const stopRecordingRef = useRef<() => void>(() => {});

  // ---------- Canvas-Animation (HUD) ----------
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      rafRef.current = requestAnimationFrame(drawFrame);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const cssSize = 360;
    if (canvas.width !== cssSize * dpr || canvas.height !== cssSize * dpr) {
      canvas.width = cssSize * dpr;
      canvas.height = cssSize * dpr;
      canvas.style.width = `${cssSize}px`;
      canvas.style.height = `${cssSize}px`;
    }
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssSize, cssSize);

    // Live-Level aus Analyser lesen (0..1).
    let rawLevel = 0;
    const analyser = analyserRef.current;
    const buffer = analyserBufferRef.current;
    if (analyser && buffer) {
      analyser.getByteFrequencyData(
        buffer as unknown as Uint8Array<ArrayBuffer>,
      );
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i];
      rawLevel = sum / buffer.length / 255;
    }

    const currentStatus = statusRef.current;
    const useRealLevel =
      currentStatus === "recording" || currentStatus === "speaking";
    const now = performance.now();

    // Idle-Breathing.
    if (!useRealLevel) {
      const t = now / 1000;
      rawLevel =
        0.04 + Math.sin(t * 1.3) * 0.02 + Math.sin(t * 0.6) * 0.02;
      rawLevel = Math.max(0, rawLevel);
    }

    const smoothing = useRealLevel ? 0.35 : 0.08;
    const prev = smoothedLevelRef.current;
    const level = prev + (rawLevel - prev) * smoothing;
    smoothedLevelRef.current = level;

    // ---------- VAD während Aufnahme ----------
    if (currentStatus === "recording") {
      if (rawLevel > VOICE_LEVEL_THRESHOLD) {
        lastVoiceAtRef.current = now;
        if (voiceStartedAtRef.current === 0) {
          voiceStartedAtRef.current = now;
        }
      }
      const started = voiceStartedAtRef.current;
      const lastVoice = lastVoiceAtRef.current;
      const elapsedSinceStart = now - recordingStartRef.current;
      const enoughVoice = started > 0 && now - started >= MIN_VOICE_MS;
      const silenceMs = lastVoice > 0 ? now - lastVoice : 0;

      if (
        !autoStopTriggeredRef.current &&
        ((enoughVoice && silenceMs >= SILENCE_HOLD_MS) ||
          elapsedSinceStart >= MAX_RECORDING_MS)
      ) {
        autoStopTriggeredRef.current = true;
        try {
          stopRecordingRef.current();
        } catch {
          // ignore
        }
      }
    }

    const cx = cssSize / 2;
    const cy = cssSize / 2;
    const baseRadius = 78;
    const maxExtra = 42;
    const radius = baseRadius + level * maxExtra;

    // ---------- Layer 1: weiches Zentral-Glow ----------
    const glow = ctx2d.createRadialGradient(
      cx,
      cy,
      radius * 0.15,
      cx,
      cy,
      radius * 2.6,
    );
    if (currentStatus === "error") {
      glow.addColorStop(0, "rgba(220, 80, 80, 0.35)");
      glow.addColorStop(0.5, "rgba(220, 80, 80, 0.08)");
      glow.addColorStop(1, "rgba(220, 80, 80, 0)");
    } else {
      glow.addColorStop(0, "rgba(232, 193, 74, 0.30)");
      glow.addColorStop(0.5, "rgba(201, 162, 39, 0.08)");
      glow.addColorStop(1, "rgba(201, 162, 39, 0)");
    }
    ctx2d.fillStyle = glow;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, radius * 2.6, 0, Math.PI * 2);
    ctx2d.fill();

    // ---------- Layer 2: äußerer HUD-Ring mit rotierenden Ticks ----------
    const outerR = 160;
    const tickCount = 72;
    const rot = (now / 6000) * Math.PI * 2; // langsam
    ctx2d.save();
    ctx2d.translate(cx, cy);
    ctx2d.rotate(rot);
    for (let i = 0; i < tickCount; i++) {
      const a = (i / tickCount) * Math.PI * 2;
      const long = i % 6 === 0;
      const len = long ? 12 : 5;
      const alpha = long ? 0.65 : 0.28;
      ctx2d.strokeStyle = `rgba(232, 193, 74, ${alpha})`;
      ctx2d.lineWidth = long ? 1.4 : 0.8;
      const x1 = Math.cos(a) * (outerR - len);
      const y1 = Math.sin(a) * (outerR - len);
      const x2 = Math.cos(a) * outerR;
      const y2 = Math.sin(a) * outerR;
      ctx2d.beginPath();
      ctx2d.moveTo(x1, y1);
      ctx2d.lineTo(x2, y2);
      ctx2d.stroke();
    }
    ctx2d.restore();

    // Feiner Ring als Kontur zum äußeren HUD.
    ctx2d.strokeStyle = "rgba(232, 193, 74, 0.18)";
    ctx2d.lineWidth = 0.7;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, outerR + 2, 0, Math.PI * 2);
    ctx2d.stroke();

    // Sekundär-Ring, gegenrotierend (dünn, sehr subtil).
    const rot2 = -(now / 9000) * Math.PI * 2;
    ctx2d.save();
    ctx2d.translate(cx, cy);
    ctx2d.rotate(rot2);
    const secR = 138;
    ctx2d.strokeStyle = "rgba(232, 193, 74, 0.10)";
    ctx2d.lineWidth = 0.6;
    ctx2d.setLineDash([4, 8]);
    ctx2d.beginPath();
    ctx2d.arc(0, 0, secR, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.setLineDash([]);
    ctx2d.restore();

    // ---------- Layer 3: mittlerer Wellen-Ring ----------
    const ringSegments = 128;
    const waveT = now / 1000;
    ctx2d.lineWidth = 1.8;
    ctx2d.strokeStyle = ACCENT_BRIGHT;
    ctx2d.shadowBlur = 8;
    ctx2d.shadowColor = ACCENT_SOFT;
    ctx2d.beginPath();
    for (let i = 0; i <= ringSegments; i++) {
      const a = (i / ringSegments) * Math.PI * 2;
      const wobble =
        Math.sin(a * 6 + waveT * 2.5) * 3 * (0.35 + level) +
        Math.sin(a * 3 - waveT * 1.7) * 4 * (0.3 + level) +
        Math.sin(a * 11 + waveT * 3.2) * 1.6 * (0.2 + level);
      const r = radius + 18 + wobble;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;

    // ---------- Layer 4: Partikel ----------
    const particles = particlesRef.current;
    const drift = useRealLevel ? 0.6 + level * 3.5 : 0.15;
    for (const p of particles) {
      p.radius += p.speed * drift;
      p.angle += 0.002;
      if (p.radius > outerR - 10) {
        p.radius = baseRadius + Math.random() * 20;
        p.angle = Math.random() * Math.PI * 2;
        p.alpha = 0.2 + Math.random() * 0.5;
      }
      const px = cx + Math.cos(p.angle) * p.radius;
      const py = cy + Math.sin(p.angle) * p.radius;
      const fade = 1 - (p.radius - baseRadius) / (outerR - baseRadius);
      ctx2d.fillStyle = `rgba(232, 193, 74, ${(p.alpha * fade).toFixed(3)})`;
      ctx2d.beginPath();
      ctx2d.arc(px, py, p.size, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // ---------- Layer 5: Kern mit Glow/Bloom ----------
    const core = ctx2d.createRadialGradient(cx, cy, 2, cx, cy, radius);
    core.addColorStop(0, "rgba(255, 236, 175, 0.95)");
    core.addColorStop(0.55, "rgba(217, 178, 58, 0.55)");
    core.addColorStop(1, "rgba(201, 162, 39, 0.06)");
    ctx2d.fillStyle = core;
    ctx2d.shadowBlur = 24;
    ctx2d.shadowColor = ACCENT;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.shadowBlur = 0;

    if (currentStatus === "error") {
      ctx2d.fillStyle = "rgba(220, 80, 80, 0.22)";
      ctx2d.beginPath();
      ctx2d.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx2d.fill();
    }

    // Recording-Marker: kleiner roter Punkt oben, zurückhaltend.
    if (currentStatus === "recording") {
      const pulse = 0.55 + Math.sin(now / 220) * 0.35;
      ctx2d.fillStyle = `rgba(232, 90, 90, ${pulse.toFixed(3)})`;
      ctx2d.beginPath();
      ctx2d.arc(cx, cy - outerR - 14, 3.5, 0, Math.PI * 2);
      ctx2d.fill();
    }

    rafRef.current = requestAnimationFrame(drawFrame);
  }, []);

  const ensureAnimationLoop = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(drawFrame);
  }, [drawFrame]);

  // ---------- Recording ----------
  const startRecording = useCallback(async () => {
    setError(null);

    // Immer sicherstellen, dass ein evtl. hängengebliebener alter Stream,
    // Analyser oder Recorder gestoppt ist, BEVOR wir einen neuen Zugriff
    // beantragen. Sonst kann iOS Safari einen frischen getUserMedia-Call
    // ablehnen (kein wirklich "denied"-Permission-Fehler, aber wir sind
    // auf der sicheren Seite).
    releaseAnalyser();
    releaseMicStream();
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
    voiceStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;
    autoStopTriggeredRef.current = false;

    let stream: MediaStream;
    try {
      // getUserMedia zuerst — der User-Gesture (Click) muss so nah wie
      // möglich am Aufruf sein, bevor irgendetwas Anderes awaitet.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      console.error("[voice] getUserMedia rejected:", e?.name, e?.message, err);
      setError(userFriendlyError(err));
      setStatus("error");
      return;
    }
    mediaStreamRef.current = stream;

    let recorder: MediaRecorder;
    try {
      const ctx = ensureAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      attachAnalyser(source);

      const mimeType = pickMimeType();
      recordingMimeRef.current = mimeType;
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      console.error("[voice] recorder setup failed:", e?.name, e?.message, err);
      setError(userFriendlyError(err));
      setStatus("error");
      releaseAnalyser();
      releaseMicStream();
      return;
    }

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
    try {
      recorder.start(250);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      console.error("[voice] recorder.start failed:", e?.name, e?.message, err);
      setError(userFriendlyError(err));
      setStatus("error");
      releaseAnalyser();
      releaseMicStream();
      return;
    }
    setStatus("recording");
  }, [attachAnalyser, ensureAudioContext, releaseAnalyser, releaseMicStream]);

  // ---------- TTS Playback (declared before runVoiceTurn) ----------
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

      releaseAudioElement();

      const ctx = ensureAudioContext();
      const audio = new Audio();
      audio.crossOrigin = "anonymous";
      audio.src = speak.audioUrl;
      audioElementRef.current = audio;
      currentAudioRevokeRef.current = speak.revoke;

      try {
        const source = ctx.createMediaElementSource(audio);
        source.connect(ctx.destination);
        attachAnalyser(source);
        audioSourceNodeRef.current = source;
      } catch (err) {
        console.warn("[voice] createMediaElementSource failed", err);
      }

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          audio.removeEventListener("ended", onEnded);
          audio.removeEventListener("error", onError);
        };
        const onEnded = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error("Audio konnte nicht abgespielt werden."));
        };
        audio.addEventListener("ended", onEnded);
        audio.addEventListener("error", onError);
        audio.play().catch((err) => {
          cleanup();
          reject(err);
        });
      });

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
    [onTurn, userId, playTts],
  );

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    const startedAt = recordingStartRef.current;
    const durationMs = performance.now() - startedAt;
    const mimeType = recordingMimeRef.current;

    const stopped = new Promise<void>((resolve) => {
      const onStop = () => {
        recorder.removeEventListener("stop", onStop);
        resolve();
      };
      recorder.addEventListener("stop", onStop);
    });
    try {
      if (recorder.state !== "inactive") recorder.stop();
      else resolveStopped();
    } catch {
      resolveStopped();
    }
    function resolveStopped() {
      // no-op: stopped-Promise wird per Event aufgelöst; wenn Recorder
      // schon inaktiv war, gibt es keinen stop-Event mehr → wir warten
      // hier bewusst nur kurz, indem wir das Promise nicht mehr blockieren.
    }
    await Promise.race([
      stopped,
      new Promise<void>((r) => setTimeout(r, 800)),
    ]);

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

  // stopRecordingRef aktuell halten, damit VAD-Trigger im drawFrame
  // immer die frische Callback aufruft.
  useEffect(() => {
    stopRecordingRef.current = () => {
      void stopRecording();
    };
  }, [stopRecording]);

  // ---------- Tap-Handler ----------
  const handleMainTap = useCallback(() => {
    if (status === "idle") {
      void startRecording();
      return;
    }
    if (status === "recording") {
      // Manueller Notfall-Stopp: als hätte VAD gegriffen.
      autoStopTriggeredRef.current = true;
      void stopRecording();
      return;
    }
    if (status === "error") {
      setError(null);
      setStatus("idle");
      return;
    }
  }, [status, startRecording, stopRecording]);

  // ---------- Lifecycle ----------
  useEffect(() => {
    if (!open) return;
    cancelledRef.current = false;
    ensureAnimationLoop();
    setStatus("idle");
    setError(null);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = prevOverflow;
      cancelledRef.current = true;
      releaseAll();
    };
  }, [open, ensureAnimationLoop, releaseAll]);

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

  const hint =
    status === "idle"
      ? "Antippen und sprechen — ich sende automatisch, wenn du pausierst."
      : status === "recording"
        ? "Sprich weiter. Antippen stoppt sofort."
        : status === "error"
          ? "Antippen für neuen Versuch, oder Sprachmodus schließen."
          : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="MyBro Sprachmodus"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      style={{
        background:
          "radial-gradient(ellipse at center, #0d0d12 0%, #050507 55%, #000000 100%)",
      }}
    >
      {/* Vignette-Schicht */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 90%)",
        }}
      />
      {/* Feine Scanline / Grid-Andeutung */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(232,193,74,0.6) 0px, rgba(232,193,74,0.6) 1px, transparent 1px, transparent 3px)",
        }}
      />

      <button
        type="button"
        onClick={onClose}
        aria-label="Sprachmodus schließen"
        className="absolute right-4 top-4 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border border-accent/25 bg-black/40 text-accent/70 backdrop-blur-sm transition-colors hover:text-accent"
      >
        <CloseIcon className="h-5 w-5" />
      </button>

      <div className="relative flex flex-col items-center gap-8 px-6 text-center">
        {/* Der ganze Kreis ist der Tap-Bereich. Kein Vollton-Button mehr. */}
        <button
          type="button"
          onClick={handleMainTap}
          disabled={!canTap}
          aria-label={
            status === "recording"
              ? "Aufnahme sofort stoppen"
              : status === "idle"
                ? "Sprachaufnahme starten"
                : "Sprachmodus"
          }
          className="group relative inline-flex h-[360px] w-[360px] items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
          style={{ background: "transparent" }}
        >
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0"
            aria-hidden="true"
          />
        </button>

        <div className="min-h-[3rem] max-w-md">
          <p
            className={
              error
                ? "font-mono text-sm uppercase tracking-[0.28em] text-red-300/90"
                : "font-mono text-sm uppercase tracking-[0.28em] text-accent/80"
            }
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            {statusText}
          </p>
          {hint ? (
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.32em] text-text-muted/60">
              {hint}
            </p>
          ) : null}
        </div>
      </div>

      <p className="absolute bottom-6 left-0 right-0 text-center font-mono text-[10px] uppercase tracking-[0.32em] text-text-muted/40">
        Deine Worte landen als Nachricht im Chatverlauf
      </p>
    </div>
  );
}
