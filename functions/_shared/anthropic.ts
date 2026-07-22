// Anthropic Messages API – Aufruf mit Retry pro Modell und Fallback über
// eine konfigurierbare Modell-Liste (z. B. bei 529/overloaded). Wird
// sowohl vom MyBro- als auch vom Smalltalk-Endpoint genutzt.

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: unknown;
};

export type FetchOutcome =
  | { kind: "response"; response: Response; rawText: string }
  | { kind: "network-error"; error: unknown };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS_PER_MODEL = 2;
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

export async function callAnthropicWithFallback(
  body: Record<string, unknown>,
  apiKey: string,
  models: readonly string[],
): Promise<FetchOutcome> {
  let lastOutcome: FetchOutcome = {
    kind: "network-error",
    error: new Error("no attempt"),
  };

  for (const model of models) {
    const outcome = await callAnthropicModel(body, apiKey, model);
    lastOutcome = outcome;

    if (outcome.kind === "response" && outcome.response.ok) return outcome;

    // Bei 529/overloaded: nächstes Modell probieren.
    if (outcome.kind === "response" && outcome.response.status === 529) {
      console.warn(`Modell ${model} überlastet – wechsle auf nächstes Modell.`);
      continue;
    }

    // Andere Fehler (400/401/404 …) sind Modell-unabhängig → sofort raus.
    return outcome;
  }

  return lastOutcome;
}

/**
 * True, wenn der Anthropic-Aufruf dauerhaft mit einem 5xx-Server-Fehler oder
 * Netzwerkfehler geendet ist – der Punkt, an dem der OpenAI-Fallback greift.
 */
export function isAnthropicUnrecoverable(outcome: FetchOutcome): boolean {
  return (
    outcome.kind === "network-error" ||
    (outcome.kind === "response" && outcome.response.status >= 500)
  );
}
