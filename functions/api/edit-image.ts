import {
  editImageFromInput,
  OPENAI_IMAGE_UNVERIFIED_MSG,
} from "../_shared/editImage";
import type { UsageRecord } from "../_shared/pricing";
import type { Env, PagesHandler } from "../_shared/pages";

// Cloudflare-Pages-Variante des Phase-2-Bild-Bearbeitungs-Endpoints.
// Siehe netlify/functions/edit-image.ts für die Motivation.

type EditImageRequest = {
  prompt: string;
  sourceImageUrl: string;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

function readBearer(req: Request): string {
  const raw =
    req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function parseJwtSubject(token: string): string {
  if (!token) return "";
  const parts = token.split(".");
  if (parts.length !== 3) return "";
  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : "";
  } catch {
    return "";
  }
}

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const openAIKey = env.OPENAI_API_KEY;
  if (!openAIKey) {
    console.error("[edit-image] fehlt: OPENAI_API_KEY.");
    return errorResponse(
      500,
      "OPENAI_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }
  const supabaseUrl = env.SUPABASE_URL || "";
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || "";
  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseAnonKey) missing.push("SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    console.error(
      `[edit-image] fehlt: ${missing.join(", ")} (Cloudflare Pages > Settings > Variables and Secrets).`,
    );
    return errorResponse(
      500,
      `Serverseitige Supabase-Konfiguration unvollständig: ${missing.join(", ")}` +
        " nicht gesetzt.",
    );
  }

  const accessToken = readBearer(request);
  const userId = parseJwtSubject(accessToken);
  if (!accessToken || !userId) {
    return errorResponse(401, "Nicht authentifiziert.");
  }

  let payload: EditImageRequest;
  try {
    payload = (await request.json()) as EditImageRequest;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const prompt =
    typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  const sourceImageUrl =
    typeof payload?.sourceImageUrl === "string"
      ? payload.sourceImageUrl.trim()
      : "";
  if (!prompt) return errorResponse(400, "Feld 'prompt' fehlt oder ist leer.");
  if (!sourceImageUrl)
    return errorResponse(400, "Feld 'sourceImageUrl' fehlt oder ist leer.");

  const startedAt = Date.now();
  const outcome = await editImageFromInput(
    { prompt, sourceImageUrl },
    { userId, accessToken, supabaseUrl, supabaseAnonKey, openAIKey },
  );
  const durationMs = Date.now() - startedAt;

  if (outcome.ok) {
    const usage: UsageRecord[] = outcome.usage ? [outcome.usage] : [];
    console.log(
      `[edit-image] ok model=gpt-image-1 durationMs=${durationMs}` +
        ` cost=${outcome.usage?.estimated_cost_usd ?? 0}` +
        ` ts=${new Date().toISOString()}`,
    );
    return jsonResponse(200, {
      ok: true,
      url: outcome.image.url,
      path: outcome.image.path,
      prompt: outcome.image.prompt,
      sourceUrl: outcome.image.sourceUrl,
      _usage: usage,
    });
  }

  console.warn(
    `[edit-image] failed kind=${outcome.kind} status=${outcome.status ?? "n/a"}` +
      ` durationMs=${durationMs} ts=${new Date().toISOString()}`,
  );

  if (outcome.kind === "unauthorized_org") {
    return jsonResponse(403, {
      ok: false,
      kind: "unauthorized_org",
      error: OPENAI_IMAGE_UNVERIFIED_MSG,
    });
  }

  const statusMap: Record<string, number> = {
    input_error: 400,
    source_fetch_error: 502,
    openai_error: 502,
    upload_error: 502,
    network_error: 502,
  };
  const status = statusMap[outcome.kind] ?? 500;
  return jsonResponse(status, {
    ok: false,
    kind: outcome.kind,
    error: outcome.message,
  });
};

export type _EnvUsed = Env;
