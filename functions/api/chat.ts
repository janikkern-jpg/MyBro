import {
  callAnthropicWithFallback,
  isAnthropicUnrecoverable,
  type AnthropicMessage,
} from "../_shared/anthropic";
import { callOpenAIText } from "../_shared/openaiText";
import { selectModelForMessages } from "../_shared/modelRouting";
import { usageFromAnthropicJson, type UsageRecord } from "../_shared/pricing";
import type { PagesHandler } from "../_shared/pages";

// MyBro-Chat-Endpoint (Cloudflare Pages Functions).
// Proxy für Anthropic mit
// - gemeinsamem Modell-Routing (haiku/sonnet/opus je nach Komplexität,
//   siehe _shared/modelRouting.ts) – identisch zur Smalltalk-Route,
// - Overload-Fallback (nächst-günstigeres Modell bei 529) und
// - OpenAI-Cross-Provider-Fallback für dauerhafte 5xx/Netzwerkfehler.

type ChatRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
  tools?: unknown[];
};

const MAX_TOKENS = 4096;

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
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "ANTHROPIC_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: ChatRequestBody;
  try {
    payload = (await request.json()) as ChatRequestBody;
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

  const selection = await selectModelForMessages(messages, apiKey);
  console.log(
    `[mybro] complexity=${selection.complexity}` +
      (selection.fromFallback ? " (fallback)" : "") +
      ` → models=${selection.models.join("→")}`,
  );

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
      return jsonResponse(200, { ...parsed, _usage: usageBucket });
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
    }
  }

  if (isAnthropicUnrecoverable(outcome)) {
    const openAIKey = env.OPENAI_API_KEY;
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
        return jsonResponse(200, {
          ...openAIOutcome.anthropicShaped,
          _usage: usageBucket,
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
