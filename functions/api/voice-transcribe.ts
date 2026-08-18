import {
  WHISPER_MODEL,
  usageForWhisper,
  type UsageRecord,
} from "../_shared/pricing";
import type { PagesHandler } from "../_shared/pages";

// Sprachmodus – Whisper-Transkription.
// Nimmt multipart/form-data mit dem Feld `audio` entgegen, leitet an
// OpenAI /v1/audio/transcriptions weiter und liefert `{ text, _usage }`.
// Die Audiodauer für die Kostenschätzung kommt aus dem optionalen Feld
// `duration_ms` (der MediaRecorder-Wrapper im Frontend misst das über
// audio.duration bzw. AudioContext).

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "OPENAI_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(
      400,
      "Ungültiger Request: multipart/form-data mit Feld 'audio' erwartet.",
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof Blob)) {
    return errorResponse(400, "Feld 'audio' fehlt oder ist keine Blob-Datei.");
  }
  if (audio.size === 0) {
    return errorResponse(400, "Audiodatei ist leer.");
  }

  const durationRaw = form.get("duration_ms");
  const durationMs =
    typeof durationRaw === "string" ? Number(durationRaw) : NaN;
  const durationSeconds =
    Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0;

  const languageRaw = form.get("language");
  const language =
    typeof languageRaw === "string" && languageRaw.trim().length > 0
      ? languageRaw.trim()
      : "de";

  // Whisper akzeptiert die üblichen Container – wir übernehmen den vom
  // MediaRecorder gelieferten MIME-Type. Der Dateiname wird nur für die
  // Extension-Erkennung von Whisper benötigt.
  const mimeType = audio.type || "audio/webm";
  const filename = filenameForMime(mimeType);

  const outboundForm = new FormData();
  outboundForm.append("model", WHISPER_MODEL);
  outboundForm.append("response_format", "json");
  outboundForm.append("language", language);
  outboundForm.append("file", audio, filename);

  let openaiResponse: Response;
  try {
    openaiResponse = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: outboundForm,
    });
  } catch (err) {
    console.error("[voice-transcribe] Netzwerkfehler:", err);
    return errorResponse(502, "OpenAI-Transkription nicht erreichbar.");
  }

  const rawText = await openaiResponse.text();

  if (!openaiResponse.ok) {
    console.error(
      "[voice-transcribe] OpenAI-Fehler",
      openaiResponse.status,
      rawText,
    );
    let message = `OpenAI-Transkription fehlgeschlagen (HTTP ${openaiResponse.status}).`;
    try {
      const parsed = JSON.parse(rawText) as {
        error?: { message?: string };
      };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // ignore
    }
    return errorResponse(openaiResponse.status, message);
  }

  let parsed: { text?: string } | null = null;
  try {
    parsed = rawText ? (JSON.parse(rawText) as { text?: string }) : null;
  } catch {
    return errorResponse(502, "Ungültige Antwort von OpenAI-Transkription.");
  }

  const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
  if (!text) {
    return errorResponse(422, "Keine Sprache erkannt.");
  }

  const usage: UsageRecord[] = [];
  const record = usageForWhisper(durationSeconds);
  if (record) usage.push(record);

  return jsonResponse(200, { text, _usage: usage });
};

function filenameForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("mp4") || m.includes("m4a")) return "audio.mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio.mp3";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("ogg")) return "audio.ogg";
  return "audio.webm";
}
