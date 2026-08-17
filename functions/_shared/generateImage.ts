// Zentrale Bild-Erzeugung für das Smalltalk-Tool `generate_image`.
// Analog zu createFile.ts:
//  - OpenAI Images API (gpt-image-1) wird server-seitig aufgerufen,
//  - das Ergebnis wird in den bestehenden Bucket `chat-images` unter
//    `{user_id}/{uuid}.png` hochgeladen (RLS mit User-Token, kein
//    Service-Role-Secret nötig – gleiche Policy wie bei Foto-Uploads),
//  - die Public-URL wird per Tool-Result an Claude zurückgereicht.
//
// Fehlerbehandlung: 403 vom Images-Endpunkt hat in unserem Setup nur
// einen wahrscheinlichen Grund – die OpenAI-Organisation ist noch nicht
// verifiziert und darf gpt-image-1 nicht nutzen. In diesem Fall geben
// wir einen sehr expliziten, für den End-User verständlichen String an
// Claude weiter, damit er ihn 1:1 im Chat wiedergibt.

import { usageFromOpenAIImageJson, type UsageRecord } from "./pricing";

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_MODEL = "gpt-image-1";
const CHAT_IMAGES_BUCKET = "chat-images";

const ALLOWED_SIZES = new Set<string>([
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
]);
const DEFAULT_SIZE = "1024x1024";

// Klartext für den 403-Fall – identisch mit dem, was der Nutzer zu
// sehen kriegen soll. Wir reichen ihn als tool_result-content an Claude,
// der ihn im Antworttext wörtlich zitieren soll (siehe System-Prompt).
export const OPENAI_IMAGE_UNVERIFIED_MSG =
  "Bildgenerierung noch nicht freigeschaltet – Organization Verification auf platform.openai.com nötig.";

export type GeneratedImage = {
  prompt: string;
  size: string;
  url: string;
  path: string;
};

export type GenerateImageEnv = {
  userId: string;
  accessToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  openAIKey: string;
};

export type GenerateImageOutcome =
  | { ok: true; image: GeneratedImage; usage: UsageRecord | null }
  | {
      ok: false;
      kind:
        | "input_error"
        | "unauthorized_org"
        | "openai_error"
        | "upload_error"
        | "network_error";
      message: string;
      status?: number;
    };

