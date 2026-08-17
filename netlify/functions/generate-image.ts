import type { Context } from "@netlify/functions";
import {
  generateImageFromToolInput,
  OPENAI_IMAGE_UNVERIFIED_MSG,
} from "./_shared/generateImage";
import type { UsageRecord } from "./_shared/pricing";

// Phase-2-Endpoint für die Bildgenerierung im Smalltalk-Modus.
//
// Der Smalltalk-Endpoint (`/api/smalltalk`) antwortet mit
// { status: "generating_image", imagePrompt } sobald Claude das
// Werkzeug `generate_image` anfordert – ohne selbst OpenAI aufzurufen.
// Das Frontend zeigt daraufhin einen dedizierten "Bild wird
// generiert…"-Loader (statt der generischen Tippanzeige) und ruft
// diesen Endpoint hier auf. Nur dieser Endpoint spricht die OpenAI
// Images API an und lädt das Ergebnis in den `chat-images`-Bucket.

type GenerateImageRequest = {
  prompt: string;
  size?: string;
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

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") {
    return errorResponse(405, "Nur POST erlaubt.");
  }

  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) {
    return errorResponse(
      500,
      "OPENAI_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  if (!supabaseUrl || !supabaseAnonKey) {
    return errorResponse(
      500,
      "SUPABASE_URL / SUPABASE_ANON_KEY sind serverseitig nicht konfiguriert.",
    );
  }

  const accessToken = readBearer(req);
  const userId = parseJwtSubject(accessToken);
  if (!accessToken || !userId) {
    return errorResponse(401, "Nicht authentifiziert.");
  }

  let payload: GenerateImageRequest;
  try {
    payload = (await req.json()) as GenerateImageRequest;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const prompt =
    typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return errorResponse(400, "Feld 'prompt' fehlt oder ist leer.");
  }
  const size =
    typeof payload.size === "string" && payload.size.trim().length > 0
      ? payload.size.trim()
      : undefined;

  const startedAt = Date.now();
  const outcome = await generateImageFromToolInput(
    { prompt, size },
    {
      userId,
      accessToken,
      supabaseUrl,
      supabaseAnonKey,
      openAIKey,
    },
  );
  const durationMs = Date.now() - startedAt;

  if (outcome.ok) {
    const usage: UsageRecord[] = outcome.usage ? [outcome.usage] : [];
    console.log(
      `[generate-image] ok model=gpt-image-1 size=${outcome.image.size}` +
        ` durationMs=${durationMs} cost=${outcome.usage?.estimated_cost_usd ?? 0}` +
        ` ts=${new Date().toISOString()}`,
    );
    return jsonResponse(200, {
      ok: true,
      url: outcome.image.url,
      path: outcome.image.path,
      size: outcome.image.size,
      prompt: outcome.image.prompt,
      _usage: usage,
    });
  }

  console.warn(
    `[generate-image] failed kind=${outcome.kind} status=${outcome.status ?? "n/a"}` +
      ` durationMs=${durationMs} ts=${new Date().toISOString()}`,
  );

  // 403 (Org-Verification fehlt) bekommt einen eigenen Status-Code +
  // exakt den Klartext, den der Client direkt in der Nachricht anzeigt.
  if (outcome.kind === "unauthorized_org") {
    return jsonResponse(403, {
      ok: false,
      kind: "unauthorized_org",
      error: OPENAI_IMAGE_UNVERIFIED_MSG,
    });
  }

  const statusMap: Record<string, number> = {
    input_error: 400,
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

export const config = {
  path: ["/api/generate-image", "/.netlify/functions/generate-image"],
};
