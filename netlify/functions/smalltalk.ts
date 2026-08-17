import type { Context } from "@netlify/functions";
import {
  callAnthropicWithFallback,
  isAnthropicUnrecoverable,
  type AnthropicMessage,
  type FetchOutcome,
} from "./_shared/anthropic";
import { callOpenAIText } from "./_shared/openaiText";
import { selectModelForMessages } from "./_shared/modelRouting";
import {
  usageForAnthropicWebSearch,
  usageFromAnthropicJson,
  type UsageRecord,
} from "./_shared/pricing";
import {
  CREATE_FILE_TOOL,
  createFileFromToolInput,
  type CreatedFile,
} from "./_shared/createFile";
import {
  GENERATE_IMAGE_TOOL,
  generateImageFromToolInput,
  OPENAI_IMAGE_UNVERIFIED_MSG,
  type GeneratedImage,
} from "./_shared/generateImage";

// Smalltalk-Chat-Endpoint. Eigenständiger Zweig (kein MyBro-Kontext), mit:
// - gemeinsamem Modell-Routing (haiku/sonnet/opus je nach Komplexität)
// - OpenAI-Fallback (gpt-5.4) bei dauerhaften 5xx/Netzwerk-Fehlern
// - Anthropic-eigenem Web-Search-Tool (server-side) für aktuelle Themen
// - `create_file`-Tool (client-side, Tool-Loop): Claude fordert eine
//   Datei an, der Server generiert sie (CSV/TXT/JSON/PDF/DOCX),
//   lädt sie in den Supabase-Bucket `chat-files` hoch (Auth: das
//   Access-Token des Users → RLS greift) und gibt die Download-URL als
//   tool_result zurück; die Schleife läuft, bis Claude fertig ist.
// - `generate_image`-Tool (client-side, Tool-Loop): Claude ruft es auf,
//   wenn erkennbar ein Bild gewollt ist. Server ruft die OpenAI Image-
//   API (gpt-image-1) auf, lädt das PNG in den `chat-images`-Bucket,
//   liefert die Public-URL als tool_result zurück. 403-Fehler wird als
//   klarer Klartext an Claude gemeldet (Org-Verification-Hinweis).

type SmalltalkRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
};

const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 5;

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
} as const;

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

// Loggt in Netlify-Function-Logs, ob Claude das Web-Search-Tool
// tatsächlich aufgerufen hat.
function logWebSearchTelemetry(
  providerTag: string,
  parsed: Record<string, unknown>,
): void {
  const content = Array.isArray(parsed.content)
    ? (parsed.content as Array<Record<string, unknown>>)
    : [];
  const serverToolUses = content.filter(
    (b) => b?.type === "server_tool_use",
  ).length;
  const webSearchResults = content.filter(
    (b) => b?.type === "web_search_tool_result",
  ).length;
  let citationCount = 0;
  for (const b of content) {
    if (b?.type !== "text") continue;
    const cits = (b as { citations?: unknown }).citations;
    if (Array.isArray(cits)) citationCount += cits.length;
  }
  const usage = (parsed as { usage?: Record<string, unknown> }).usage ?? {};
  const requests = Number(
    (usage as { server_tool_use?: { web_search_requests?: unknown } })
      .server_tool_use?.web_search_requests ?? 0,
  );
  const stopReason = (parsed as { stop_reason?: unknown }).stop_reason;
  console.log(
    `[provider=${providerTag}] web_search: requests=${requests} ` +
      `serverToolUses=${serverToolUses} results=${webSearchResults} ` +
      `citations=${citationCount} stop_reason=${String(stopReason)}`,
  );
}

// -------------------- Tool-Loop-Helfer ---------------------------------

type ContentBlockJson = Record<string, unknown>;

/**
 * Sammelt alle `tool_use`-Blöcke, die auf ein *client*-Tool zeigen
 * (aktuell `create_file` und `generate_image`). Server-Tools
 * (`web_search`) laufen innerhalb der Anthropic-API und tauchen als
 * `server_tool_use` auf – die brauchen wir NICHT selbst zu bedienen.
 */
function extractClientToolUses(
  parsed: Record<string, unknown>,
): Array<{ id: string; name: string; input: unknown }> {
  const content = Array.isArray(parsed.content)
    ? (parsed.content as ContentBlockJson[])
    : [];
  const uses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const b of content) {
    if (b?.type !== "tool_use") continue;
    const id = typeof b.id === "string" ? b.id : "";
    const name = typeof b.name === "string" ? b.name : "";
    if (id && (name === "create_file" || name === "generate_image")) {
      uses.push({ id, name, input: b.input });
    }
  }
  return uses;
}

