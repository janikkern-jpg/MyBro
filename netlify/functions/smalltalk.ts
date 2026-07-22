import type { Context } from "@netlify/functions";
import {
  callAnthropicWithFallback,
  isAnthropicUnrecoverable,
  type AnthropicMessage,
  type FetchOutcome,
} from "./_shared/anthropic";
import { callOpenAIText } from "./_shared/openaiText";
import { selectModelForMessages } from "./_shared/modelRouting";
import { usageFromAnthropicJson, type UsageRecord } from "./_shared/pricing";

// Smalltalk-Chat-Endpoint. Eigenständiger Zweig (kein MyBro-Kontext), mit:
// - gemeinsamem Modell-Routing (haiku/sonnet/opus je nach Komplexität,
//   siehe _shared/modelRouting.ts) – identisch zur MyBro-Route
// - OpenAI-Fallback (gpt-5.4) bei dauerhaften 5xx/Netzwerk-Fehlern

type SmalltalkRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
};

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

async function respondFromOutcome(
  outcome: FetchOutcome,
  ctx: {
    systemPrompt: string | undefined;
    messages: AnthropicMessage[];
    providerTag: string;
    primaryModel: string;
    usageBucket: UsageRecord[];
  },
): Promise<Response> {
  if (outcome.kind === "response" && outcome.response.ok) {
    try {
      const parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
      const mainUsage = usageFromAnthropicJson(parsed, ctx.primaryModel);
      if (mainUsage) ctx.usageBucket.push(mainUsage);
      console.log(`[provider=${ctx.providerTag}] Antwort erfolgreich.`);
      return jsonResponse(200, { ...parsed, _usage: ctx.usageBucket });
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
      // Fällt in den OpenAI-Fallback.
    }
  }

  if (isAnthropicUnrecoverable(outcome)) {
    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey) {
      const anthropicStatus =
        outcome.kind === "response" ? outcome.response.status : "network";
      console.warn(
        `Smalltalk: Anthropic endgültig fehlgeschlagen (${anthropicStatus}) – aktiviere OpenAI-Fallback.`,
      );
      const openAIOutcome = await callOpenAIText(
        ctx.systemPrompt,
        ctx.messages,
        undefined,
        openAIKey,
      );

      if (openAIOutcome.kind === "success") {
        if (openAIOutcome.usage) ctx.usageBucket.push(openAIOutcome.usage);
        console.log("[provider=openai-fallback] Antwort erfolgreich.");
        return jsonResponse(200, {
          ...openAIOutcome.anthropicShaped,
          _usage: ctx.usageBucket,
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

  let payload: SmalltalkRequestBody;
  try {
    payload = (await req.json()) as SmalltalkRequestBody;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const { messages, systemPrompt } = payload ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse(
      400,
      "Feld 'messages' fehlt oder ist keine nicht-leere Liste.",
    );
  }

  // 1. Gemeinsames Modell-Routing (fehlertolerant → Default 'mittel'
  //    = sonnet-5). Identisch zur MyBro-Route in chat.ts.
  const selection = await selectModelForMessages(messages, apiKey);
  console.log(
    `[smalltalk] complexity=${selection.complexity}` +
      (selection.fromFallback ? " (fallback)" : "") +
      ` → models=${selection.models.join("→")}`,
  );

  // Klassifikator + Haupt-Call (+ ggf. OpenAI-Fallback) landen im
  // usageBucket; der Client persistiert das später in `usage_log`.
  const usageBucket: UsageRecord[] = [];
  if (selection.classifierUsage) usageBucket.push(selection.classifierUsage);

  // 2. Antwort-Aufruf.
  const anthropicBody: Record<string, unknown> = {
    max_tokens: MAX_TOKENS,
    messages,
  };
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    anthropicBody.system = systemPrompt;
  }

  const outcome = await callAnthropicWithFallback(
    anthropicBody,
    apiKey,
    selection.models,
  );

  return respondFromOutcome(outcome, {
    systemPrompt,
    messages,
    providerTag: `claude-smalltalk-${selection.models[0]}`,
    primaryModel: selection.models[0],
    usageBucket,
  });
};

export const config = {
  path: ["/api/smalltalk", "/.netlify/functions/smalltalk"],
};
