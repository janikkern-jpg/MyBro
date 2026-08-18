import {
  TTS_DEFAULT_VOICE,
  TTS_MODEL,
  usageForTts,
  type UsageRecord,
} from "../_shared/pricing";
import type { PagesHandler } from "../_shared/pages";

// Sprachmodus – Text-to-Speech.
// Ruft OpenAI /v1/audio/speech mit gpt-4o-mini-tts + "onyx" auf und
// gibt das Audio Base64-kodiert zusammen mit den Usage-Records zurück,
// damit der Client sowohl abspielen als auch loggen kann.

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

// Whitelist der von uns unterstützten OpenAI-TTS-Stimmen. "onyx" ist
// die tiefe, ruhige Stimme, die dem gewünschten Charakter am nächsten
// kommt – ohne die Marke einer bestimmten Filmfigur zu imitieren.
const ALLOWED_VOICES = new Set<string>([
  "onyx",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "sage",
  "shimmer",
  "verse",
]);

const MAX_INPUT_CHARS = 4096;

type SpeakRequest = {
  text?: unknown;
  voice?: unknown;
};

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

function toBase64(bytes: Uint8Array): string {
  // Cloudflare Workers unterstützen `btoa`. Für große Buffer in Chunks
  // umwandeln, damit wir nicht in den Argument-Limit von
  // String.fromCharCode(...) laufen.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return btoa(binary);
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "OPENAI_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: SpeakRequest;
  try {
    payload = (await request.json()) as SpeakRequest;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) {
    return errorResponse(400, "Feld 'text' fehlt oder ist leer.");
  }
  if (text.length > MAX_INPUT_CHARS) {
    return errorResponse(
      400,
      `Text zu lang (max. ${MAX_INPUT_CHARS} Zeichen für einen TTS-Aufruf).`,
    );
  }

  const requestedVoice =
    typeof payload?.voice === "string" ? payload.voice.trim() : "";
  const voice =
    requestedVoice && ALLOWED_VOICES.has(requestedVoice)
      ? requestedVoice
      : TTS_DEFAULT_VOICE;

  let openaiResponse: Response;
  try {
    openaiResponse = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice,
        input: text,
        format: "mp3",
      }),
    });
  } catch (err) {
    console.error("[voice-speak] Netzwerkfehler:", err);
    return errorResponse(502, "OpenAI-TTS nicht erreichbar.");
  }

  if (!openaiResponse.ok) {
    const bodyText = await openaiResponse.text();
    console.error(
      "[voice-speak] OpenAI-Fehler",
      openaiResponse.status,
      bodyText,
    );
    let message = `OpenAI-TTS fehlgeschlagen (HTTP ${openaiResponse.status}).`;
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: string };
      };
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      // ignore
    }
    return errorResponse(openaiResponse.status, message);
  }

  const buffer = new Uint8Array(await openaiResponse.arrayBuffer());
  if (buffer.byteLength === 0) {
    return errorResponse(502, "Leere Audioantwort von OpenAI.");
  }

  const usage: UsageRecord[] = [];
  const record = usageForTts(text);
  if (record) usage.push(record);

  return jsonResponse(200, {
    audio: toBase64(buffer),
    mimeType: "audio/mpeg",
    voice,
    _usage: usage,
  });
};