function randomHex(len = 16): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(input: string): Uint8Array {
  // atob liefert einen String aus 8-Bit-Zeichen; wir mappen ihn manuell
  // in ein Uint8Array. Läuft sowohl in Node (Netlify Functions) als auch
  // in Cloudflare Workers – beide bieten `atob` als globalen Standard an.
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function uploadPngToChatImages(opts: {
  supabaseUrl: string;
  supabaseAnonKey: string;
  accessToken: string;
  path: string;
  body: Uint8Array;
}): Promise<void> {
  const uploadUrl = `${opts.supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/${CHAT_IMAGES_BUCKET}/${opts.path}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      apikey: opts.supabaseAnonKey,
      authorization: `Bearer ${opts.accessToken}`,
      "cache-control": "31536000",
      "x-upsert": "false",
    },
    body: opts.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Supabase-Storage-Upload (chat-images) fehlgeschlagen (${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

function publicUrlFor(supabaseUrl: string, path: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${CHAT_IMAGES_BUCKET}/${path}`;
}

/**
 * Validiert die Tool-Argumente, ruft OpenAI Images an und lädt das
 * PNG-Ergebnis in `chat-images/{user_id}/{uuid}.png`. Gibt bei Erfolg
 * ein `GeneratedImage` inkl. Public-URL zurück, bei Fehlern eine
 * strukturierte Fehler-Beschreibung (für das tool_result an Claude).
 */
export async function generateImageFromToolInput(
  args: unknown,
  env: GenerateImageEnv,
): Promise<GenerateImageOutcome> {
  if (!args || typeof args !== "object") {
    return {
      ok: false,
      kind: "input_error",
      message: "Fehlende Tool-Argumente.",
    };
  }
  const record = args as Record<string, unknown>;
  const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
  if (!prompt) {
    return {
      ok: false,
      kind: "input_error",
      message: "Feld 'prompt' fehlt oder ist leer.",
    };
  }
  if (prompt.length > 4000) {
    return {
      ok: false,
      kind: "input_error",
      message: "Prompt ist zu lang (max 4000 Zeichen).",
    };
  }

  const rawSize = typeof record.size === "string" ? record.size.trim() : "";
  const size =
    rawSize && ALLOWED_SIZES.has(rawSize) ? rawSize : DEFAULT_SIZE;

  // ---- OpenAI-Call --------------------------------------------------
  let openaiRes: Response;
  try {
    openaiRes = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.openAIKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        size,
        n: 1,
        // `quality: "low"` kürzt die Generierungszeit auf ~5–12 s
        // statt 20–40 s, damit die Antwort ins 26-s-Sync-Fenster
        // von Netlify Functions passt. Die Qualität reicht für die
        // Chat-Vorschau in aller Regel absolut aus.
        quality: "low",
      }),
    });
  } catch (err) {
    console.error("[generate_image] Netzwerkfehler an OpenAI:", err);
    return {
      ok: false,
      kind: "network_error",
      message: "OpenAI-Image-Endpoint nicht erreichbar.",
    };
  }

  const rawText = await openaiRes.text();
  if (!openaiRes.ok) {
    // 403 → Org nicht verifiziert (bekannter Stolperstein bei gpt-image-1).
    if (openaiRes.status === 403) {
      console.warn(
        "[generate_image] OpenAI 403 – Org-Verification fehlt:",
        rawText.slice(0, 300),
      );
      return {
        ok: false,
        kind: "unauthorized_org",
        status: 403,
        message: OPENAI_IMAGE_UNVERIFIED_MSG,
      };
    }
    console.error(
      "[generate_image] OpenAI-Fehler",
      openaiRes.status,
      rawText.slice(0, 300),
    );
    return {
      ok: false,
      kind: "openai_error",
      status: openaiRes.status,
      message: `OpenAI-Bildgenerierung fehlgeschlagen (HTTP ${openaiRes.status}).`,
    };
  }

  let parsed: {
    data?: Array<{ b64_json?: unknown; url?: unknown }>;
    usage?: unknown;
    model?: unknown;
  };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      kind: "openai_error",
      status: 502,
      message: "OpenAI hat eine ungültige JSON-Antwort geliefert.",
    };
  }

  const entry = parsed.data?.[0];
  const b64 = typeof entry?.b64_json === "string" ? entry.b64_json : "";
  if (!b64) {
    return {
      ok: false,
      kind: "openai_error",
      status: 502,
      message: "Keine Bilddaten in der OpenAI-Antwort.",
    };
  }

  const pngBytes = decodeBase64(b64);

  // ---- Upload nach Supabase Storage ---------------------------------
  const uuid = randomHex(16);
  const path = `${env.userId}/${uuid}.png`;
  try {
    await uploadPngToChatImages({
      supabaseUrl: env.supabaseUrl,
      supabaseAnonKey: env.supabaseAnonKey,
      accessToken: env.accessToken,
      path,
      body: pngBytes,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: "upload_error",
      message: `Bild konnte nicht gespeichert werden: ${message}`,
    };
  }

  const url = publicUrlFor(env.supabaseUrl, path);
  const usage = usageFromOpenAIImageJson(parsed, OPENAI_IMAGE_MODEL);
  return {
    ok: true,
    image: { prompt, size, url, path },
    usage,
  };
}

// Anthropic-Tool-Definition. Bewusst neben der Implementierung – Schema
// und Server-Logik sollen sich nicht auseinander entwickeln.
export const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description:
    "Erzeugt ein Bild aus einer ausformulierten Beschreibung und zeigt es dem Nutzer direkt im Chat an. " +
    "Nutze dieses Tool, wenn erkennbar ist, dass der Nutzer ein Bild/eine Zeichnung/eine Illustration/ein Foto-artiges Ergebnis erstellt haben möchte, " +
    "und frag NICHT vorher, ob ein Bild gewünscht ist, wenn das aus dem Kontext schon klar ist. " +
    "Formuliere den prompt möglichst detailliert (Motiv, Stil, Perspektive, Stimmung, Farben, Beleuchtung), aber knapp genug für eine Bildgenerierung. " +
    "Nach erfolgreichem Aufruf wird das Bild automatisch unter der Nachricht angezeigt – du musst die URL NICHT nochmal im Text nennen.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description:
          "Ausformulierter, detaillierter Bildprompt in einer der Chat-Sprachen. Beschreibe Motiv, Stil, Stimmung und ggf. Perspektive.",
      },
      size: {
        type: "string",
        enum: ["1024x1024", "1024x1536", "1536x1024", "auto"],
        description:
          "Optionales Zielformat. 1024x1024 (quadratisch), 1024x1536 (Hochformat), 1536x1024 (Querformat) oder 'auto'. Standard ist 1024x1024.",
      },
    },
    required: ["prompt"],
  },
} as const;
