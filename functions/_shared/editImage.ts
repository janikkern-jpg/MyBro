// Bild-Bearbeitung analog zu generateImage.ts: gpt-image-1 an
// `/v1/images/edits` mit einem bereits vorhandenen Referenzbild (aus
// dem `chat-images`-Bucket bzw. aus einem Upload) + Text-Prompt für die
// gewünschte Änderung. Ergebnis wird wieder als PNG in `chat-images`
// unter `{userId}/{uuid}.png` abgelegt.
//
// Trennung zu generateImage.ts:
//  - `generate_image` startet bei leerer Leinwand (Text-only prompt).
//  - `edit_image` verändert ein bestehendes Bild – Referenz löst der
//    Client (er kennt den Message-Stream) auf und schickt die public
//    URL im 2. Request an /api/edit-image.

import { usageFromOpenAIImageJson, type UsageRecord } from "./pricing";

const OPENAI_IMAGE_EDIT_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_IMAGE_MODEL = "gpt-image-1";
const CHAT_IMAGES_BUCKET = "chat-images";

// Fehlermeldung 1:1 wiederverwenden – User-Sicht ist identisch
// („OpenAI-Org ist nicht verifiziert"), egal ob generate oder edit.
export const OPENAI_IMAGE_UNVERIFIED_MSG =
  "Bildbearbeitung noch nicht freigeschaltet – Organization Verification auf platform.openai.com nötig.";

export type EditedImage = {
  prompt: string;
  sourceUrl: string;
  url: string;
  path: string;
};

export type EditImageEnv = {
  userId: string;
  accessToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  openAIKey: string;
};

