// Gemeinsame Preistabelle + Usage-Extraktion für Anthropic und OpenAI.
//
// Die Serverfunktionen (chat.ts, smalltalk.ts, smalltalk-image.ts)
// sammeln pro Request ein Array `UsageRecord[]` und hängen es unter
// dem Envelope-Feld `_usage` an die Response. Der Client persistiert
// diese Zeilen dann in `public.usage_log` (RLS = per-User).
//
// Preise: USD pro 1 Million Tokens, Input/Output getrennt.
// Bewusst als Konstante im Code – exakt der vom Produkt geforderte
// Snapshot. Änderungen der API-Preise erfordern ein Deploy.
//
// gpt-image-1: Die aktuelle openai.com/docs/pricing listet nur noch die
// Nachfolgemodelle (gpt-image-2 / -1.5 / -1-mini). Wir verwenden die
// ursprünglich für gpt-image-1 veröffentlichten Referenzwerte
// (5 USD / 1M text-input-tokens, 40 USD / 1M image-output-tokens). Wenn
// OpenAI die Preise für gpt-image-1 offiziell ändert oder das Modell
// abkündigt, bitte hier anpassen.

export type Provider = "anthropic" | "openai";

export const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-image-1": { input: 5, output: 40 },
};

export type UsageRecord = {
  provider: Provider;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cost =
    (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  // 6 Nachkommastellen; die DB-Spalte ist numeric(12,6).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function toRecord(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): UsageRecord | null {
  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    (inputTokens <= 0 && outputTokens <= 0)
  ) {
    return null;
  }
  const input = Math.max(0, Math.round(inputTokens));
  const output = Math.max(0, Math.round(outputTokens));
  return {
    provider,
    model,
    input_tokens: input,
    output_tokens: output,
    estimated_cost_usd: estimateCostUsd(model, input, output),
  };
}

/**
 * Liest `usage.input_tokens`/`usage.output_tokens` aus einer bereits
 * geparsten Anthropic-Messages-Response. `fallbackModel` wird verwendet,
 * wenn die Response selbst keinen Modell-Namen mitliefert (rare).
 */
export function usageFromAnthropicJson(
  parsed: unknown,
  fallbackModel: string,
): UsageRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    model?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const usage = obj.usage;
  if (!usage) return null;
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const model = typeof obj.model === "string" ? obj.model : fallbackModel;
  return toRecord("anthropic", model, input, output);
}

/** Bequemer Wrapper, wenn nur der rohe Response-Text vorliegt. */
export function usageFromAnthropicRaw(
  rawText: string,
  fallbackModel: string,
): UsageRecord | null {
  try {
    return usageFromAnthropicJson(JSON.parse(rawText), fallbackModel);
  } catch {
    return null;
  }
}

/**
 * OpenAI-Chat-Completions liefert `usage.prompt_tokens` und
 * `usage.completion_tokens`. Wir mappen sie auf input/output.
 */
export function usageFromOpenAIChatJson(
  parsed: unknown,
  fallbackModel: string,
): UsageRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    model?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const usage = obj.usage;
  if (!usage) return null;
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  const model = typeof obj.model === "string" ? obj.model : fallbackModel;
  return toRecord("openai", model, input, output);
}

/**
 * gpt-image-1 liefert `usage.input_tokens` + `usage.output_tokens`
 * (mit optionalen `input_tokens_details.text_tokens`/`image_tokens`).
 * Wir mitteln nichts extra – die Preise gelten für die aggregierten
 * Werte.
 */
export function usageFromOpenAIImageJson(
  parsed: unknown,
  fallbackModel = "gpt-image-1",
): UsageRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as {
    model?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  const usage = obj.usage;
  if (!usage) return null;
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const model = typeof obj.model === "string" ? obj.model : fallbackModel;
  return toRecord("openai", model, input, output);
}
