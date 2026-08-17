import type {
  StApiMessage,
  StChatResponse,
  StImageResponse,
  StResponseTextBlock,
  StSource,
} from "./types";

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

export async function callSmalltalkText(payload: {
  messages: StApiMessage[];
  systemPrompt: string;
}): Promise<StChatResponse> {
  const res = await fetch("/api/smalltalk", {
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
  return json as StChatResponse;
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
} {
  const match = content.match(SOURCES_MARKER_RE);
  if (!match) return { text: content, sources: [] };
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) return { text: content, sources: [] };
    const sources: StSource[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const url = typeof rec.url === "string" ? rec.url.trim() : "";
      const title = typeof rec.title === "string" ? rec.title.trim() : "";
      if (!url) continue;
      sources.push({ title: title || url, url });
    }
    return { text: content.slice(0, match.index).trimEnd(), sources };
  } catch {
    return { text: content, sources: [] };
  }
}
