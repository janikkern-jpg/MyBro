import type {
  StApiMessage,
  StChatResponse,
  StCreatedFile,
  StGeneratedImage,
  StImageResponse,
  StResponseTextBlock,
  StSource,
} from "./types";
import { supabase } from "../../supabase";

export type SmalltalkApiError = {
  status: number;
  message: string;
  details?: unknown;
};

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractError(json: unknown, status: number): string {
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error: unknown }).error === "string" &&
    (json as { error: string }).error.length > 0
  ) {
    return (json as { error: string }).error;
  }
  return `Anfrage fehlgeschlagen (HTTP ${status}).`;
}

async function authorizedHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (session?.access_token) {
    headers.authorization = `Bearer ${session.access_token}`;
  }
  return headers;
}

export async function callSmalltalkText(payload: {
  messages: StApiMessage[];
  systemPrompt: string;
  // Optional: URL des zuletzt in der Unterhaltung angehängten oder
  // erzeugten Bildes. Wenn gesetzt, aktiviert der Server das
  // `edit_image`-Tool; ohne diese URL wird das Tool gar nicht erst
  // angeboten (und Claude sagt in Textform, dass der Nutzer ein Bild
  // anhängen soll).
  latestImageUrl?: string | null;
}): Promise<StChatResponse> {
  // Access-Token mitschicken, damit der Server die client-seitigen Tools
  // (`create_file`, `generate_image`, `edit_image`) aktivieren kann – die
  // Uploads laufen über genau dieses Token, RLS erzwingt den eigenen
  // Unterordner.
  const headers = await authorizedHeaders();
  const body: Record<string, unknown> = {
    messages: payload.messages,
    systemPrompt: payload.systemPrompt,
  };
  if (payload.latestImageUrl) body.latestImageUrl = payload.latestImageUrl;
  const res = await fetch("/api/smalltalk", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    const err: SmalltalkApiError = {
      status: res.status,
      message: extractError(json, res.status),
      details: json,
    };
    throw err;
  }
  return json as StChatResponse;
}

/**
 * Zweite Phase der Bildgenerierung: der `/api/smalltalk`-Endpoint hat
 * `{status:"generating_image", imagePrompt}` geliefert, und wir stoßen
 * jetzt den eigentlichen OpenAI-Aufruf an. Der Server erledigt Aufruf,
 * Upload nach `chat-images` und liefert die public URL zurück.
 *
 * Fehler werden als `SmalltalkApiError` geworfen; `details` enthält im
 * Erfolgs- und im 403-Fall auch das `kind`-Feld (u. a. `unauthorized_org`
 * für den Org-Verification-Stolperstein), damit der Client zwischen
 * "kaputt" und "muss noch freigeschaltet werden" unterscheiden kann.
 */
export async function callGenerateImage(payload: {
  prompt: string;
  size?: string | null;
}): Promise<{ url: string; size: string; prompt: string; path: string }> {
  const headers = await authorizedHeaders();
  const body: Record<string, unknown> = { prompt: payload.prompt };
  if (payload.size) body.size = payload.size;
  const res = await fetch("/api/generate-image", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok || !isImageOkPayload(json)) {
    const err: SmalltalkApiError = {
      status: res.status,
      message: extractError(json, res.status),
      details: json,
    };
    throw err;
  }
  return {
    url: json.url,
    size: json.size,
    prompt: json.prompt,
    path: typeof json.path === "string" ? json.path : "",
  };
}

function isImageOkPayload(
  json: unknown,
): json is { url: string; size: string; prompt: string; path?: string } {
  if (!json || typeof json !== "object") return false;
  const rec = json as Record<string, unknown>;
  return (
    rec.ok === true &&
    typeof rec.url === "string" &&
    typeof rec.size === "string" &&
    typeof rec.prompt === "string"
  );
}

/**
 * Zweite Phase der Bild-Bearbeitung: `edit_image` (Referenzbild +
 * Text-Prompt). Ansonsten Verhalten identisch zu `callGenerateImage`.
 */
