import { callOpenAIImage } from "../_shared/openaiImage";
import type { PagesHandler } from "../_shared/pages";

// Bild-Generierung für den Smalltalk-Modus (Cloudflare Pages Functions).
// Nutzt ausschließlich OpenAI (gpt-image-1).

type SmalltalkImageRequest = {
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

export const onRequestPost: PagesHandler = async ({ request, env }) => {
  const openAIKey = env.OPENAI_API_KEY;
  if (!openAIKey) {
    return errorResponse(
      500,
      "OPENAI_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: SmalltalkImageRequest;
  try {
    payload = (await request.json()) as SmalltalkImageRequest;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
  if (!prompt) {
    return errorResponse(400, "Feld 'prompt' fehlt oder ist leer.");
  }

  const outcome = await callOpenAIImage(prompt, openAIKey, {
    size: typeof payload.size === "string" ? payload.size : undefined,
  });

  if (outcome.kind === "success") {
    console.log("[provider=openai-image] Bild erfolgreich generiert.");
    return jsonResponse(200, {
      imageUrl: outcome.dataUrl,
      _usage: outcome.usage ? [outcome.usage] : [],
    });
  }

  if (outcome.kind === "error") {
    console.error(
      "OpenAI-Image fehlgeschlagen:",
      outcome.status,
      outcome.details,
    );
    return jsonResponse(outcome.status, {
      error: "Bildgenerierung fehlgeschlagen.",
      status: outcome.status,
      details: outcome.details,
    });
  }

  console.error("OpenAI-Image-Netzwerkfehler:", outcome.error);
  return errorResponse(502, "OpenAI-Image nicht erreichbar.");
};
