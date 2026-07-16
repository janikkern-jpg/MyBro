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

// ---------------------------------------------------------------------------
// OpenAI-Fallback: springt nur an, wenn Anthropic dauerhaft mit 5xx/network
// scheitert. Format wird transparent auf Anthropic-Shape zurückübersetzt,
// damit das Frontend keinen Unterschied merkt.
// ---------------------------------------------------------------------------

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5.4";

type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type OpenAIResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
};

function toOpenAIMessages(
  systemPrompt: string | undefined,
  messages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemPrompt && systemPrompt.length > 0) {
    out.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content;

    // Kurzform: content ist ein String → 1:1 übernehmen.
    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      out.push({ role, content: JSON.stringify(content) });
      continue;
    }

    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "tool_use") {
          toolCalls.push({
            id: String(b.id ?? ""),
            type: "function",
            function: {
              name: String(b.name ?? ""),
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
      }

      const assistantMsg: Record<string, unknown> = {
        role: "assistant",
        content: textParts.join("") || null,
      };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
    } else {
      // role === "user": tool_result-Blöcke müssen zu eigenen role="tool"-Messages werden,
      // Textblöcke bleiben eine user-Message.
      const textParts: string[] = [];
      const toolResultMsgs: Array<Record<string, unknown>> = [];

      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textParts.push(b.text);
        } else if (b.type === "tool_result") {
          const c = b.content;
          const contentStr = typeof c === "string" ? c : JSON.stringify(c);
          toolResultMsgs.push({
            role: "tool",
            tool_call_id: String(b.tool_use_id ?? ""),
            content: contentStr,
          });
        }
      }

      for (const trm of toolResultMsgs) out.push(trm);
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("") });
      }
    }
  }

  return out;
}

function toOpenAITools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const converted: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const tt = t as Record<string, unknown>;
    const name = typeof tt.name === "string" ? tt.name : undefined;
    if (!name) continue;
    converted.push({
      type: "function",
      function: {
        name,
        description: typeof tt.description === "string" ? tt.description : "",
        parameters: tt.input_schema ?? { type: "object", properties: {} },
      },
    });
  }
  return converted.length > 0 ? converted : undefined;
}

function mapOpenAIFinishReasonToAnthropic(reason: string | undefined): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

