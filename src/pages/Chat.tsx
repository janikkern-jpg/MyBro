import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useAuth } from "../lib/auth";
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
    async (text: string) => {
      setError(null);
      const trimmed = text.trim();
      if (!trimmed) return;
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
      } catch (err) {
        console.error(err);
        setError(errorMessage(err));
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

  // VisualViewport: hält den Composer auf iOS/Android über der
  // Bildschirmtastatur sichtbar, indem die effektive Viewport-Höhe
  // als CSS-Variable --vvh am <html> gepflegt wird.
  useEffect(() => {
    const vv =
      typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const setVh = () => {
      document.documentElement.style.setProperty(
        "--vvh",
        `${vv.height}px`,
      );
    };
    setVh();
    vv.addEventListener("resize", setVh);
    vv.addEventListener("scroll", setVh);
    return () => {
      vv.removeEventListener("resize", setVh);
      vv.removeEventListener("scroll", setVh);
      document.documentElement.style.removeProperty("--vvh");
    };
  }, []);

  const visibleMessages = useMemo(
    () => messages.filter(isVisibleMessage),
    [messages],
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (isSending) return;
    const value = input;
    setInput("");
    await sendUserMessage(value);
  }

  return (
    <div className="h-chat-shell flex flex-col">
      <header className="mb-4 flex items-baseline justify-between pr-12 md:pr-0">
        <h1 className="text-3xl md:text-4xl">Chat</h1>
        {!ready ? (
          <span className="text-xs text-text-muted">lade…</span>
        ) : null}
      </header>

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
          className="min-h-10 max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg-elevated px-3 py-2 text-base leading-relaxed outline-none focus:border-accent focus:ring-1 focus:ring-accent md:text-sm"
          disabled={isSending || !ready}
        />
        <button
          type="submit"
          disabled={isSending || !ready || !input.trim()}
          className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          Senden
        </button>
      </form>
    </div>
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

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  if (err instanceof Error) return err.message;
  return "Etwas ist schiefgelaufen.";
}
