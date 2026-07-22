// OpenAI Image API (gpt-image-1). Nur der Smalltalk-Modus nutzt das.
// gpt-image-1 liefert das Bild als base64-JSON zurück; der Client
// bekommt eine data:-URL, die 1:1 als <img src> darstellbar ist.

import { usageFromOpenAIImageJson, type UsageRecord } from "./pricing";

const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_IMAGE_MODEL = "gpt-image-1";

export type ImageOutcome =
  | { kind: "success"; dataUrl: string; usage: UsageRecord | null }
  | { kind: "error"; status: number; details: unknown }
  | { kind: "network-error"; error: unknown };

type ImageResponse = {
  data?: Array<{ b64_json?: string; url?: string }>;
  usage?: unknown;
  model?: unknown;
};

export async function callOpenAIImage(
  prompt: string,
  apiKey: string,
  options: { size?: string } = {},
): Promise<ImageOutcome> {
  const body: Record<string, unknown> = {
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size: options.size ?? "1024x1024",
    n: 1,
  };

  let response: Response;
  try {
    response = await fetch(OPENAI_IMAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
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

  let parsed: ImageResponse;
  try {
    parsed = JSON.parse(rawText) as ImageResponse;
  } catch {
    return { kind: "error", status: 502, details: "invalid_json_from_openai" };
  }

  const entry = parsed.data?.[0];
  const usage = usageFromOpenAIImageJson(parsed, OPENAI_IMAGE_MODEL);
  if (entry?.b64_json) {
    return {
      kind: "success",
      dataUrl: `data:image/png;base64,${entry.b64_json}`,
      usage,
    };
  }
  if (entry?.url) {
    // Fallback: manche Response-Formate liefern eine URL.
    return { kind: "success", dataUrl: entry.url, usage };
  }

  return { kind: "error", status: 502, details: "no_image_in_response" };
}