async function runToolLoop(opts: {
  initialBody: Record<string, unknown>;
  apiKey: string;
  models: readonly string[];
  usageBucket: UsageRecord[];
  providerTag: string;
  createdFiles: CreatedFile[];
  createdImages: GeneratedImage[];
  fileEnv: {
    userId: string;
    accessToken: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
  } | null;
  openAIKey: string;
}): Promise<FetchOutcome> {
  const messages = [
    ...((opts.initialBody.messages as AnthropicMessage[]) ?? []),
  ];
  let lastOutcome: FetchOutcome | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const body = { ...opts.initialBody, messages };
    const outcome = await callAnthropicWithFallback(
      body,
      opts.apiKey,
      opts.models,
    );
    lastOutcome = outcome;

    if (outcome.kind !== "response" || !outcome.response.ok) {
      return outcome;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
    } catch {
      return outcome;
    }

    const mainUsage = usageFromAnthropicJson(
      parsed,
      opts.models[0] ?? "unknown",
    );
    if (mainUsage) opts.usageBucket.push(mainUsage);
    const webSearchUsage = usageForAnthropicWebSearch(parsed);
    if (webSearchUsage) opts.usageBucket.push(webSearchUsage);
    logWebSearchTelemetry(opts.providerTag, parsed);

    const stopReason =
      typeof parsed.stop_reason === "string" ? parsed.stop_reason : "";
    const toolUses = extractClientToolUses(parsed);

    if (stopReason !== "tool_use" || toolUses.length === 0) {
      return outcome;
    }

    // Assistant-Turn (die komplette content-Liste!) übernehmen und
    // tool_results als neuen User-Turn anhängen.
    messages.push({
      role: "assistant",
      content: parsed.content as unknown,
    });

    const toolResultBlocks: ContentBlockJson[] = [];
    for (const use of toolUses) {
      if (use.name === "create_file") {
        if (!opts.fileEnv) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content:
              "Dateidownload nicht verfügbar: der Nutzer ist nicht authentifiziert oder der Server hat keine Supabase-Konfiguration.",
          });
          continue;
        }
        try {
          const file = await createFileFromToolInput(use.input, opts.fileEnv);
          opts.createdFiles.push(file);
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({
              ok: true,
              filename: file.filename,
              file_type: file.file_type,
              url: file.url,
              size_bytes: file.size_bytes,
              note:
                "Datei wurde erzeugt und im Chat als Download-Karte angezeigt. Erwähne den Dateinamen kurz, aber wiederhole den Inhalt NICHT im Text.",
            }),
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Unbekannter Fehler.";
          console.error("[smalltalk] create_file fehlgeschlagen:", message);
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Datei konnte nicht erzeugt werden: ${message}`,
          });
        }
        continue;
      }

      if (use.name === "generate_image") {
        if (!opts.fileEnv || !opts.openAIKey) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content:
              "Bildgenerierung nicht verfügbar: der Nutzer ist nicht authentifiziert oder OPENAI_API_KEY/Supabase sind nicht konfiguriert.",
          });
          continue;
        }
        const startedAt = Date.now();
        const outcome = await generateImageFromToolInput(use.input, {
          userId: opts.fileEnv.userId,
          accessToken: opts.fileEnv.accessToken,
          supabaseUrl: opts.fileEnv.supabaseUrl,
          supabaseAnonKey: opts.fileEnv.supabaseAnonKey,
          openAIKey: opts.openAIKey,
        });
        const durationMs = Date.now() - startedAt;

        if (outcome.ok) {
          if (outcome.usage) opts.usageBucket.push(outcome.usage);
          opts.createdImages.push(outcome.image);
          console.log(
            `[smalltalk] generate_image ok model=gpt-image-1 size=${outcome.image.size} durationMs=${durationMs} cost=${outcome.usage?.estimated_cost_usd ?? 0} ts=${new Date().toISOString()}`,
          );
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: JSON.stringify({
              ok: true,
              url: outcome.image.url,
              size: outcome.image.size,
              note:
                "Das Bild wurde erzeugt und wird direkt unter der Nachricht angezeigt. Wiederhole die URL NICHT im Text; sag höchstens einen kurzen Satz dazu.",
            }),
          });
        } else {
          console.warn(
            `[smalltalk] generate_image failed kind=${outcome.kind} status=${outcome.status ?? "n/a"} durationMs=${durationMs} ts=${new Date().toISOString()}`,
          );
          // 403 (Org-Verification) verpacken wir mit dem exakten
          // Klartext, den der Nutzer sehen soll – der System-Prompt
          // weist Claude an, diesen Satz wörtlich zu zitieren.
          const content =
            outcome.kind === "unauthorized_org"
              ? `${OPENAI_IMAGE_UNVERIFIED_MSG} Bitte teile dem Nutzer GENAU diese Meldung in einem einzigen Satz mit und stelle keine Nachfragen.`
              : outcome.message;
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content,
          });
        }
        continue;
      }

      // Unbekanntes Client-Tool – sollte nie passieren, wir markieren es
      // aber als Fehler, damit Claude sich nicht in eine Endlosschleife
      // hineindreht.
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: true,
        content: `Unbekanntes Tool: ${use.name}.`,
      });
    }

    messages.push({
      role: "user",
      content: toolResultBlocks as unknown,
    });
  }

  console.warn(
    `[smalltalk] Tool-Loop hat MAX_TOOL_ITERATIONS (${MAX_TOOL_ITERATIONS}) erreicht.`,
  );
  return (
    lastOutcome ?? {
      kind: "network-error",
      error: new Error("Tool-Loop ohne Antwort."),
    }
  );
}

async function respondFromOutcome(
  outcome: FetchOutcome,
  ctx: {
    systemPrompt: string | undefined;
    messages: AnthropicMessage[];
    providerTag: string;
    usageBucket: UsageRecord[];
    createdFiles: CreatedFile[];
    createdImages: GeneratedImage[];
  },
): Promise<Response> {
  if (outcome.kind === "response" && outcome.response.ok) {
    try {
      const parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
      // Token-/Web-Search-Usage wurde im Tool-Loop bereits gebucht.
      console.log(`[provider=${ctx.providerTag}] Antwort erfolgreich.`);
      return jsonResponse(200, {
        ...parsed,
        _usage: ctx.usageBucket,
        _files: ctx.createdFiles,
        _images: ctx.createdImages,
      });
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
    }
  }

  if (isAnthropicUnrecoverable(outcome)) {
    const openAIKey = process.env.OPENAI_API_KEY;
    if (openAIKey) {
      const anthropicStatus =
        outcome.kind === "response" ? outcome.response.status : "network";
      console.warn(
        `Smalltalk: Anthropic endgültig fehlgeschlagen (${anthropicStatus}) – aktiviere OpenAI-Fallback.`,
      );
      const openAIOutcome = await callOpenAIText(
        ctx.systemPrompt,
        ctx.messages,
        undefined,
        openAIKey,
      );

      if (openAIOutcome.kind === "success") {
        if (openAIOutcome.usage) ctx.usageBucket.push(openAIOutcome.usage);
        console.log("[provider=openai-fallback] Antwort erfolgreich.");
        return jsonResponse(200, {
          ...openAIOutcome.anthropicShaped,
          _usage: ctx.usageBucket,
          _files: ctx.createdFiles,
          _images: ctx.createdImages,
        });
      }

      if (openAIOutcome.kind === "error") {
        console.error(
          "OpenAI-Fallback fehlgeschlagen:",
          openAIOutcome.status,
          openAIOutcome.details,
        );
      } else {
        console.error("OpenAI-Fallback-Netzwerkfehler:", openAIOutcome.error);
      }
    } else {
      console.warn(
        "OPENAI_API_KEY nicht gesetzt – kein Cross-Provider-Fallback möglich.",
      );
    }
  }

  if (outcome.kind === "network-error") {
    console.error("Anthropic-Request endgültig fehlgeschlagen:", outcome.error);
    return errorResponse(502, "Anthropic-API nicht erreichbar.");
  }

  const upstream = outcome.response;
  const rawText = outcome.rawText;
  let upstreamError: unknown = rawText;
  try {
    upstreamError = JSON.parse(rawText);
  } catch {
    // rawText bleibt Fallback
  }
  console.error(
    "Anthropic-API antwortete mit Fehler:",
    upstream.status,
    upstreamError,
  );
  const clientMessage =
    upstream.status === 529
      ? "Anthropic ist gerade stark ausgelastet. Bitte in ein paar Minuten erneut versuchen."
      : "Anthropic-API antwortete mit einem Fehler.";
  return jsonResponse(upstream.status, {
    error: clientMessage,
    status: upstream.status,
    details: upstreamError,
  });
}

// Zerlegt "Bearer xyz" → "xyz". Case-insensitive, leerer String, wenn
// Header fehlt oder Schema falsch ist.
function readBearer(req: Request): string {
  const raw =
    req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

// Sub-Claim aus einem Supabase-JWT holen (userId), ohne Signatur zu
// prüfen. Für Autorisierung reicht uns die RLS-Prüfung beim Storage-
// Upload: dort wird das Token echt verifiziert. Wir brauchen `sub` nur,
// um den Pfad `{user_id}/{uuid}.{ext}` korrekt zu bauen.
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "ANTHROPIC_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: SmalltalkRequestBody;
  try {
    payload = (await req.json()) as SmalltalkRequestBody;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const { messages, systemPrompt } = payload ?? {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse(
      400,
      "Feld 'messages' fehlt oder ist keine nicht-leere Liste.",
    );
  }

  const selection = await selectModelForMessages(messages, apiKey);
  console.log(
    `[smalltalk] complexity=${selection.complexity}` +
      (selection.fromFallback ? " (fallback)" : "") +
      ` → models=${selection.models.join("→")}`,
  );

  const usageBucket: UsageRecord[] = [];
  if (selection.classifierUsage) usageBucket.push(selection.classifierUsage);

  // OpenAI-Key wird sowohl für den Text-Fallback als auch für das
  // generate_image-Tool gebraucht. Wenn er fehlt, aktivieren wir das
  // Tool schlicht nicht.
  const openAIKey = process.env.OPENAI_API_KEY || "";

  // File-/Image-Env: nur wenn Token + Supabase-Konfig da sind, bieten
  // wir create_file/generate_image überhaupt an. So bleibt der Loop
  // leichtgewichtig, wenn z. B. ein alter Client kein Bearer-Token
  // schickt.
  const accessToken = readBearer(req);
  const userId = parseJwtSubject(accessToken);
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";
  const fileEnvReady = Boolean(
    accessToken && userId && supabaseUrl && supabaseAnonKey,
  );
  const fileEnv = fileEnvReady
    ? { userId, accessToken, supabaseUrl, supabaseAnonKey }
    : null;
  const imageToolEnabled = fileEnvReady && Boolean(openAIKey);

  const webSearchDisabled = process.env.SMALLTALK_DISABLE_WEB_SEARCH === "1";

  const tools: unknown[] = [];
  if (!webSearchDisabled) tools.push(WEB_SEARCH_TOOL);
  if (fileEnvReady) tools.push(CREATE_FILE_TOOL);
  if (imageToolEnabled) tools.push(GENERATE_IMAGE_TOOL);

  const anthropicBody: Record<string, unknown> = {
    max_tokens: MAX_TOKENS,
    messages,
  };
  if (tools.length > 0) anthropicBody.tools = tools;
  if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
    anthropicBody.system = systemPrompt;
  }

  if (!fileEnvReady) {
    console.warn(
      "[smalltalk] create_file-Tool nicht aktiv:" +
        ` token=${accessToken ? "yes" : "no"}, userId=${userId ? "yes" : "no"},` +
        ` SUPABASE_URL=${supabaseUrl ? "yes" : "no"}, SUPABASE_ANON_KEY=${supabaseAnonKey ? "yes" : "no"}.`,
    );
  }
  if (!imageToolEnabled) {
    console.warn(
      `[smalltalk] generate_image-Tool nicht aktiv: fileEnvReady=${fileEnvReady}, OPENAI_API_KEY=${openAIKey ? "yes" : "no"}.`,
    );
  }

  const createdFiles: CreatedFile[] = [];
  const createdImages: GeneratedImage[] = [];
  const outcome = await runToolLoop({
    initialBody: anthropicBody,
    apiKey,
    models: selection.models,
    usageBucket,
    providerTag: `claude-smalltalk-${selection.models[0]}`,
    createdFiles,
    createdImages,
    fileEnv,
    openAIKey,
  });

  return respondFromOutcome(outcome, {
    systemPrompt,
    messages,
    providerTag: `claude-smalltalk-${selection.models[0]}`,
    usageBucket,
    createdFiles,
    createdImages,
  });
};

export const config = {
  path: ["/api/smalltalk", "/.netlify/functions/smalltalk"],
};
