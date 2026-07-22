// Client-seitiges Usage-Logging.
// Die Pages-Functions hängen an ihre Response ein Feld `_usage:
// UsageEntry[]` an (siehe functions/_shared/pricing.ts).
// Diese Helferfunktion schreibt die Zeilen per RLS in `usage_log`.
//
// Fehler beim Schreiben werden bewusst nur geloggt – die eigentliche
// Chat-Interaktion soll nicht scheitern, nur weil das Kosten-Tracking
// klemmt.

import { supabase } from "./supabase";

export type UsageEntry = {
  provider: "anthropic" | "openai";
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
};

export function extractUsage(payload: unknown): UsageEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = (payload as Record<string, unknown>)._usage;
  if (!Array.isArray(raw)) return [];
  const out: UsageEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const provider = it.provider === "anthropic" || it.provider === "openai" ? it.provider : null;
    const model = typeof it.model === "string" ? it.model : null;
    const input = Number(it.input_tokens ?? 0);
    const output = Number(it.output_tokens ?? 0);
    const cost = Number(it.estimated_cost_usd ?? 0);
    if (!provider || !model || !Number.isFinite(input) || !Number.isFinite(output) || !Number.isFinite(cost)) {
      continue;
    }
    out.push({
      provider,
      model,
      input_tokens: Math.max(0, Math.round(input)),
      output_tokens: Math.max(0, Math.round(output)),
      estimated_cost_usd: Math.max(0, cost),
    });
  }
  return out;
}

export async function logUsage(
  userId: string,
  entries: UsageEntry[],
): Promise<void> {
  if (!userId || entries.length === 0) return;
  const rows = entries.map((e) => ({ ...e, user_id: userId }));
  const { error } = await supabase.from("usage_log").insert(rows);
  if (error) {
    console.warn("usage_log-Insert fehlgeschlagen:", error);
  }
}

/**
 * Convenience-Wrapper: extrahiert `_usage` aus einer Response und
 * persistiert direkt.
 */
export async function logUsageFromResponse(
  userId: string,
  payload: unknown,
): Promise<void> {
  await logUsage(userId, extractUsage(payload));
}
