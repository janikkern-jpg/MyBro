import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { loadRecentConversations } from "../lib/chat/smalltalk/store";
import type { SmalltalkConversation } from "../lib/chat/smalltalk/types";

export default function SmalltalkRecentPage() {
  const { user } = useAuth();
  const userId = user!.id;

  const [conversations, setConversations] = useState<
    SmalltalkConversation[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const data = await loadRecentConversations(userId);
        if (!cancelled) setConversations(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Laden fehlgeschlagen.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <div>
      <header className="mb-4 pr-12 md:pr-0">
        <h1 className="text-3xl md:text-4xl">Zuletzt verwendet</h1>
        <p className="mt-1 text-sm text-text-muted">
          Deine Smalltalk-Unterhaltungen der letzten 30 Tage. Sobald du eine
          Unterhaltung einem Projekt zuordnest, verschwindet sie hier und ist
          nur noch im Projekt sichtbar.
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      {!conversations ? (
        <p className="text-sm text-text-muted">Lade…</p>
      ) : conversations.length === 0 ? (
        <EmptyState />
      ) : (
        <ConversationList conversations={conversations} />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-bg-elevated/50 p-8 text-center">
      <p className="font-display text-lg text-text">Noch nichts hier.</p>
      <p className="mt-2 text-sm text-text-muted">
        Starte eine neue Unterhaltung im Chat – sie landet automatisch hier,
        bis du sie einem Projekt zuweist.
      </p>
      <Link
        to="/chat"
        className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover"
      >
        Zum Chat
      </Link>
    </div>
  );
}

export function ConversationList({
  conversations,
}: {
  conversations: SmalltalkConversation[];
}) {
  return (
    <ul className="space-y-2">
      {conversations.map((c) => (
        <li key={c.id}>
          <Link
            to={`/chat?conversation=${encodeURIComponent(c.id)}`}
            className="block rounded-lg border border-border bg-bg-elevated px-4 py-3 transition-colors hover:border-accent/60 hover:bg-surface"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                {(c.title ?? "").trim() || "Ohne Titel"}
              </span>
              <span className="whitespace-nowrap text-xs text-text-muted">
                {formatDate(c.created_at)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