function openAIToAnthropicResponse(resp: OpenAIResponse): Record<string, unknown> {
  const choice = resp.choices?.[0];
  const message = choice?.message;
  const content: Array<Record<string, unknown>> = [];

  if (message && typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }

  if (message?.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc || tc.type !== "function" || !tc.function) continue;
      let input: unknown = {};
      const rawArgs = tc.function.arguments;
      if (typeof rawArgs === "string" && rawArgs.length > 0) {
        try {
          input = JSON.parse(rawArgs);
        } catch {
          input = { _raw: rawArgs };
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        name: tc.function.name ?? "",
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return {
    id: resp.id ?? `msg_openai_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? OPENAI_MODEL,
    stop_reason: mapOpenAIFinishReasonToAnthropic(choice?.finish_reason),
    stop_sequence: null,
    content,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

type OpenAIOutcome =
  | { kind: "success"; anthropicShaped: Record<string, unknown> }
  | { kind: "error"; status: number; details: unknown }
  | { kind: "network-error"; error: unknown };

async function callOpenAI(
  systemPrompt: string | undefined,
  messages: AnthropicMessage[],
  tools: unknown[] | undefined,
  apiKey: string,
): Promise<OpenAIOutcome> {
  const openAIBody: Record<string, unknown> = {
    model: OPENAI_MODEL,
    messages: toOpenAIMessages(systemPrompt, messages),
    max_completion_tokens: MAX_TOKENS,
  };
  const openAITools = toOpenAITools(tools);
  if (openAITools) openAIBody.tools = openAITools;

  let response: Response;
  try {
    response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(openAIBody),
    });
  } catch (err) {
    return { kind: "network-error", error: err };
  }

  const rawText = await response.text();
  if (!response.ok) {
    let details: unknown = rawText;
    try {
      details = JSON.parse(rawText);
    } catch {
      // rawText bleibt Fallback
    }
    return { kind: "error", status: response.status, details };
  }

  try {
    const parsed = JSON.parse(rawText) as OpenAIResponse;
    return { kind: "success", anthropicShaped: openAIToAnthropicResponse(parsed) };
  } catch {
    return { kind: "error", status: 502, details: "invalid_json_from_openai" };
  }
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

  // ------------------------------------------------------------------------
  // Anthropic hat geantwortet und war OK → direkt zurückgeben.
  // ------------------------------------------------------------------------
  if (outcome.kind === "response" && outcome.response.ok) {
    try {
      const parsed = JSON.parse(outcome.rawText);
      console.log("[provider=claude] Antwort erfolgreich.");
      return jsonResponse(200, parsed);
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
      // Fällt unten in den OpenAI-Fallback.
    }
  }

  // ------------------------------------------------------------------------
  // Anthropic hat "unrettbar" gescheitert (Netzwerkfehler ODER 5xx). Wenn ein
  // OPENAI_API_KEY konfiguriert ist, versuchen wir OpenAI als Fallback.
  // Bei 4xx-Fehlern (400/401/404 …) NICHT umschalten – da liegt ein Bug oder
  // Auth-Problem vor, das auch OpenAI nicht löst.
  // ------------------------------------------------------------------------
  const anthropicStatus =
    outcome.kind === "response" ? outcome.response.status : 0;
  const anthropicUnrecoverable =
    outcome.kind === "network-error" ||
    (outcome.kind === "response" && anthropicStatus >= 500);

  if (anthropicUnrecoverable) {
    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey) {
      console.warn(
        `Anthropic endgültig fehlgeschlagen (${
          outcome.kind === "network-error" ? "network" : anthropicStatus
        }) – aktiviere OpenAI-Fallback.`,
      );
      const openAIOutcome = await callOpenAI(
        systemPrompt,
        messages,
        tools,
        openAIKey,
      );

      if (openAIOutcome.kind === "success") {
        console.log("[provider=openai-fallback] Antwort erfolgreich.");
        return jsonResponse(200, openAIOutcome.anthropicShaped);
      }

      if (openAIOutcome.kind === "error") {
        console.error(
          "OpenAI-Fallback fehlgeschlagen:",
          openAIOutcome.status,
          openAIOutcome.details,
        );
      } else {
        console.error("OpenAI-Fallback-Netzwerkfehler:", openAIOutcome.error);
      }
      // Falls OpenAI ebenfalls scheitert: unten die ursprüngliche
      // Anthropic-Fehlermeldung an das Frontend geben.
    } else {
      console.warn(
        "OPENAI_API_KEY nicht gesetzt – kein Cross-Provider-Fallback möglich.",
      );
    }
  }

  // ------------------------------------------------------------------------
  // Ab hier: Anthropic-Fehler an das Frontend weiterreichen (Original-Verhalten).
  // ------------------------------------------------------------------------
  if (outcome.kind === "network-error") {
    console.error("Anthropic-Request endgültig fehlgeschlagen:", outcome.error);
    return errorResponse(502, "Anthropic-API nicht erreichbar.");
  }

  const upstream = outcome.response;
  const rawText = outcome.rawText;

  if (!upstream.ok) {
    let upstreamError: unknown = rawText;
    try {
      upstreamError = JSON.parse(rawText);
    } catch {
      // rawText bleibt Fallback
    }
    console.error(
      "Anthropic-API antwortete mit Fehler:",
      upstream.status,
      upstreamError,
    );
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

  // Sollte nach oben nicht mehr erreicht werden – Safety-Fallback.
  console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
  return errorResponse(502, "Ungültige Antwort von der Anthropic-API.");
};

// Optional: Netlify-Config für den Endpunkt-Pfad.
// Standardmäßig ist die Funktion unter /.netlify/functions/chat erreichbar.
// Der zusätzliche Pfad /api/chat macht das Aufrufen aus dem Frontend hübscher.
export const config = {
  path: ["/api/chat", "/.netlify/functions/chat"],
};
