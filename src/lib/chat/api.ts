import type { ApiMessage, ContentBlock } from "./types";

export type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  model: string;
  // Server-Envelope: welcher Anbieter hat tatsächlich geantwortet?
  // Wichtig für den Cross-Provider-Fallback (Anthropic → OpenAI) und
  // das Provider-Badge in der UI.
  _provider?: "anthropic" | "openai";
  _model?: string | null;
  _fallback?: boolean;
};

export type ChatApiError = {
  status: number;
  message: string;
  details?: unknown;
};

export async function callChatFunction(payload: {
  messages: ApiMessage[];
  systemPrompt: string;
  tools: unknown[];
}): Promise<AnthropicResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    let message = `Anfrage fehlgeschlagen (HTTP ${res.status}).`;
    if (
      json &&
      typeof json === "object" &&
      "error" in json &&
      typeof (json as { error: unknown }).error === "string" &&
      (json as { error: string }).error.length > 0
    ) {
      message = (json as { error: string }).error;
    }
    const err: ChatApiError = {
      status: res.status,
      message,
      details: json,
    };
    throw err;
  }

  return json as AnthropicResponse;
}
