import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useMode, type ChatMode } from "../lib/mode";
import { supabase } from "../lib/supabase";
import { callChatFunction } from "../lib/chat/api";
import { buildSystemPrompt } from "../lib/chat/systemPrompt";
import { CHAT_TOOLS, executeTool, type ToolContext } from "../lib/chat/tools";
import {
  SYSTEM_TRIGGER_PREFIX,
  type ApiMessage,
  type ArchiveEntry,
  type Challenge,
  type ChallengeDay,
  type ContentBlock,
  type DbMessage,
  type Profile,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "../lib/chat/types";
import {
  callSmalltalkImage,
  callSmalltalkText,
  extractAssistantText,
} from "../lib/chat/smalltalk/api";
import { detectImageIntent, extractImagePrompt } from "../lib/chat/smalltalk/intent";
import { buildSmalltalkSystemPrompt } from "../lib/chat/smalltalk/systemPrompt";
import { logUsageFromResponse } from "../lib/usage";
import {
  assignConversationToProject,
  buildAutoTitle,
  createConversation,
  createProject,
  insertMessage,
  loadConversation,
  loadPrinciples,
  loadProject,
  loadProjects,
} from "../lib/chat/smalltalk/store";
import type {
  SmalltalkConversation,
  SmalltalkMessage,
  SmalltalkPrinciple,
  SmalltalkProject,
  StApiMessage,
} from "../lib/chat/smalltalk/types";

const ONBOARDING_TRIGGER =
  "[Systemhinweis: Eröffne jetzt ein ruhiges Kennenlerngespräch. Begrüße kurz und warm und stelle eine erste offene Frage.]";
const DAILY_TRIGGER =
  "[Systemhinweis: Neuer Tag. Melde dich proaktiv als täglicher Coach mit einer kurzen, warmen Meldung und einer passenden Frage, die zum bisherigen Verlauf passt.]";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function isVisibleMessage(m: DbMessage): boolean {
  return !m.content.startsWith(SYSTEM_TRIGGER_PREFIX);
}

function dbToApi(msgs: DbMessage[]): ApiMessage[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

export default function ChatPage() {
  const { mode, setMode, loading: modeLoading } = useMode();

  return (
    <div className="h-chat-shell flex flex-col">
      <ChatHeader mode={mode} onModeChange={setMode} disabled={modeLoading} />
      {mode === "smalltalk" ? <SmalltalkChat /> : <MyBroChat />}
    </div>
  );
}

function ChatHeader({
  mode,
  onModeChange,
  disabled,
}: {
  mode: ChatMode;
  onModeChange: (m: ChatMode) => Promise<void> | void;
  disabled: boolean;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3 pr-12 md:pr-0">
      <h1 className="text-3xl md:text-4xl">Chat</h1>
      <ModeSwitcher mode={mode} onChange={onModeChange} disabled={disabled} />
    </header>
  );
}

function ModeSwitcher({
  mode,
  onChange,
  disabled,
}: {
  mode: ChatMode;
  onChange: (m: ChatMode) => Promise<void> | void;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const options: { value: ChatMode; label: string }[] = [
    { value: "mybro", label: "MyBro" },
    { value: "smalltalk", label: "Smalltalk" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Chat-Modus"
      className="inline-flex rounded-lg border border-border bg-bg-elevated p-0.5"
    >
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled || active}
            onClick={() => {
              if (active) return;
              // URL beim Modus-Wechsel bewusst zurücksetzen, damit ein alter
              // ?conversation=… nicht ungewollt wiederbelebt wird und der
              // Smalltalk-Modus wirklich immer leer startet.
              navigate("/chat", { replace: false });
              void onChange(opt.value);
            }}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-bg shadow-sm"
                : "text-text-muted hover:text-text disabled:cursor-not-allowed",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SmalltalkChat() {
  const { user } = useAuth();
  const userId = user!.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationIdFromUrl = searchParams.get("conversation");

  const [principles, setPrinciples] = useState<SmalltalkPrinciple[]>([]);
  const [conversation, setConversation] = useState<SmalltalkConversation | null>(
    null,
  );
  const [currentProject, setCurrentProject] = useState<SmalltalkProject | null>(
    null,
  );
  const [messages, setMessages] = useState<SmalltalkMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bootRef = useRef<string | null>(null);

  const systemPrompt = useMemo(
    () => buildSmalltalkSystemPrompt(principles),
    [principles],
  );

  // Initialisierung: Prinzipien immer laden; wenn ?conversation=… in der
  // URL steht (typisch nach Klick aus "Zuletzt verwendet"/"Projekte"), die
  // Konversation nachladen. Ohne Query bleibt der Chat leer – jeder
  // Neu-Einstieg in Smalltalk startet frisch.
  useEffect(() => {
    // Verhindere Doppel-Init für dieselbe URL (StrictMode etc.).
    const bootKey = conversationIdFromUrl ?? "__empty__";
    if (bootRef.current === bootKey) return;
    bootRef.current = bootKey;

    let cancelled = false;
    setReady(false);
    setError(null);

    (async () => {
      try {
        const loadedPrinciples = await loadPrinciples(userId);
        if (cancelled) return;
        setPrinciples(loadedPrinciples);

        if (conversationIdFromUrl) {
          const { conversation: conv, messages: msgs } = await loadConversation(
            conversationIdFromUrl,
          );
          if (cancelled) return;
          setConversation(conv);
          setMessages(msgs);
          if (conv?.project_id) {
            const proj = await loadProject(conv.project_id);
            if (cancelled) return;
            setCurrentProject(proj);
          } else {
            setCurrentProject(null);
          }
        } else {
          setConversation(null);
          setMessages([]);
          setCurrentProject(null);
        }
        setReady(true);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError(errorMessage(err));
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, conversationIdFromUrl]);

  // Auto-Scroll ans Ende bei neuen Nachrichten
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isSending]);

  const ensureConversation = useCallback(
    async (firstMessage: string): Promise<SmalltalkConversation> => {
      if (conversation) return conversation;
      const created = await createConversation({
        userId,
        title: buildAutoTitle(firstMessage),
      });
      setConversation(created);
      // URL an neue Unterhaltung koppeln, damit Refresh nicht in einen
      // leeren Chat fällt und die Konversation für spätere Deep-Links stabil ist.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("conversation", created.id);
          return next;
        },
        { replace: true },
      );
      return created;
    },
    [conversation, userId, setSearchParams],
  );

  const sendMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      setError(null);
      setIsSending(true);
      try {
        const conv = await ensureConversation(trimmed);
        const userRow = await insertMessage({
          conversationId: conv.id,
          role: "user",
          content: trimmed,
        });
        setMessages((prev) => [...prev, userRow]);

        // ---- Bild-Wunsch? ----------------------------------------------
        if (detectImageIntent(trimmed)) {
          const imagePrompt = extractImagePrompt(trimmed);
          const imgResp = await callSmalltalkImage({ prompt: imagePrompt });
          void logUsageFromResponse(userId, imgResp);
          const { imageUrl } = imgResp;
          const assistantRow = await insertMessage({
            conversationId: conv.id,
            role: "assistant",
            content: `Hier ist das Bild zu: „${imagePrompt}"`,
            imageUrl,
          });
          setMessages((prev) => [...prev, assistantRow]);
          return true;
        }

        // ---- Text-Antwort (Anthropic mit Klassifikator + OpenAI-Fallback) ----
        // Kein Kontext aus anderen Unterhaltungen – nur der aktuelle Verlauf.
        const apiMessages: StApiMessage[] = [
          ...messages.map<StApiMessage>((m) => ({
            role: m.role,
            content: m.content,
          })),
          { role: "user", content: trimmed },
        ];
        const response = await callSmalltalkText({
          messages: apiMessages,
          systemPrompt,
        });
        void logUsageFromResponse(userId, response);
        const assistantText = extractAssistantText(response);
        if (assistantText) {
          const assistantRow = await insertMessage({
            conversationId: conv.id,
            role: "assistant",
            content: assistantText,
          });
          setMessages((prev) => [...prev, assistantRow]);
        }
        return true;
      } catch (err) {
        console.error(err);
        setError("Senden fehlgeschlagen, versuch's nochmal.");
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [ensureConversation, messages, systemPrompt],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSending) return;
    const value = input;
    if (!value.trim()) return;
    const ok = await sendMessage(value);
    // Eingabetext erst nach erfolgreichem Senden verwerfen – bei
    // Netzwerk-/Serverfehlern bleibt der Text im Feld, damit der Nutzer
    // direkt erneut auf Senden klicken kann.
    if (ok) setInput("");
  }

  return (
    <>
      {conversation ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate text-text-muted">
            {(conversation.title ?? "").trim() || "Neue Unterhaltung"}
          </span>
          <button
            type="button"
            onClick={() => setProjectDialogOpen(true)}
            className={[
              "inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              currentProject
                ? "border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
                : "border-border bg-bg-elevated text-text-muted hover:border-accent/40 hover:text-text",
            ].join(" ")}
          >
            {currentProject
              ? `Projekt: ${currentProject.name}`
              : "Zu Projekt hinzufügen…"}
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto pr-1"
        aria-live="polite"
      >
        {ready && messages.length === 0 && !isSending ? (
          <p className="text-sm text-text-muted">
            Neue Unterhaltung. Schreib etwas – wir plaudern einfach.
          </p>
        ) : null}

        {messages.map((m) => (
          <SmalltalkBubble
            key={m.id}
            role={m.role}
            content={m.content}
            imageUrl={m.image_url}
          />
        ))}

        {isSending ? <TypingIndicator /> : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(e as unknown as FormEvent<HTMLFormElement>);
            }
          }}
          rows={1}
          placeholder="Schreib etwas oder bitte um ein Bild …"
          className="min-h-10 max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg-elevated px-3 py-2 text-base leading-relaxed outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-wait disabled:opacity-70 md:text-sm"
          disabled={isSending || !ready}
        />
        <button
          type="submit"
          disabled={isSending || !ready || !input.trim()}
          className="inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSending ? <Spinner /> : null}
          <span>Senden</span>
        </button>
      </form>

      {projectDialogOpen && conversation ? (
        <AddToProjectDialog
          userId={userId}
          conversation={conversation}
          currentProject={currentProject}
          onClose={() => setProjectDialogOpen(false)}
          onAssigned={(updatedConv, project) => {
            setConversation(updatedConv);
            setCurrentProject(project);
            setProjectDialogOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SmalltalkBubble({
  role,
  content,
  imageUrl,
}: {
  role: "user" | "assistant";
  content: string;
  imageUrl: string | null;
}) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "rounded-br-md bg-accent text-bg"
            : "rounded-bl-md border border-border bg-bg-elevated text-text",
        ].join(" ")}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={content || "Generiertes Bild"}
            className="mb-2 max-w-full rounded-lg"
            loading="lazy"
          />
        ) : null}
        {content ? <div>{content}</div> : null}
      </div>
    </div>
  );
}

function AddToProjectDialog({
  userId,
  conversation,
  currentProject,
  onClose,
  onAssigned,
}: {
  userId: string;
  conversation: SmalltalkConversation;
  currentProject: SmalltalkProject | null;
  onClose: () => void;
  onAssigned: (
    conversation: SmalltalkConversation,
    project: SmalltalkProject | null,
  ) => void;
}) {
  const [projects, setProjects] = useState<SmalltalkProject[] | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await loadProjects(userId);
        if (!cancelled) setProjects(data);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : "Laden fehlgeschlagen.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Escape schließt
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function assignTo(project: SmalltalkProject | null) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await assignConversationToProject({
        conversationId: conversation.id,
        projectId: project?.id ?? null,
      });
      onAssigned(updated, project);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Zuordnung fehlgeschlagen.");
      setBusy(false);
    }
  }

  async function handleCreateAndAssign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await createProject({ userId, name });
      const updated = await assignConversationToProject({
        conversationId: conversation.id,
        projectId: created.id,
      });
      onAssigned(updated, created);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Anlegen fehlgeschlagen.");
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-to-project-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:p-4 md:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-2 w-full max-w-md rounded-2xl border border-border bg-bg-elevated shadow-xl shadow-black/40 sm:my-4">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="add-to-project-title" className="font-display text-lg">
            Zu Projekt hinzufügen
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            ×
          </button>
        </header>

        <div className="space-y-5 px-4 py-4">
          {err ? (
            <p
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
            >
              {err}
            </p>
          ) : null}

          <section>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
              Bestehendes Projekt
            </h3>
            {!projects ? (
              <p className="text-sm text-text-muted">Lade Projekte…</p>
            ) : projects.length === 0 ? (
              <p className="text-sm text-text-muted">
                Noch keine Projekte. Leg unten eins an.
              </p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-y-auto">
                {projects.map((p) => {
                  const isCurrent = currentProject?.id === p.id;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => void assignTo(p)}
                        disabled={busy || isCurrent}
                        className={[
                          "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors",
                          isCurrent
                            ? "cursor-default border-accent/40 bg-accent/10 text-accent"
                            : "border-border bg-bg text-text hover:border-accent/40 hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60",
                        ].join(" ")}
                      >
                        <span className="min-w-0 truncate">{p.name}</span>
                        {isCurrent ? (
                          <span className="ml-2 text-xs">aktuell</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="border-t border-border pt-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
              Neues Projekt
            </h3>
            <form onSubmit={handleCreateAndAssign} className="flex gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Projektname"
                className="min-h-10 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
              <button
                type="submit"
                disabled={!newName.trim() || busy}
                className="inline-flex min-h-10 items-center rounded-md bg-accent px-3 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                Anlegen & zuweisen
              </button>
            </form>
          </section>

          {currentProject ? (
            <section className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => void assignTo(null)}
                disabled={busy}
                className="text-sm text-text-muted transition-colors hover:text-text disabled:cursor-not-allowed"
              >
                Aus aktuellem Projekt entfernen
              </button>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MyBroChat() {
  const { user } = useAuth();
  const userId = user!.id;

  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [archive, setArchive] = useState<ArchiveEntry[]>([]);
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [challengeDays, setChallengeDays] = useState<ChallengeDay[]>([]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const bootRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ---------- Loader / Refresher ----------

  const loadMessages = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: true });
    if (err) throw err;
    setMessages((data ?? []) as DbMessage[]);
  }, []);

  const loadProfile = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (err) throw err;
    setProfile((data ?? null) as Profile | null);
  }, [userId]);

  const loadArchive = useCallback(async () => {
    const { data, error: err } = await supabase
      .from("archive")
      .select("*")
      .order("archived_at", { ascending: false })
      .limit(20);
    if (err) throw err;
    setArchive((data ?? []) as ArchiveEntry[]);
  }, []);

  const loadChallenges = useCallback(async () => {
    const { data: chs, error: e1 } = await supabase
      .from("challenges")
      .select("*")
      .eq("active", true)
      .order("created_at", { ascending: true });
    if (e1) throw e1;
    const { data: days, error: e2 } = await supabase
      .from("challenge_days")
      .select("*");
    if (e2) throw e2;
    setChallenges((chs ?? []) as Challenge[]);
    setChallengeDays((days ?? []) as ChallengeDay[]);
  }, []);

  const toolContext = useMemo<ToolContext>(
    () => ({
      userId,
      refreshProfile: loadProfile,
      refreshChallenges: loadChallenges,
      refreshMessages: loadMessages,
      refreshArchive: loadArchive,
    }),
    [userId, loadProfile, loadChallenges, loadMessages, loadArchive],
  );

  // ---------- Tool-Loop ----------

  const runAssistantTurn = useCallback(
    async (
      convo: ApiMessage[],
      promptInput: Parameters<typeof buildSystemPrompt>[0],
    ): Promise<string> => {
      const systemPrompt = buildSystemPrompt(promptInput);

      let guard = 6;
      let working = convo;

      while (guard-- > 0) {
        const response = await callChatFunction({
          messages: working,
          systemPrompt,
          tools: CHAT_TOOLS as unknown as unknown[],
        });

        // Kosten-/Token-Tracking (siehe usage_log). Bewusst fire-and-
        // forget: der Chat soll nicht scheitern, wenn nur das Logging
        // klemmt.
        void logUsageFromResponse(userId, response);

        const blocks = (response.content ?? []) as ContentBlock[];
        const toolUses = blocks.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );

        if (toolUses.length === 0) {
          const text = blocks
            .filter((b): b is TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n\n")
            .trim();
          return text;
        }

        // Assistant-Turn mit Tool-Blöcken in den Verlauf aufnehmen (in-memory).
        working = [...working, { role: "assistant", content: blocks }];

        // Tools nacheinander ausführen.
        const resultBlocks: ToolResultBlock[] = [];
        for (const tu of toolUses) {
          const outcome = await executeTool(tu.name, tu.input, toolContext);
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: outcome.text,
            is_error: !outcome.ok,
          });
        }
        working = [...working, { role: "user", content: resultBlocks }];
      }

      throw new Error("Tool-Loop-Limit erreicht.");
    },
    [toolContext],
  );

  const persistAndAppend = useCallback(
    async (role: "user" | "assistant", content: string) => {
      const { data, error: err } = await supabase
        .from("messages")
        .insert({ user_id: userId, role, content })
        .select("*")
        .single();
      if (err || !data) throw err ?? new Error("Insert messages fehlgeschlagen.");
      setMessages((prev) => [...prev, data as DbMessage]);
      return data as DbMessage;
    },
    [userId],
  );

  // ---------- Öffentliche Aktionen ----------

  const sendUserMessage = useCallback(
    async (text: string): Promise<boolean> => {
      setError(null);
      const trimmed = text.trim();
      if (!trimmed) return false;
      setIsSending(true);
      try {
        await persistAndAppend("user", trimmed);
        const { data: latest } = await supabase
          .from("messages")
          .select("*")
          .order("created_at", { ascending: true });
        const convo = dbToApi((latest ?? []) as DbMessage[]);
        const assistantText = await runAssistantTurn(convo, {
          profile,
          archive,
          challenges,
          challengeDays,
          todayIso: todayIso(),
        });
        if (assistantText) {
          await persistAndAppend("assistant", assistantText);
        }
        await loadMessages();
        return true;
      } catch (err) {
        console.error(err);
        setError("Senden fehlgeschlagen, versuch's nochmal.");
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [
      persistAndAppend,
      runAssistantTurn,
      loadMessages,
      profile,
      archive,
      challenges,
      challengeDays,
    ],
  );

  // ---------- Initialisierung ----------

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;

    (async () => {
      try {
        // Alles parallel laden
        const [
          msgsRes,
          profRes,
          archRes,
          chalRes,
          chalDaysRes,
          todayIntRes,
        ] = await Promise.all([
          supabase
            .from("messages")
            .select("*")
            .order("created_at", { ascending: true }),
          supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle(),
          supabase
            .from("archive")
            .select("*")
            .order("archived_at", { ascending: false })
            .limit(20),
          supabase.from("challenges").select("*").eq("active", true),
          supabase.from("challenge_days").select("*"),
          supabase
            .from("interaction_dates")
            .select("date")
            .eq("date", todayIso())
            .maybeSingle(),
        ]);

        const loadedMsgs = (msgsRes.data ?? []) as DbMessage[];
        const loadedProfile = (profRes.data ?? null) as Profile | null;
        const loadedArchive = (archRes.data ?? []) as ArchiveEntry[];
        const loadedChallenges = (chalRes.data ?? []) as Challenge[];
        const loadedChallengeDays = (chalDaysRes.data ?? []) as ChallengeDay[];
        const seenToday = !!todayIntRes.data;

        setMessages(loadedMsgs);
        setProfile(loadedProfile);
        setArchive(loadedArchive);
        setChallenges(loadedChallenges);
        setChallengeDays(loadedChallengeDays);

        // Heute in interaction_dates markieren (idempotent per unique-Constraint).
        await supabase
          .from("interaction_dates")
          .upsert(
            { user_id: userId, date: todayIso() },
            { onConflict: "user_id,date", ignoreDuplicates: true },
          );

        setReady(true);

        // Trigger-Logik: nur wenn letzte DB-Nachricht KEIN user-Turn ist,
        // sonst würden zwei user-Turns in Folge entstehen.
        const last = loadedMsgs[loadedMsgs.length - 1];
        const canTrigger = !last || last.role === "assistant";
        const onboardingOpen = !(loadedProfile?.onboarding_complete === true);

        let triggerText: string | null = null;
        if (canTrigger && onboardingOpen && loadedMsgs.length === 0) {
          triggerText = ONBOARDING_TRIGGER;
        } else if (
          canTrigger &&
          !onboardingOpen &&
          !seenToday &&
          loadedMsgs.length > 0
        ) {
          triggerText = DAILY_TRIGGER;
        }

        if (triggerText) {
          setIsSending(true);
          try {
            await persistAndAppend("user", triggerText);
            const convo: ApiMessage[] = [
              ...dbToApi(loadedMsgs),
              { role: "user", content: triggerText },
            ];
            const assistantText = await runAssistantTurn(convo, {
              profile: loadedProfile,
              archive: loadedArchive,
              challenges: loadedChallenges,
              challengeDays: loadedChallengeDays,
              todayIso: todayIso(),
            });
            if (assistantText) {
              await persistAndAppend("assistant", assistantText);
            }
            await loadMessages();
          } finally {
            setIsSending(false);
          }
        }
      } catch (err) {
        console.error(err);
        setError(errorMessage(err));
        setReady(true);
      }
    })();
  }, [userId, persistAndAppend, runAssistantTurn, loadMessages]);

  // Auto-Scroll ans Ende
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isSending]);

  const visibleMessages = useMemo(
    () => messages.filter(isVisibleMessage),
    [messages],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSending) return;
    const value = input;
    if (!value.trim()) return;
    const ok = await sendUserMessage(value);
    // Eingabetext erst nach erfolgreichem Senden verwerfen – bei
    // Netzwerk-/Serverfehlern bleibt der Text im Feld, damit der Nutzer
    // direkt erneut auf Senden klicken kann.
    if (ok) setInput("");
  }

  return (
    <>
      {!ready ? (
        <div className="mb-2 text-xs text-text-muted">lade…</div>
      ) : null}

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto pr-1"
        aria-live="polite"
      >
        {ready && visibleMessages.length === 0 && !isSending ? (
          <p className="text-sm text-text-muted">
            Noch keine Nachrichten. Schreib etwas – <span className="notranslate" translate="no">MyBro</span> hört zu.
          </p>
        ) : null}

        {visibleMessages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} />
        ))}

        {isSending ? <TypingIndicator /> : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(e as unknown as FormEvent<HTMLFormElement>);
            }
          }}
          rows={1}
          placeholder="Schreib etwas … (Enter = senden, Shift+Enter = neue Zeile)"
          className="min-h-10 max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg-elevated px-3 py-2 text-base leading-relaxed outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:cursor-wait disabled:opacity-70 md:text-sm"
          disabled={isSending || !ready}
        />
        <button
          type="submit"
          disabled={isSending || !ready || !input.trim()}
          className="inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSending ? <Spinner /> : null}
          <span>Senden</span>
        </button>
      </form>
    </>
  );
}

// ---------- kleine UI-Bausteine ----------

function MessageBubble({
  role,
  content,
}: {
  role: "user" | "assistant";
  content: string;
}) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "rounded-br-md bg-accent text-bg"
            : "rounded-bl-md border border-border bg-bg-elevated text-text",
        ].join(" ")}
      >
        {content}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-border bg-bg-elevated px-4 py-3">
        <Dot delay="0ms" />
        <Dot delay="150ms" />
        <Dot delay="300ms" />
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted"
      style={{ animationDelay: delay }}
    />
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-bg/30 border-t-bg"
      aria-hidden="true"
    />
  );
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  if (err instanceof Error) return err.message;
  return "Etwas ist schiefgelaufen.";
}