export type EditImageOutcome =
  | { ok: true; image: EditedImage; usage: UsageRecord | null }
  | {
      ok: false;
      kind:
        | "input_error"
        | "source_fetch_error"
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
 * Sicherheits-Check für die Referenz-URL: Wir akzeptieren nur URLs, die
 * auf den chat-images-Bucket derselben Supabase-Instanz zeigen oder
 * (für frisch angehängte User-Uploads) auf den chat-files-Bucket. So
 * kann das Tool nicht dazu missbraucht werden, beliebige öffentliche
 * URLs zu proxen/exfiltrieren.
 */
function isAllowedSourceUrl(sourceUrl: string, supabaseUrl: string): boolean {
  try {
    const src = new URL(sourceUrl);
    const base = new URL(supabaseUrl);
    if (src.host !== base.host) return false;
    return (
      src.pathname.includes(`/storage/v1/object/public/${CHAT_IMAGES_BUCKET}/`) ||
      src.pathname.includes(`/storage/v1/object/public/chat-files/`)
    );
  } catch {
    return false;
  }
}

/**
 * Lädt das Referenzbild und ruft `/v1/images/edits` auf. Anders als
 * generate_image kennt das Tool keine `size`-Angabe – die Ergebnisgröße
 * richtet sich nach der Quelle (Default von OpenAI).
 */
export async function editImageFromInput(
  args: { prompt: string; sourceImageUrl: string },
  env: EditImageEnv,
): Promise<EditImageOutcome> {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const sourceImageUrl =
    typeof args.sourceImageUrl === "string" ? args.sourceImageUrl.trim() : "";

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
  if (!sourceImageUrl) {
    return {
      ok: false,
      kind: "input_error",
      message: "Kein Referenzbild angegeben.",
    };
  }
  if (!isAllowedSourceUrl(sourceImageUrl, env.supabaseUrl)) {
    return {
      ok: false,
      kind: "input_error",
      message:
        "Referenzbild-URL ist nicht erlaubt (nur eigene Supabase-Buckets).",
    };
  }

  // ---- Referenzbild laden ------------------------------------------
  let sourceBytes: Uint8Array;
  let sourceContentType = "image/png";
  try {
    const srcRes = await fetch(sourceImageUrl);
    if (!srcRes.ok) {
      return {
        ok: false,
        kind: "source_fetch_error",
        status: srcRes.status,
        message: `Referenzbild konnte nicht geladen werden (HTTP ${srcRes.status}).`,
      };
    }
    const ct = srcRes.headers.get("content-type") || "";
    if (ct.startsWith("image/")) {
      sourceContentType = ct.split(";")[0].trim();
    }
    const buf = await srcRes.arrayBuffer();
    sourceBytes = new Uint8Array(buf);
  } catch (err) {
    console.error("[edit_image] Referenzbild-Fetch fehlgeschlagen:", err);
    return {
      ok: false,
      kind: "source_fetch_error",
      message: "Referenzbild konnte nicht geladen werden.",
    };
  }

  // ---- OpenAI-Call --------------------------------------------------
  let openaiRes: Response;
  try {
    const form = new FormData();
    form.append("model", OPENAI_IMAGE_MODEL);
    form.append("prompt", prompt);
    form.append("n", "1");
    // `quality: "low"` – analog zu generate_image, um im Sync-Timeout
    // von Netlify Functions (26 s) sicher zu bleiben.
    form.append("quality", "low");
    // Dateiendung passend zum Content-Type wählen (OpenAI akzeptiert
    // png/jpg/webp bei gpt-image-1).
    const ext = sourceContentType.split("/")[1] || "png";
    const filename = `source.${ext}`;
    const blob = new Blob([sourceBytes], { type: sourceContentType });
    form.append("image", blob, filename);

    openaiRes = await fetch(OPENAI_IMAGE_EDIT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.openAIKey}`,
      },
      body: form,
    });
  } catch (err) {
    console.error("[edit_image] Netzwerkfehler an OpenAI:", err);
    return {
      ok: false,
      kind: "network_error",
      message: "OpenAI-Image-Edit-Endpoint nicht erreichbar.",
    };
  }

  const rawText = await openaiRes.text();
  if (!openaiRes.ok) {
    if (openaiRes.status === 403) {
      console.warn(
        "[edit_image] OpenAI 403 – Org-Verification fehlt:",
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
      "[edit_image] OpenAI-Fehler",
      openaiRes.status,
      rawText.slice(0, 300),
    );
    return {
      ok: false,
      kind: "openai_error",
      status: openaiRes.status,
      message: `OpenAI-Bildbearbeitung fehlgeschlagen (HTTP ${openaiRes.status}).`,
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
    image: { prompt, sourceUrl: sourceImageUrl, url, path },
    usage,
  };
}

// Anthropic-Tool-Definition. Bewusst mit NUR einem `prompt`-Feld:
// das Referenzbild wird server-seitig aus dem letzten Bild in der
// Unterhaltung aufgelöst und ist für Claude nicht wählbar.
export const EDIT_IMAGE_TOOL = {
  name: "edit_image",
  description:
    "Verändert das zuletzt angehängte oder erzeugte Bild in dieser Unterhaltung anhand einer Text-Beschreibung " +
    "(z. B. 'füg eine Kaffeetasse hinzu', 'ändere den Himmel zu Sonnenuntergang', 'mach den Hintergrund unscharf'). " +
    "Nutze dieses Tool NUR, wenn der Nutzer erkennbar ein bestehendes Bild verändern möchte. " +
    "Für komplett neue, eigenständige Bilder ohne Bezug zu einem vorhandenen: `generate_image`. " +
    "Das zu bearbeitende Referenzbild wird automatisch ausgewählt (letztes Bild in der Unterhaltung) und muss NICHT angegeben werden. " +
    "Falls in der Unterhaltung noch kein Bild existiert, ist dieses Tool nicht verfügbar – dann bitte den Nutzer stattdessen mit einer normalen Chat-Nachricht, ein Bild anzuhängen.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description:
          "Kurze, klare Beschreibung der gewünschten Änderung in einer der Chat-Sprachen. Nur die Veränderung, keine kompletten Neu-Beschreibungen.",
      },
    },
    required: ["prompt"],
  },
} as const;
