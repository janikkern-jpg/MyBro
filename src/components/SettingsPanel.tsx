import { useCallback, useEffect, useMemo, useState, type SVGProps } from "react";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { CloseIcon, SettingsIcon } from "./icons";
import { CHARACTER_PRINCIPLES } from "../lib/characterPrinciples";
import { loadPrinciples } from "../lib/chat/smalltalk/store";
import type { SmalltalkPrinciple } from "../lib/chat/smalltalk/types";

type Tab = "mybro" | "smalltalk";

export default function SettingsPanel() {
  const [open, setOpen] = useState(false);

  // Escape schließt
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Einstellungen öffnen"
        className="fixed z-40 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-bg-elevated/90 text-text-muted backdrop-blur transition-colors hover:text-accent"
        style={{
          top: "max(1rem, env(safe-area-inset-top))",
          right: "max(1rem, env(safe-area-inset-right))",
        }}
      >
        <SettingsIcon className="h-5 w-5" aria-hidden="true" />
      </button>

      {open ? <SettingsModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>("mybro");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-3 backdrop-blur-sm sm:p-4 md:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-2 w-full max-w-2xl rounded-2xl border border-border bg-bg-elevated shadow-xl shadow-black/40 sm:my-4">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <h2 id="settings-title" className="font-display text-2xl">
            Einstellungen
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <CloseIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-6 px-4 py-6 sm:px-6">
          <UsageSummary userId={user?.id ?? null} />
          <ProviderStatusBadges />

          <section>
            <h3 className="font-display text-lg text-text">Konto</h3>
            <p className="mt-1 break-all text-sm text-text-muted">
              {user?.email}
            </p>
            <button
              type="button"
              onClick={() => void signOut()}
              className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-bg"
            >
              Abmelden
            </button>
          </section>

          <section className="border-t border-border pt-6">
            <TabSwitcher tab={tab} onChange={setTab} />
            <div className="mt-6">
              {tab === "mybro" ? (
                <MyBroTab />
              ) : (
                <SmalltalkTab userId={user!.id} />
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kompakte Kosten-/Token-Anzeige oben im Panel
// ---------------------------------------------------------------------------

function firstOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function formatUsd(cost: number): string {
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  return n.toLocaleString("de-DE");
}

function UsageSummary({ userId }: { userId: string | null }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; tokens: number; costUsd: number }
    | { kind: "error" }
  >({ kind: "loading" });

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("usage_log")
        .select("input_tokens, output_tokens, estimated_cost_usd")
        .eq("user_id", userId)
        .gte("created_at", firstOfMonthIso());
      if (cancelled) return;
      if (error) {
        console.warn("usage_log-Abfrage fehlgeschlagen:", error);
        setState({ kind: "error" });
        return;
      }
      let tokens = 0;
      let costUsd = 0;
      for (const row of data ?? []) {
        const r = row as {
          input_tokens?: number | null;
          output_tokens?: number | null;
          estimated_cost_usd?: number | null;
        };
        tokens += Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0);
        costUsd += Number(r.estimated_cost_usd ?? 0);
      }
      setState({ kind: "ready", tokens, costUsd });
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <section
      aria-label="Verbrauch diesen Monat"
      className="rounded-lg border border-border bg-bg/60 px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-text-muted">
        <span>Dieser Monat:</span>
        {state.kind === "loading" ? (
          <span className="text-text-muted">…</span>
        ) : state.kind === "error" ? (
          <span className="text-text-muted">–</span>
        ) : (
          <span className="text-text">
            ca. {formatUsd(state.costUsd)}
            <span className="px-1 text-text-muted">·</span>
            {formatTokens(state.tokens)} Tokens
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Geschätzter Wert, kann leicht von der echten Rechnung abweichen –
        genaue Zahlen im Anthropic Console bzw. OpenAI Dashboard.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Verbindungs-Status Anthropic / OpenAI
// ---------------------------------------------------------------------------

type ProviderStatus = {
  connected: boolean;
  configured: boolean;
  error?: string;
};

type StatusPayload = {
  anthropic: ProviderStatus;
  openai: ProviderStatus;
};

type StatusState =
  | { kind: "loading" }
  | { kind: "ready"; data: StatusPayload }
  | { kind: "error"; message: string };

function ProviderStatusBadges() {
  const [state, setState] = useState<StatusState>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch("/api/status", {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        setState({
          kind: "error",
          message: `Statusprüfung fehlgeschlagen (HTTP ${res.status}).`,
        });
        return;
      }
      const data = (await res.json()) as StatusPayload;
      setState({ kind: "ready", data });
    } catch {
      setState({
        kind: "error",
        message: "Statusprüfung fehlgeschlagen.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isLoading = state.kind === "loading";

  return (
    <section
      aria-label="Verbindungsstatus"
      className="rounded-lg border border-border bg-bg/60 px-3 py-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-muted">Verbindungen</span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={isLoading}
          aria-label="Status neu prüfen"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text disabled:opacity-50"
        >
          <RefreshIcon
            className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      <div className="mt-2 space-y-1.5">
        <ProviderStatusRow
          label="Anthropic"
          status={state.kind === "ready" ? state.data.anthropic : null}
          loading={isLoading}
        />
        <ProviderStatusRow
          label="OpenAI"
          status={state.kind === "ready" ? state.data.openai : null}
          loading={isLoading}
        />
      </div>
      {state.kind === "error" ? (
        <p className="mt-2 text-xs text-red-400">{state.message}</p>
      ) : null}
    </section>
  );
}

function ProviderStatusRow({
  label,
  status,
  loading,
}: {
  label: string;
  status: ProviderStatus | null;
  loading: boolean;
}) {
  const { color, pulse, tooltip, note } = describeStatus(status, loading);
  return (
    <div className="flex items-center gap-2">
      <span
        className={[
          "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
          color,
          pulse ? "animate-pulse" : "",
        ].join(" ")}
        title={tooltip}
        aria-label={tooltip}
        role="img"
      />
      <span className="text-sm text-text">{label}</span>
      {note ? (
        <span className="ml-auto truncate text-xs text-text-muted" title={note}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

function describeStatus(
  status: ProviderStatus | null,
  loading: boolean,
): { color: string; pulse: boolean; tooltip: string; note: string | null } {
  if (loading || !status) {
    return {
      color: "bg-text-muted/50",
      pulse: true,
      tooltip: "Wird geprüft …",
      note: null,
    };
  }
  if (!status.configured) {
    return {
      color: "bg-text-muted/40",
      pulse: false,
      tooltip: "Nicht konfiguriert",
      note: "nicht konfiguriert",
    };
  }
  if (status.connected) {
    return {
      color: "bg-emerald-500",
      pulse: false,
      tooltip: "Verbunden",
      note: null,
    };
  }
  const errorText = status.error ?? "Nicht erreichbar.";
  return {
    color: "bg-red-500",
    pulse: false,
    tooltip: errorText,
    note: errorText,
  };
}

function RefreshIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tab-Umschalter
// ---------------------------------------------------------------------------

function TabSwitcher({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const options: { value: Tab; label: string }[] = [
    { value: "mybro", label: "MyBro" },
    { value: "smalltalk", label: "Smalltalk" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Einstellungs-Bereich"
      className="inline-flex rounded-lg border border-border bg-bg p-0.5"
    >
      {options.map((opt) => {
        const active = tab === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-bg shadow-sm"
                : "text-text-muted hover:text-text",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: MyBro
// ---------------------------------------------------------------------------

function MyBroTab() {
  return (
    <div className="space-y-8">
      <section>
        <h3 className="font-display text-lg text-text">Charakter-Prinzipien</h3>
        <p className="mt-1 text-sm text-text-muted">
          Der innere Kompass von <span className="notranslate" translate="no">MyBro</span>.
          Diese sieben Prinzipien sind nur im Code änderbar
          (<code className="rounded bg-bg px-1 py-0.5 text-xs">src/lib/characterPrinciples.ts</code>).
        </p>
        <ol className="mt-4 space-y-4">
          {CHARACTER_PRINCIPLES.map((p, i) => (
            <li
              key={i}
              className="rounded-lg border border-border bg-bg/60 p-4"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-display text-sm text-accent">
                  {i + 1}.
                </span>
                <h4 className="font-display text-base text-text">{p.title}</h4>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-muted">
                {p.text}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <MyBroDangerZone />
    </div>
  );
}

function MyBroDangerZone() {
  const { user } = useAuth();
  const userId = user!.id;
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function handleReset() {
    setResetting(true);
    setError(null);
    try {
      // Reihenfolge: erst FK-Kinder, dann Eltern. RLS filtert bereits auf eigenen user_id,
      // eq('user_id', userId) ergänzt die WHERE-Klausel (Supabase blockt DELETE ohne Filter).
      const deletions = [
        supabase.from("messages").delete().eq("user_id", userId),
        supabase.from("archive").delete().eq("user_id", userId),
        supabase.from("challenge_days").delete().eq("user_id", userId),
        supabase.from("challenges").delete().eq("user_id", userId),
        supabase.from("interaction_dates").delete().eq("user_id", userId),
      ];
      for (const step of deletions) {
        const { error: err } = await step;
        if (err) throw err;
      }

      const { error: profErr } = await supabase
        .from("profiles")
        .update({ onboarding_complete: false })
        .eq("user_id", userId);
      if (profErr) throw profErr;

      // Frisch laden, damit der Chat wieder onboarded und Trigger neu feuert.
      window.location.reload();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Zurücksetzen fehlgeschlagen.",
      );
      setResetting(false);
      setConfirmReset(false);
    }
  }

  return (
    <section className="border-t border-border pt-6">
      <h3 className="font-display text-lg text-red-300">Gefahrenzone</h3>
      <p className="mt-1 text-sm text-text-muted">
        Löscht deinen MyBro-Chatverlauf, alle Archive, alle Challenges und alle
        Interaktionsdaten. Das Onboarding startet neu. Diese Aktion lässt sich
        nicht rückgängig machen.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      {!confirmReset ? (
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
        >
          Alles zurücksetzen…
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm text-red-200">
            Bist du sicher? Chatverlauf, Archiv, Challenges und
            Interaktionsdaten werden gelöscht. Das Onboarding startet neu.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleReset}
              disabled={resetting}
              className="inline-flex min-h-10 items-center rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resetting ? "Setze zurück…" : "Ja, wirklich alles löschen"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-medium text-text-muted hover:text-text"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tab: Smalltalk
// ---------------------------------------------------------------------------

type EditablePrinciple = {
  id: string;
  position: number;
  title: string;
  body: string;
};

function SmalltalkTab({ userId }: { userId: string }) {
  const [rows, setRows] = useState<EditablePrinciple[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    (async () => {
      try {
        const data = await loadPrinciples(userId);
        if (cancelled) return;
        setRows(toEditable(data));
      } catch (err) {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Laden fehlgeschlagen.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const allEmpty = useMemo(() => {
    if (!rows) return true;
    return rows.every((r) => !r.title.trim() && !r.body.trim());
  }, [rows]);

  function updateRow(index: number, patch: Partial<EditablePrinciple>) {
    setRows((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[index] = { ...next[index], ...patch };
      return next;
    });
    setSavedAt(null);
  }

  async function handleSave() {
    if (!rows) return;
    setSaving(true);
    setSaveError(null);
    setSavedAt(null);
    try {
      // Updates einzeln, damit RLS pro Zeile greift und Positionen stabil bleiben.
      for (const row of rows) {
        const { error } = await supabase
          .from("smalltalk_principles")
          .update({
            title: row.title,
            body: row.body,
          })
          .eq("id", row.id);
        if (error) throw error;
      }
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section>
        <h3 className="font-display text-lg text-text">
          Smalltalk-Prinzipien
        </h3>
        <p className="mt-1 text-sm text-text-muted">
          Prägen den Charakter des Smalltalk-Modus. Leer lassen = die KI
          antwortet als neutraler Alltagsassistent.
        </p>

        {loadError ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            {loadError}
          </p>
        ) : null}

        {!rows ? (
          <p className="mt-4 text-sm text-text-muted">Lade Prinzipien…</p>
        ) : (
          <>
            <ol className="mt-4 space-y-4">
              {rows.map((row, i) => (
                <li
                  key={row.id}
                  className="rounded-lg border border-border bg-bg/60 p-4"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-display text-sm text-accent">
                      {i + 1}.
                    </span>
                    <label
                      className="block flex-1 text-xs uppercase tracking-wide text-text-muted"
                      htmlFor={`st-title-${row.id}`}
                    >
                      Titel
                    </label>
                  </div>
                  <input
                    id={`st-title-${row.id}`}
                    type="text"
                    value={row.title}
                    onChange={(e) => updateRow(i, { title: e.target.value })}
                    placeholder="z. B. Denke wie ein Ingenieur"
                    className="mt-1 w-full rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />

                  <label
                    className="mt-3 block text-xs uppercase tracking-wide text-text-muted"
                    htmlFor={`st-body-${row.id}`}
                  >
                    Text
                  </label>
                  <textarea
                    id={`st-body-${row.id}`}
                    value={row.body}
                    onChange={(e) => updateRow(i, { body: e.target.value })}
                    rows={3}
                    placeholder="Wie soll dieser Grundsatz das Gespräch färben?"
                    className="mt-1 min-h-20 w-full resize-y rounded-md border border-border bg-bg-elevated px-3 py-2 text-sm leading-relaxed text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                </li>
              ))}
            </ol>

            {saveError ? (
              <p
                role="alert"
                className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
              >
                {saveError}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex min-h-10 items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Speichert…" : "Speichern"}
              </button>
              {savedAt ? (
                <span className="text-xs text-text-muted">
                  Gespeichert{allEmpty ? " – alle Felder leer" : ""}.
                </span>
              ) : null}
            </div>
          </>
        )}
      </section>

      <SmalltalkDangerZone userId={userId} />
    </div>
  );
}

function toEditable(rows: SmalltalkPrinciple[]): EditablePrinciple[] {
  // Kopiert nur die editierbaren Felder in eine flache Struktur, sortiert nach position.
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({
      id: r.id,
      position: r.position,
      title: r.title ?? "",
      body: r.body ?? "",
    }));
}

function SmalltalkDangerZone({ userId }: { userId: string }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    setDoneAt(null);
    try {
      // st_messages werden per FK ON DELETE CASCADE mitgelöscht.
      const { error: err } = await supabase
        .from("st_conversations")
        .delete()
        .eq("user_id", userId);
      if (err) throw err;
      setDoneAt(Date.now());
      setConfirmDelete(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Löschen fehlgeschlagen.",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="border-t border-border pt-6">
      <h3 className="font-display text-lg text-red-300">
        Smalltalk-Verlauf löschen
      </h3>
      <p className="mt-1 text-sm text-text-muted">
        Löscht alle Smalltalk-Unterhaltungen und Nachrichten. Projekte,
        Prinzipien und der MyBro-Verlauf bleiben unangetastet. Nicht
        umkehrbar.
      </p>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      {doneAt ? (
        <p className="mt-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Smalltalk-Verlauf gelöscht.
        </p>
      ) : null}

      {!confirmDelete ? (
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          className="mt-4 inline-flex min-h-10 items-center rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20"
        >
          Smalltalk-Verlauf löschen…
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4">
          <p className="text-sm text-red-200">
            Alle Smalltalk-Unterhaltungen und Nachrichten werden dauerhaft
            gelöscht. Sicher?
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex min-h-10 items-center rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? "Lösche…" : "Ja, Verlauf löschen"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-medium text-text-muted hover:text-text"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
