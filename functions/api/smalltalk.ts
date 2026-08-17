import {
  callAnthropicWithFallback,
  isAnthropicUnrecoverable,
  type AnthropicMessage,
  type FetchOutcome,
} from "../_shared/anthropic";
import { callOpenAIText } from "../_shared/openaiText";
import { selectModelForMessages } from "../_shared/modelRouting";
import {
  usageForAnthropicWebSearch,
  usageFromAnthropicJson,
  type UsageRecord,
} from "../_shared/pricing";
import {
  CREATE_FILE_TOOL,
  createFileFromToolInput,
  type CreatedFile,
} from "../_shared/createFile";
import {
  GENERATE_IMAGE_TOOL,
} from "../_shared/generateImage";
import { EDIT_IMAGE_TOOL } from "../_shared/editImage";
import type { Env, PagesHandler } from "../_shared/pages";

// Smalltalk-Chat-Endpoint (Cloudflare Pages Functions).
// Analog zur Netlify-Variante: Web-Search-Server-Tool + client-seitiges
// create_file-Tool im Loop. Siehe netlify/functions/smalltalk.ts.

type SmalltalkRequestBody = {
  messages: AnthropicMessage[];
  systemPrompt?: string;
  latestImageUrl?: string | null;
};

const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 5;

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
} as const;

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

// Ergebnis des Loops (siehe Netlify-Variante für Details).
type ToolLoopResult =
  | { kind: "final"; outcome: FetchOutcome }
  | {
      kind: "generate_image_requested";
      prompt: string;
      size: string | null;
    }
  | {
      kind: "edit_image_requested";
      prompt: string;
      sourceImageUrl: string;
    };

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
    if (
      id &&
      (name === "create_file" ||
        name === "generate_image" ||
        name === "edit_image")
    ) {
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
  fileEnv: {
    userId: string;
    accessToken: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
  } | null;
  latestImageUrl: string | null;
}): Promise<ToolLoopResult> {
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
      return { kind: "final", outcome };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
    } catch {
      return { kind: "final", outcome };
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
    const imageUse = toolUses.find((u) => u.name === "generate_image");
    if (imageUse) {
      const input =
        imageUse.input && typeof imageUse.input === "object"
          ? (imageUse.input as Record<string, unknown>)
          : {};
      const prompt =
        typeof input.prompt === "string" ? input.prompt.trim() : "";
      const size =
        typeof input.size === "string" && input.size.trim().length > 0
          ? input.size.trim()
          : null;
      console.log(
        `[smalltalk] short-circuit: generate_image requested (promptLen=${prompt.length}, size=${size ?? "default"})`,
      );
      return { kind: "generate_image_requested", prompt, size };
    }
    const editUse = toolUses.find((u) => u.name === "edit_image");
    if (editUse && opts.latestImageUrl) {
      const input =
        editUse.input && typeof editUse.input === "object"
          ? (editUse.input as Record<string, unknown>)
          : {};
      const prompt =
        typeof input.prompt === "string" ? input.prompt.trim() : "";
      console.log(
        `[smalltalk] short-circuit: edit_image requested (promptLen=${prompt.length})`,
      );
      return {
        kind: "edit_image_requested",
        prompt,
        sourceImageUrl: opts.latestImageUrl,
      };
    }
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
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content:
            "Bildgenerierung wird vom Frontend übernommen – dieses Tool sollte serverseitig nicht ausgeführt werden.",
        });
        continue;
      }

      if (use.name === "edit_image") {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content:
            "Kein Referenzbild in dieser Unterhaltung gefunden. Antworte dem Nutzer stattdessen im Chat, dass er ein Bild anhängen soll, und rufe dieses Tool nicht erneut auf.",
        });
        continue;
      }

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
  return {
    kind: "final",
    outcome: lastOutcome ?? {
      kind: "network-error",
      error: new Error("Tool-Loop ohne Antwort."),
    },
  };
}