export async function callEditImage(payload: {
  prompt: string;
  sourceImageUrl: string;
}): Promise<{ url: string; prompt: string; sourceUrl: string; path: string }> {
  const headers = await authorizedHeaders();
  const res = await fetch("/api/edit-image", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt: payload.prompt,
      sourceImageUrl: payload.sourceImageUrl,
    }),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok || !isEditOkPayload(json)) {
    const err: SmalltalkApiError = {
      status: res.status,
      message: extractError(json, res.status),
      details: json,
    };
    throw err;
  }
  return {
    url: json.url,
    prompt: json.prompt,
    sourceUrl: json.sourceUrl,
    path: typeof json.path === "string" ? json.path : "",
  };
}

function isEditOkPayload(
  json: unknown,
): json is { url: string; prompt: string; sourceUrl: string; path?: string } {
  if (!json || typeof json !== "object") return false;
  const rec = json as Record<string, unknown>;
  return (
    rec.ok === true &&
    typeof rec.url === "string" &&
    typeof rec.prompt === "string" &&
    typeof rec.sourceUrl === "string"
  );
}

export async function callSmalltalkImage(payload: {
  prompt: string;
  size?: string;
}): Promise<StImageResponse> {
  const res = await fetch("/api/smalltalk-image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await parseJsonSafe(res);
  if (!res.ok) {
    const err: SmalltalkApiError = {
      status: res.status,
      message: extractError(json, res.status),
      details: json,
    };
    throw err;
  }
  return json as StImageResponse;
}

export function extractAssistantText(resp: StChatResponse): string {
  return (resp.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
}

/**
 * Extrahiert Quellen aus web_search-Zitationen der Anthropic-Response.
 * Dedupliziert nach URL (erste Nennung gewinnt) und filtert Einträge ohne
 * URL heraus. Reihenfolge bleibt stabil (Zitations-Reihenfolge des LLM).
 */
export function extractSources(resp: StChatResponse): StSource[] {
  const seen = new Set<string>();
  const out: StSource[] = [];
  for (const block of resp.content ?? []) {
    if (!block || block.type !== "text") continue;
    const citations = (block as StResponseTextBlock).citations;
    if (!Array.isArray(citations)) continue;
    for (const c of citations) {
      if (!c || c.type !== "web_search_result_location") continue;
      const url = (c.url ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const rawTitle = (c.title ?? "").trim();
      out.push({ title: rawTitle || url, url });
    }
  }
  return out;
}

// Serialisierungs-Marker für Quellen im gespeicherten Nachrichteninhalt.
// Absichtlich distinktiv gewählt (doppelte eckige Klammern + Präfix), damit
// natürlicher Nutzer-Text nicht kollidiert und der Marker leicht per Regex
// wieder rausparsebar ist.
const SOURCES_MARKER_PREFIX = "[[MYBRO_SOURCES:";
const SOURCES_MARKER_SUFFIX = "]]";
const SOURCES_MARKER_RE = /\n\n\[\[MYBRO_SOURCES:([\s\S]+?)\]\]\s*$/;

/**
 * Hängt Quellen als Marker-Block an den Assistant-Text an, damit sie
 * zusammen mit der Nachricht in st_messages.content persistieren. Beim
 * Rendern wird der Marker per parseAssistantContent wieder abgespalten.
 */
export function serializeAssistantContent(
  text: string,
  sources: readonly StSource[],
): string {
  if (sources.length === 0) return text;
  const json = JSON.stringify(sources);
  return `${text}\n\n${SOURCES_MARKER_PREFIX}${json}${SOURCES_MARKER_SUFFIX}`;
}

/**
 * Umkehrung zu serializeAssistantContent: trennt sichtbaren Text von
 * Quellenliste. Wenn kein Marker gefunden wird oder er ungültig ist,
 * wird der Original-Content unverändert zurückgegeben.
 */
export function parseAssistantContent(content: string): {
  text: string;
  sources: StSource[];
  files: StCreatedFile[];
} {
  // Reihenfolge: zuerst Files (sind am Ende hinzugefügt), dann Sources.
  // Beide Marker sind unabhängig, deshalb erst File-Marker abschneiden
  // und dann Source-Marker aus dem Restinhalt.
  let remaining = content;
  const files = parseFilesMarker(remaining);
  if (files.marker) remaining = files.text;
  const sourcesMatch = remaining.match(SOURCES_MARKER_RE);
  if (!sourcesMatch) {
    return { text: remaining, sources: [], files: files.files };
  }
  try {
    const parsed = JSON.parse(sourcesMatch[1]) as unknown;
    if (!Array.isArray(parsed)) {
      return { text: remaining, sources: [], files: files.files };
    }
    const sources: StSource[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      if (!url) continue;
      sources.push({ title: title || url, url });
    }
    return {
      text: remaining.slice(0, sourcesMatch.index).trimEnd(),
      sources,
      files: files.files,
    };
  } catch {
    return { text: remaining, sources: [], files: files.files };
  }
}

// --------------------- Datei-Marker (aus create_file-Tool) -----------------

// Zweiter Serialisierungs-Marker, gleiches Prinzip wie SOURCES_MARKER,
// nur für die vom Server erzeugten Downloads. Persistiert damit in
// st_messages.content und überlebt Refresh/Deep-Links.
const FILES_MARKER_PREFIX = "[[MYBRO_FILES:";
const FILES_MARKER_SUFFIX = "]]";
const FILES_MARKER_RE = /\n\n\[\[MYBRO_FILES:([\s\S]+?)\]\]\s*$/;

const ALLOWED_FILE_TYPES: readonly StCreatedFile["file_type"][] = [
  "csv",
  "txt",
  "pdf",
  "docx",
  "json",
];

/**
 * Extrahiert die vom Server erzeugten Datei-Metadaten (`_files`).
 * Dedupliziert nach URL (erste Nennung gewinnt).
 */
export function extractFiles(resp: StChatResponse): StCreatedFile[] {
  const raw = Array.isArray(resp._files) ? resp._files : [];
  const seen = new Set<string>();
  const out: StCreatedFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const url = typeof f.url === "string" ? f.url.trim() : "";
    const filename = typeof f.filename === "string" ? f.filename.trim() : "";
    const fileType = f.file_type as StCreatedFile["file_type"];
    const size = Number(f.size_bytes ?? 0);
    if (!url || !filename || !ALLOWED_FILE_TYPES.includes(fileType)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      filename,
      file_type: fileType,
      url,
      path: typeof f.path === "string" ? f.path : "",
      size_bytes: Number.isFinite(size) ? Math.max(0, size) : 0,
    });
  }
  return out;
}

/**
 * Extrahiert die vom Server erzeugten Bilder (`_images`). Analog zu
 * `extractFiles`. Dedupliziert nach URL.
 */
export function extractImages(resp: StChatResponse): StGeneratedImage[] {
  const raw = Array.isArray(resp._images) ? resp._images : [];
  const seen = new Set<string>();
  const out: StGeneratedImage[] = [];
  for (const im of raw) {
    if (!im || typeof im !== "object") continue;
    const url = typeof im.url === "string" ? im.url.trim() : "";
    const prompt = typeof im.prompt === "string" ? im.prompt : "";
    const size = typeof im.size === "string" ? im.size : "";
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      prompt,
      size,
      url,
      path: typeof im.path === "string" ? im.path : "",
    });
  }
  return out;
}

