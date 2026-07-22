import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  loadProject,
  loadProjectConversations,
} from "../lib/chat/smalltalk/store";
import type {
  SmalltalkConversation,
  SmalltalkProject,
} from "../lib/chat/smalltalk/types";

export default function SmalltalkProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<SmalltalkProject | null>(null);
  const [conversations, setConversations] = useState<
    SmalltalkConversation[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setError(null);
    setProject(null);
    setConversations(null);

    (async () => {
      try {
        const [proj, convs] = await Promise.all([
          loadProject(projectId),
          loadProjectConversations(projectId),
        ]);
        if (cancelled) return;
        setProject(proj);
        setConversations(convs);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Laden fehlgeschlagen.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div>
      <header className="mb-4 pr-12 md:pr-0">
        <Link
          to="/smalltalk/projekte"
          className="text-xs text-text-muted transition-colors hover:text-text"
        >
          ← Projekte
        </Link>
        <h1 className="mt-1 text-3xl md:text-4xl">
          {project?.name ?? (project === null && conversations ? "Projekt nicht gefunden" : "…")}
        </h1>
        {project ? (
          <p className="mt-1 text-sm text-text-muted">
            Alle Unterhaltungen in diesem Projekt, unabhängig vom Alter.
          </p>
        ) : null}
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
        <div className="rounded-2xl border border-dashed border-border bg-bg-elevated/50 p-8 text-center">
          <p className="font-display text-lg text-text">
            Noch keine Unterhaltungen.
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Starte im Chat eine neue Unterhaltung und wähle „Zu Projekt
            hinzufügen…", um sie hier abzulegen.
          </p>
          <Link
            to="/chat"
            className="mt-4 inline-flex min-h-10 items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover"
          >
            Zum Chat
          </Link>
        </div>
      ) : (
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
                    aktualisiert {formatDate(c.updated_at)}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
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
