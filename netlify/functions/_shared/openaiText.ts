// OpenAI-Fallback für den Anthropic-Text-Endpunkt. Wird sowohl vom
// MyBro- als auch vom Smalltalk-Endpoint verwendet, um bei dauerhaften
// 5xx-/Netzwerk-Fehlern von Anthropic transparent auf gpt-5.4 auszuweichen.
// Antworten werden auf das Anthropic-Response-Shape zurückübersetzt, damit
// das Frontend keinen Unterschied merkt.

import type { AnthropicMessage } from "./anthropic";
import { usageFromOpenAIChatJson, type UsageRecord } from "./pricing";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5.4";
const MAX_TOKENS = 4096;

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

export type OpenAIOutcome =
  | {
      kind: "success";
      anthropicShaped: Record<string, unknown>;
      usage: UsageRecord | null;
    }
  | { kind: "error"; status: number; details: unknown }
  | { kind: "network-error"; error: unknown };

export async function callOpenAIText(
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
    return {
      kind: "success",
      anthropicShaped: openAIToAnthropicResponse(parsed),
      usage: usageFromOpenAIChatJson(parsed, OPENAI_MODEL),
    };
  } catch {
    return { kind: "error", status: 502, details: "invalid_json_from_openai" };
  }
}