/**
 * Hängt eine Datei-Liste als Marker-Block an den Assistant-Text an –
 * spiegelbildlich zu `serializeAssistantContent`. Wenn keine Dateien
 * dabei sind, bleibt der Text unverändert.
 */
export function serializeFilesInto(
  text: string,
  files: readonly StCreatedFile[],
): string {
  if (files.length === 0) return text;
  const json = JSON.stringify(files);
  return `${text}\n\n${FILES_MARKER_PREFIX}${json}${FILES_MARKER_SUFFIX}`;
}

function parseFilesMarker(content: string): {
  marker: boolean;
  text: string;
  files: StCreatedFile[];
} {
  const match = content.match(FILES_MARKER_RE);
  if (!match) return { marker: false, text: content, files: [] };
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) {
      return { marker: false, text: content, files: [] };
    }
    const files: StCreatedFile[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      const filename =
        typeof rec.filename === "string" ? rec.filename.trim() : "";
      const fileType = rec.file_type as StCreatedFile["file_type"];
      const size = Number(rec.size_bytes ?? 0);
      if (!url || !filename || !ALLOWED_FILE_TYPES.includes(fileType)) continue;
      files.push({
        filename,
        file_type: fileType,
        url,
        path: typeof rec.path === "string" ? rec.path : "",
        size_bytes: Number.isFinite(size) ? Math.max(0, size) : 0,
      });
    }
    return {
      marker: true,
      text: content.slice(0, match.index).trimEnd(),
      files,
    };
  } catch {
    return { marker: false, text: content, files: [] };
  }
}
