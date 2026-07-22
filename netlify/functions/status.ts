import type { Context } from "@netlify/functions";

// Leichtgewichtiger Verbindungscheck für Anthropic und OpenAI.
// GET auf /v1/models bei beiden Anbietern – validiert nur den API-Key
// und verbraucht keine Tokens.
//
// Response-Shape pro Anbieter: { connected, configured, error? }.

type ProviderStatus = {
  connected: boolean;
  configured: boolean;
  error?: string;
};

type StatusResponse = {
  anthropic: ProviderStatus;
  openai: ProviderStatus;
};

const REQUEST_TIMEOUT_MS = 8000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function shortErrorFromBody(rawText: string): string | null {
  if (!rawText) return null;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (parsed && typeof parsed === "object") {
      const err = (parsed as { error?: unknown }).error;
      if (err && typeof err === "object") {
        const msg = (err as { message?: unknown }).message;
        if (typeof msg === "string" && msg.trim().length > 0) {
          return msg.trim();
        }
      }
      if (typeof err === "string" && err.trim().length > 0) return err.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) return "Ungültiger API-Key.";
  if (status === 429) return "Rate-Limit erreicht.";
  if (status >= 500) return `Serverfehler beim Anbieter (HTTP ${status}).`;
  return `Verbindungsfehler (HTTP ${status}).`;
}

async function checkAnthropic(): Promise<ProviderStatus> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { connected: false, configured: false };
  try {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
    });
    if (res.ok) return { connected: true, configured: true };
    const body = await res.text().catch(() => "");
    return {
      connected: false,
      configured: true,
      error: shortErrorFromBody(body) ?? statusMessage(res.status),
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Zeitüberschreitung."
        : "Anbieter nicht erreichbar.";
    return { connected: false, configured: true, error: message };
  }
}

async function checkOpenAI(): Promise<ProviderStatus> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { connected: false, configured: false };
  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { connected: true, configured: true };
    const body = await res.text().catch(() => "");
    return {
      connected: false,
      configured: true,
      error: shortErrorFromBody(body) ?? statusMessage(res.status),
    };
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? "Zeitüberschreitung."
        : "Anbieter nicht erreichbar.";
    return { connected: false, configured: true, error: message };
  }
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return jsonResponse(405, { error: "Nur GET erlaubt." });
  }
  const [anthropic, openai] = await Promise.all([
    checkAnthropic(),
    checkOpenAI(),
  ]);
  const body: StatusResponse = { anthropic, openai };
  return jsonResponse(200, body);
};

export const config = {
  path: ["/api/status", "/.netlify/functions/status"],
};
