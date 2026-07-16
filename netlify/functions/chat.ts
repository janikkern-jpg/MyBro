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
// Primär- und Fallback-Modell: bei 529/overloaded wird auf das nächste Modell umgeschaltet,
// damit der User nicht wegen kurzzeitiger Anthropic-Auslastung im Regen steht.
const ANTHROPIC_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"] as const;
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

// Retry-Konfiguration für Anthropic-Aufrufe.
// 529 = overloaded, 429 = rate-limited, 5xx = Server-Fehler bei Anthropic.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS_PER_MODEL = 2; // pro Modell 1 Versuch + 1 Retry
const BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

type FetchOutcome =
  | { kind: "response"; response: Response; rawText: string }
  | { kind: "network-error"; error: unknown };

async function callAnthropicModel(
  body: Record<string, unknown>,
  apiKey: string,
  model: string,
): Promise<FetchOutcome> {
  let lastOutcome: FetchOutcome | null = null;
  const payload = { ...body, model };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
    try {
      const response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
      });
      const rawText = await response.text();

      if (response.ok || !RETRY_STATUS.has(response.status)) {
        return { kind: "response", response, rawText };
      }

      lastOutcome = { kind: "response", response, rawText };
      console.warn(
        `Anthropic ${response.status} für Modell ${model} (Versuch ${attempt}/${MAX_ATTEMPTS_PER_MODEL}).`,
      );

      if (attempt === MAX_ATTEMPTS_PER_MODEL) break;
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(retryAfter ?? backoff + jitter);
    } catch (err) {
      lastOutcome = { kind: "network-error", error: err };
      console.warn(
        `Anthropic-Netzwerkfehler für Modell ${model} (Versuch ${attempt}/${MAX_ATTEMPTS_PER_MODEL}):`,
        err,
      );
      if (attempt === MAX_ATTEMPTS_PER_MODEL) break;
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 250);
      await sleep(backoff + jitter);
    }
  }

  return lastOutcome ?? { kind: "network-error", error: new Error("Unknown") };
}

async function callAnthropicWithFallback(
  body: Record<string, unknown>,
  apiKey: string,
): Promise<FetchOutcome> {
  let lastOutcome: FetchOutcome = { kind: "network-error", error: new Error("no attempt") };

  for (const model of ANTHROPIC_MODELS) {
    const outcome = await callAnthropicModel(body, apiKey, model);
    lastOutcome = outcome;

    // Erfolg → sofort zurück.
    if (outcome.kind === "response" && outcome.response.ok) return outcome;

    // Bei 529/overloaded auf das nächste Modell fallen.
    if (outcome.kind === "response" && outcome.response.status === 529) {
      console.warn(`Modell ${model} überlastet – wechsle auf nächstes Modell.`);
      continue;
    }

    // Bei anderen Fehlern (400, 401, 404 …) NICHT das Modell wechseln – Ursache liegt woanders.
    return outcome;
  }

  return lastOutcome;
}

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
    max_tokens: MAX_TOKENS,
    messages,
  };
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    anthropicBody.system = systemPrompt;
  }
  if (Array.isArray(tools) && tools.length > 0) {
    anthropicBody.tools = tools;
  }

  const outcome = await callAnthropicWithFallback(anthropicBody, apiKey);

  if (outcome.kind === "network-error") {
    console.error("Anthropic-Request endgültig fehlgeschlagen:", outcome.error);
    return errorResponse(502, "Anthropic-API nicht erreichbar.");
  }

  const upstream = outcome.response;
  const rawText = outcome.rawText;

  if (!upstream.ok) {
    // Anthropic-Antwort weitergeben, aber Struktur säubern (kein Stacktrace, keine Header-Leaks).
    let upstreamError: unknown = rawText;
    try {
      upstreamError = JSON.parse(rawText);
    } catch {
      // rawText bleibt als Fallback
    }
    console.error("Anthropic-API antwortete mit Fehler:", upstream.status, upstreamError);
    const clientMessage =
      upstream.status === 529
        ? "Anthropic ist gerade stark ausgelastet. Bitte in ein paar Minuten erneut versuchen."
        : "Anthropic-API antwortete mit einem Fehler.";
    return jsonResponse(upstream.status, {
      error: clientMessage,
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