async function respondFromOutcome(
  outcome: FetchOutcome,
  ctx: {
    env: Env;
    systemPrompt: string | undefined;
    messages: AnthropicMessage[];
    providerTag: string;
    usageBucket: UsageRecord[];
    createdFiles: CreatedFile[];
  },
): Promise<Response> {
  if (outcome.kind === "response" && outcome.response.ok) {
    try {
      const parsed = JSON.parse(outcome.rawText) as Record<string, unknown>;
      console.log(`[provider=${ctx.providerTag}] Antwort erfolgreich.`);
      const model = typeof parsed.model === "string" ? parsed.model : null;
      return jsonResponse(200, {
        ...parsed,
        _usage: ctx.usageBucket,
        _files: ctx.createdFiles,
        _provider: "anthropic",
        _model: model,
      });
    } catch {
      console.error("Anthropic-Response konnte nicht als JSON geparst werden.");
    }
  }

  if (isAnthropicUnrecoverable(outcome)) {
    const openAIKey = ctx.env.OPENAI_API_KEY;
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
        const shaped = openAIOutcome.anthropicShaped;
        const model =
          typeof shaped.model === "string" ? shaped.model : null;
        return jsonResponse(200, {
          ...shaped,
          _usage: ctx.usageBucket,
          _files: ctx.createdFiles,
          _provider: "openai",
          _model: model,
          _fallback: true,
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
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "ANTHROPIC_API_KEY ist serverseitig nicht konfiguriert.",
    );
  }

  let payload: SmalltalkRequestBody;
  try {
    payload = (await request.json()) as SmalltalkRequestBody;
  } catch {
    return errorResponse(400, "Ungültiges JSON im Request-Body.");
  }

  const { messages, systemPrompt } = payload ?? {};
  const latestImageUrl =
    typeof payload?.latestImageUrl === "string" &&
    payload.latestImageUrl.trim().length > 0
      ? payload.latestImageUrl.trim()
      : null;

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

  const accessToken = readBearer(request);
  const userId = parseJwtSubject(accessToken);
  const supabaseUrl = env.SUPABASE_URL || "";
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || "";
  const fileEnvReady = Boolean(
    accessToken && userId && supabaseUrl && supabaseAnonKey,
  );
  const fileEnv = fileEnvReady
    ? { userId, accessToken, supabaseUrl, supabaseAnonKey }
    : null;

  const webSearchDisabled = env.SMALLTALK_DISABLE_WEB_SEARCH === "1";

  const tools: unknown[] = [];
  if (!webSearchDisabled) tools.push(WEB_SEARCH_TOOL);
  if (fileEnvReady) tools.push(CREATE_FILE_TOOL);
  if (fileEnvReady) tools.push(GENERATE_IMAGE_TOOL);
  if (fileEnvReady && latestImageUrl) tools.push(EDIT_IMAGE_TOOL);

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
      "[smalltalk] create_file/generate_image-Tools nicht aktiv:" +
        ` token=${accessToken ? "yes" : "no"}, userId=${userId ? "yes" : "no"},` +
        ` SUPABASE_URL=${supabaseUrl ? "yes" : "no"}, SUPABASE_ANON_KEY=${supabaseAnonKey ? "yes" : "no"}.`,
    );
  }

  const createdFiles: CreatedFile[] = [];
  const result = await runToolLoop({
    initialBody: anthropicBody,
    apiKey,
    models: selection.models,
    usageBucket,
    providerTag: `claude-smalltalk-${selection.models[0]}`,
    createdFiles,
    fileEnv,
    latestImageUrl,
  });

  if (result.kind === "generate_image_requested") {
    return jsonResponse(200, {
      status: "generating_image",
      imagePrompt: result.prompt,
      imageSize: result.size,
      _usage: usageBucket,
    });
  }
  if (result.kind === "edit_image_requested") {
    return jsonResponse(200, {
      status: "editing_image",
      imagePrompt: result.prompt,
      sourceImageUrl: result.sourceImageUrl,
      _usage: usageBucket,
    });
  }

  return respondFromOutcome(result.outcome, {
    env,
    systemPrompt,
    messages,
    providerTag: `claude-smalltalk-${selection.models[0]}`,
    usageBucket,
    createdFiles,
  });
};
