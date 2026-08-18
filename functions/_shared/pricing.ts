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
  // Sprachmodus – siehe Konstanten oben.
  "gpt-4o-mini-tts": { input: 0.6, output: 12 },
};

// Anthropic Web-Search (server-side tool): USD pro Suchanfrage.
// Referenz: https://docs.anthropic.com/... – 10 USD / 1000 Suchen.
export const WEB_SEARCH_MODEL = "web_search_20250305";
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

// Sprachmodus – Whisper (Transkription).
// Referenz (Stand: OpenAI Pricing "Transcription models"):
// Whisper wird pauschal pro Audio-Minute abgerechnet. Wir loggen 0
// Tokens, weil die API keine Tokens meldet – die Kosten kommen
// vollständig aus der Audiodauer.
export const WHISPER_MODEL = "whisper-1";
export const WHISPER_USD_PER_MINUTE = 0.006;

// Sprachmodus – TTS (gpt-4o-mini-tts).
// Offiziell staffelt OpenAI die Kosten in Text-Input-Tokens
// ($0.60 / 1M Tokens) und Audio-Output-Tokens ($12.00 / 1M Tokens),
// aber der Speech-Endpoint gibt weder Token-Zahlen noch Audio-Dauer
// zurück. Wir approximieren:
//   - Input-Tokens ≈ Zeichen / 4 (übliche Faustregel Deutsch/Englisch)
//   - Output-Audio-Tokens ≈ Zeichen × 5 (grobe Schätzung: bei
//     ~150 WPM und ~12.5 Audio-Tokens/s ergibt sich ca. 5 Tokens pro
//     Textzeichen – hinreichend für Kostenüberblick, nicht für
//     Buchhaltung).
// Preise als USD pro 1M Tokens; siehe PRICING-Eintrag unten.
export const TTS_MODEL = "gpt-4o-mini-tts";
export const TTS_DEFAULT_VOICE = "onyx";
const TTS_INPUT_TOKENS_PER_CHAR = 1 / 4;
const TTS_OUTPUT_TOKENS_PER_CHAR = 5;

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

/**
 * Anthropic zählt in `usage.server_tool_use.web_search_requests` die
 * Zahl der tatsächlich ausgeführten Websuchen. Diese werden zusätzlich
 * zu den Token-Kosten berechnet (Pauschale pro Suche). Wir erzeugen
 * einen eigenen UsageRecord mit 0 Tokens und dem berechneten Cost, damit
 * die Kosten im usage_log getrennt sichtbar bleiben.
 */
export function usageForAnthropicWebSearch(
  parsed: unknown,
): UsageRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const usage = (parsed as {
    usage?: {
      server_tool_use?: { web_search_requests?: unknown };
    };
  }).usage;
  const count = Number(usage?.server_tool_use?.web_search_requests ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  const rounded = Math.max(0, Math.round(count));
  const cost =
    Math.round(rounded * WEB_SEARCH_USD_PER_REQUEST * 1_000_000) / 1_000_000;
  return {
    provider: "anthropic",
    model: WEB_SEARCH_MODEL,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: cost,
  };
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

/**
 * Whisper wird pro Audio-Minute abgerechnet. Wir loggen 0 Tokens und
 * die reine Zeit-basierte Kostenschätzung, damit der Voice-Modus im
 * usage_log getrennt sichtbar bleibt.
 */
export function usageForWhisper(durationSeconds: number): UsageRecord | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const minutes = durationSeconds / 60;
  const cost =
    Math.round(minutes * WHISPER_USD_PER_MINUTE * 1_000_000) / 1_000_000;
  return {
    provider: "openai",
    model: WHISPER_MODEL,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: cost,
  };
}

/**
 * TTS (gpt-4o-mini-tts): näherungsweise Umrechnung Text-Zeichen →
 * Tokens (siehe Kommentare zu TTS_*_TOKENS_PER_CHAR). Der Speech-
 * Endpoint liefert keine Usage-Header, daher approximieren wir.
 */
export function usageForTts(text: string): UsageRecord | null {
  const chars = typeof text === "string" ? text.length : 0;
  if (chars <= 0) return null;
  const inputTokens = Math.max(1, Math.round(chars * TTS_INPUT_TOKENS_PER_CHAR));
  const outputTokens = Math.max(
    1,
    Math.round(chars * TTS_OUTPUT_TOKENS_PER_CHAR),
  );
  return toRecord("openai", TTS_MODEL, inputTokens, outputTokens);
}
