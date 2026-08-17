import type { Context } from "@netlify/functions";
import {
  callAnthropicWithFallback,
  isAnthropicUnrecoverable,
  type AnthropicMessage,
} from "./_shared/anthropic";
import { callOpenAIText } from "./_shared/openaiText";
import { selectModelForMessages } from "./_shared/modelRouting";
import { usageFromAnthropicJson, type UsageRecord } from "./_shared/pricing";

// MyBro-Chat-Endpoint. Proxy für Anthropic mit
// - gemeinsamem Modell-Routing (haiku/sonnet/opus je nach Komplexität,
//   siehe _shared/modelRouting.ts) – identisch zur Smalltalk-Route,
// - Overload-Fallback (nächst-günstigeres Modell bei 529) und
// - OpenAI-Cross-Provider-Fallback für dauerhafte 5xx/Netzwerkfehler.

type ChatRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
  tools?: unknown[];
};

// Ausreichend Spielraum für lange Coach-Antworten – 1024 hatte oft mitten im Satz gestoppt.
const MAX_TOKENS = 4096;

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

  // Gemeinsames Modell-Routing: klassifiziert den letzten menschlichen
  // User-Text und liefert die passende Modellkette (primär + Overload-
  // Fallbacks). Bei Klassifikator-Fehler → sicherer Default "mittel"
  // (sonnet-5).
  const selection = await selectModelForMessages(messages, apiKey);
  console.log(
    `[mybro] complexity=${selection.complexity}` +
      (selection.fromFallback ? " (fallback)" : "") +
      ` → models=${selection.models.join("→")}`,
  );

  // Alle in diesem Request angefallenen API-Aufrufe (Klassifikator +
  // Haupt-Call [+ ggf. OpenAI-Fallback]) werden hier gesammelt und am
  // Ende dem Client als `_usage` mitgegeben; dieser schreibt sie in
  // die `usage_log`-Tabelle.
  const usageBucket: UsageRecord[] = [];
  if (selection.classifierUsage) usageBucket.push(selection.classifierUsage);

  const outcome = await callAnthropicWithFallback(
    anthropicBody,
    apiKey,
    selection.models,
  );

  if (outcome.kind === "response" && outcome.response.ok) {
    try {
      const parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
      const mainUsage = usageFromAnthropicJson(parsed, selection.models[0]);
      if (mainUsage) usageBucket.push(mainUsage);
      console.log("[provider=claude] Antwort erfolgreich.");
      const model = typeof parsed.model === "string" ? parsed.model : null;
      return jsonResponse(200, {
        ...parsed,
        _usage: usageBucket,
        _provider: "anthropic",
        _model: model,
      });
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
      // Fällt unten in den OpenAI-Fallback.
    }
  }

  // Cross-Provider-Fallback: nur bei 5xx / Netzwerkfehler.
  if (isAnthropicUnrecoverable(outcome)) {
    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey) {
      const anthropicStatus =
        outcome.kind === "response" ? outcome.response.status : "network";
      console.warn(
        `Anthropic endgültig fehlgeschlagen (${anthropicStatus}) – aktiviere OpenAI-Fallback.`,
      );
      const openAIOutcome = await callOpenAIText(
        systemPrompt,
        messages,
        tools,
        openAIKey,
      );

      if (openAIOutcome.kind === "success") {
        if (openAIOutcome.usage) usageBucket.push(openAIOutcome.usage);
        console.log("[provider=openai-fallback] Antwort erfolgreich.");
        const shaped = openAIOutcome.anthropicShaped;
        const model =
          typeof shaped.model === "string" ? shaped.model : null;
        return jsonResponse(200, {
          ...shaped,
          _usage: usageBucket,
          _provider: "openai",
          _model: model,
          _fallback: true,
        });
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
    } else {
      console.warn(
        "OPENAI_API_KEY nicht gesetzt – kein Cross-Provider-Fallback möglich.",
      );
    }
  }

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

  console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
  return errorResponse(502, "Ungültige Antwort von der Anthropic-API.");
};

export const config = {
  path: ["/api/chat", "/.netlify/functions/chat"],
};
