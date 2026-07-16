import type { Context } from "@netlify/functions";

// Netlify Functions v2: default export ist eine (Request, Context) => Response Funktion.
// Läuft sowohl in Produktion als auch mit `netlify dev` lokal.

type AnthropicMessage = {
  role: "user" | "assistant";
  content: unknown;
};

type ChatRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
  tools?: unknown[];
};

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return errorResponse(405, "Nur POST erlaubt.");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "ANTHROPIC_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: ChatRequestBody;
  try {
    payload = (await req.json()) as ChatRequestBody;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const { messages, systemPrompt, tools } = payload ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse(
      400,
      "Feld 'messages' fehlt oder ist keine nicht-leere Liste.",
    );
  }

  const anthropicBody: Record<string, unknown> = {
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_TOKENS,
    messages,
  };
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    anthropicBody.system = systemPrompt;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    anthropicBody.tools = tools;
  }

  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    console.error("Anthropic-Request fehlgeschlagen:", err);
    return errorResponse(502, "Anthropic-API nicht erreichbar.");
  }

  const rawText = await upstream.text();

  if (!upstream.ok) {
    // Anthropic-Antwort weitergeben, aber Struktur säubern (kein Stacktrace, keine Header-Leaks).
    let upstreamError: unknown = rawText;
    try {
      upstreamError = JSON.parse(rawText);
    } catch {
      // rawText bleibt als Fallback
    }
    console.error("Anthropic-API antwortete mit Fehler:", upstream.status, upstreamError);
    return jsonResponse(upstream.status, {
      error: "Anthropic-API antwortete mit einem Fehler.",
      status: upstream.status,
      details: upstreamError,
    });
  }

  try {
    const parsed = JSON.parse(rawText);
    return jsonResponse(200, parsed);
  } catch {
    console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
    return errorResponse(502, "Ungültige Antwort von der Anthropic-API.");
  }
};

// Optional: Netlify-Config für den Endpunkt-Pfad.
// Standardmäßig ist die Funktion unter /.netlify/functions/chat erreichbar.
// Der zusätzliche Pfad /api/chat macht das Aufrufen aus dem Frontend hübscher.
export const config = {
  path: ["/api/chat", "/.netlify/functions/chat"],
};
