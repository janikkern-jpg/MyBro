import type {
  StApiMessage,
  StChatResponse,
  StImageResponse,
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
