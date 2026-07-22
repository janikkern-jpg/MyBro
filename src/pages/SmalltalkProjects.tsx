import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { createProject, loadProjects } from "../lib/chat/smalltalk/store";
import type { SmalltalkProject } from "../lib/chat/smalltalk/types";
import { FolderIcon } from "../components/icons";

export default function SmalltalkProjectsPage() {
  const { user } = useAuth();
  const userId = user!.id;

  const [projects, setProjects] = useState<SmalltalkProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const data = await loadProjects(userId);
        if (!cancelled) setProjects(data);
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

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setError(null);
    setCreating(true);
    try {
      const created = await createProject({ userId, name });
      setProjects((prev) => (prev ? [created, ...prev] : [created]));
      setNewName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Anlegen fehlgeschlagen.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <header className="mb-4 pr-12 md:pr-0">
        <h1 className="text-3xl md:text-4xl">Projekte</h1>
        <p className="mt-1 text-sm text-text-muted">
          Bündle zusammengehörige Smalltalk-Unterhaltungen. Unterhaltungen in
          Projekten laufen nicht mehr durch die 30-Tage-Regel.
        </p>
      </header>

      <form
        onSubmit={handleCreate}
        className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Neues Projekt …"
          className="min-h-10 flex-1 rounded-lg border border-border bg-bg-elevated px-3 py-2 text-base text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent md:text-sm"
        />
        <button
          type="submit"
          disabled={!newName.trim() || creating}
          className="inline-flex min-h-10 items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {creating ? "Legt an…" : "Anlegen"}
        </button>
      </form>

      {error ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      {!projects ? (
        <p className="text-sm text-text-muted">Lade…</p>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-bg-elevated/50 p-8 text-center">
          <p className="font-display text-lg text-text">
            Noch keine Projekte.
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Lege oben eins an – z. B. „Reise", „Kochen" oder „Kundenprojekt".
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                to={`/smalltalk/projekte/${encodeURIComponent(p.id)}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-bg-elevated p-4 transition-colors hover:border-accent/60 hover:bg-surface"
              >
                <FolderIcon className="h-6 w-6 shrink-0 text-accent" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text">
                    {p.name}
                  </div>
                  <div className="mt-0.5 text-xs text-text-muted">
                    angelegt {formatDate(p.created_at)}
                  </div>
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
