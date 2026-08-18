// Client-Wrapper für die Sprachmodus-Endpoints
// (/api/voice-transcribe, /api/voice-speak). Bewusst schlank gehalten –
// die Geschäftslogik (LLM-Turn, Persistenz) sitzt weiterhin im
// MyBro-Chat.

import type { UsageEntry } from "../../usage";

export type VoiceApiError = {
  status: number;
  message: string;
};

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(json: unknown, fallback: string): string {
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "string" &&
    (json as { error: string }).error.length > 0
  ) {
    return (json as { error: string }).error;
  }
  return fallback;
}

export type TranscribeResult = {
  text: string;
  usage: UsageEntry[];
};

export async function transcribeAudio(
  audio: Blob,
  durationMs: number,
): Promise<TranscribeResult> {
  const form = new FormData();
  const filename =
    audio.type && audio.type.includes("mp4")
      ? "audio.mp4"
      : audio.type && audio.type.includes("ogg")
        ? "audio.ogg"
        : "audio.webm";
  form.append("audio", audio, filename);
  form.append("duration_ms", String(Math.max(0, Math.round(durationMs))));
  form.append("language", "de");

  const res = await fetch("/api/voice-transcribe", {
    method: "POST",
    body: form,
  });
  const json = await readJson(res);

  if (!res.ok) {
    const err: VoiceApiError = {
      status: res.status,
      message: extractErrorMessage(
        json,
        `Transkription fehlgeschlagen (HTTP ${res.status}).`,
      ),
    };
    throw err;
  }

  const obj = (json ?? {}) as { text?: unknown; _usage?: unknown };
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  const usage = Array.isArray(obj._usage) ? (obj._usage as UsageEntry[]) : [];
  return { text, usage };
}

export type SpeakResult = {
  audioUrl: string;
  // Rohe Audio-Bytes für den Web-Audio-API-Pfad (decodeAudioData +
  // AudioBufferSourceNode). Umgeht die Autoplay-Policy von <audio>.
  arrayBuffer: ArrayBuffer;
  mimeType: string;
  usage: UsageEntry[];
  // Halte den ObjectURL, damit der Aufrufer ihn nach dem Abspielen
  // wieder freigeben kann (URL.revokeObjectURL).
  revoke: () => void;
};

export async function speakText(
  text: string,
  voice?: string,
): Promise<SpeakResult> {
  const res = await fetch("/api/voice-speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  const json = await readJson(res);

  if (!res.ok) {
    const err: VoiceApiError = {
      status: res.status,
      message: extractErrorMessage(
        json,
        `Sprachausgabe fehlgeschlagen (HTTP ${res.status}).`,
      ),
    };
    throw err;
  }

  const obj = (json ?? {}) as {
    audio?: unknown;
    mimeType?: unknown;
    _usage?: unknown;
  };
  const audioB64 = typeof obj.audio === "string" ? obj.audio : "";
  const mimeType =
    typeof obj.mimeType === "string" && obj.mimeType.length > 0
      ? obj.mimeType
      : "audio/mpeg";
  if (!audioB64) {
    const err: VoiceApiError = {
      status: 502,
      message: "Leere Audioantwort erhalten.",
    };
    throw err;
  }

  const bytes = base64ToBytes(audioB64);
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const audioUrl = URL.createObjectURL(blob);
  const usage = Array.isArray(obj._usage) ? (obj._usage as UsageEntry[]) : [];

  // arrayBuffer entkoppelt vom Blob halten, damit decodeAudioData einen
  // eigenen, nicht-detachten Buffer bekommt (Safari detached sonst).
  const arrayBuffer = new ArrayBuffer(bytes.length);
  new Uint8Array(arrayBuffer).set(bytes);

  return {
    audioUrl,
    arrayBuffer,
    mimeType,
    usage,
    revoke: () => URL.revokeObjectURL(audioUrl),
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
