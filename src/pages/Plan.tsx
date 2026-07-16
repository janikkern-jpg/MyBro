import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Challenge, ChallengeDay } from "../lib/chat/types";

type TaskEntry = {
  dayId: string;
  challengeId: string;
  challengeTitle: string;
  task: string;
  done: boolean;
};

type DayEntry = {
  date: string; // YYYY-MM-DD
  tasks: TaskEntry[];
};

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
});

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return DATE_FORMAT.format(new Date(y, m - 1, d));
}

export default function PlanPage() {
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [days, setDays] = useState<ChallengeDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const todayRef = useRef<HTMLLIElement | null>(null);
  const scrolledOnce = useRef(false);

  const todayIso = useMemo(() => toIsoDate(new Date()), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [chRes, dayRes] = await Promise.all([
        supabase
          .from("challenges")
          .select("*")
          .eq("active", true)
          .order("created_at", { ascending: true }),
        supabase.from("challenge_days").select("*"),
      ]);
      if (chRes.error) throw chRes.error;
      if (dayRes.error) throw dayRes.error;
      setChallenges((chRes.data ?? []) as Challenge[]);
      setDays((dayRes.data ?? []) as ChallengeDay[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Laden fehlgeschlagen.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped: DayEntry[] = useMemo(() => {
    const activeIds = new Set(challenges.map((c) => c.id));
    const titleById = new Map(challenges.map((c) => [c.id, c.title] as const));
    const map = new Map<string, TaskEntry[]>();

    for (const d of days) {
      if (!activeIds.has(d.challenge_id)) continue; // nur zu aktiven Challenges
      const task = (d.task ?? "").trim();
      if (!task) continue;
      const list = map.get(d.date) ?? [];
      list.push({
        dayId: d.id,
        challengeId: d.challenge_id,
        challengeTitle: titleById.get(d.challenge_id) ?? "Challenge",
        task,
        done: d.done,
      });
      map.set(d.date, list);
    }

    return Array.from(map.entries())
      .map(([date, tasks]) => ({
        date,
        tasks: tasks.slice().sort((a, b) =>
          a.challengeTitle.localeCompare(b.challengeTitle, "de"),
        ),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [challenges, days]);

  const totals = useMemo(() => {
    let total = 0;
    let done = 0;
    for (const g of grouped) {
      for (const t of g.tasks) {
        total++;
        if (t.done) done++;
      }
    }
    return { total, done };
  }, [grouped]);

  // Beim ersten Render zum heutigen Tag scrollen (falls vorhanden).
  useEffect(() => {
    if (scrolledOnce.current) return;
    if (loading) return;
    if (!todayRef.current) return;
    scrolledOnce.current = true;
    todayRef.current.scrollIntoView({ block: "center", behavior: "auto" });
  }, [loading, grouped]);

  async function toggleDone(dayId: string, next: boolean) {
    setError(null);
    // Optimistic
    setDays((prev) =>
      prev.map((d) => (d.id === dayId ? { ...d, done: next } : d)),
    );
    setPendingIds((prev) => {
      const s = new Set(prev);
      s.add(dayId);
      return s;
    });

    const { error: err } = await supabase
      .from("challenge_days")
      .update({ done: next })
      .eq("id", dayId);

    setPendingIds((prev) => {
      const s = new Set(prev);
      s.delete(dayId);
      return s;
    });

    if (err) {
      // Revert
      setDays((prev) =>
        prev.map((d) => (d.id === dayId ? { ...d, done: !next } : d)),
      );
      setError(err.message || "Speichern fehlgeschlagen.");
    }
  }

  const hasActive = challenges.length > 0;

  return (
    <section className="mx-auto w-full max-w-xl md:max-w-2xl">
      <header className="mb-6 flex items-baseline justify-between pr-12 md:pr-0">
        <h1 className="text-3xl md:text-4xl">Plan</h1>
        {hasActive && totals.total > 0 ? (
          <span className="text-sm text-text-muted">
            <span className="font-medium text-text">{totals.done}</span>
            {" von "}
            <span className="font-medium text-text">{totals.total}</span> erledigt
          </span>
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

      {loading ? (
        <p className="text-sm text-text-muted">Lade…</p>
      ) : !hasActive || grouped.length === 0 ? (
        <EmptyState />
      ) : (
        <Timeline
          entries={grouped}
          todayIso={todayIso}
          pendingIds={pendingIds}
          onToggle={toggleDone}
          todayRef={todayRef}
        />
      )}
    </section>
  );
}

function Timeline({
  entries,
  todayIso,
  pendingIds,
  onToggle,
  todayRef,
}: {
  entries: DayEntry[];
  todayIso: string;
  pendingIds: Set<string>;
  onToggle: (dayId: string, next: boolean) => void;
  todayRef: React.RefObject<HTMLLIElement | null>;
}) {
  return (
    <ol className="relative space-y-4 pl-6 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-px before:bg-border">
      {entries.map((entry) => {
        const isToday = entry.date === todayIso;
        const isPast = entry.date < todayIso;
        return (
          <li
            key={entry.date}
            ref={isToday ? todayRef : undefined}
            className="relative"
          >
            {/* Punkt auf der Linie */}
            <span
              aria-hidden="true"
              className={[
                "absolute -left-6 top-3 h-3 w-3 rounded-full ring-4 ring-bg",
                isToday
                  ? "bg-accent"
                  : isPast
                    ? "bg-text-muted/40"
                    : "bg-text-muted",
              ].join(" ")}
            />
            <div
              className={[
                "rounded-xl border bg-bg-elevated p-4",
                isToday ? "border-accent" : "border-border",
              ].join(" ")}
            >
              <div className="mb-3 flex items-baseline gap-2">
                <span
                  className={[
                    "font-display text-lg",
                    isToday ? "text-accent" : "text-text",
                  ].join(" ")}
                >
                  {formatDay(entry.date)}
                </span>
                {isToday ? (
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                    Heute
                  </span>
                ) : null}
              </div>
              <ul className="space-y-2">
                {entry.tasks.map((t) => {
                  const pending = pendingIds.has(t.dayId);
                  return (
                    <li key={t.dayId}>
                      <label
                        className={[
                          "flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface",
                          pending ? "opacity-60" : "",
                        ].join(" ")}
                      >
                        <input
                          type="checkbox"
                          checked={t.done}
                          onChange={(e) => onToggle(t.dayId, e.target.checked)}
                          disabled={pending}
                          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className={[
                              "block text-sm leading-relaxed",
                              t.done ? "text-text-muted line-through" : "text-text",
                            ].join(" ")}
                          >
                            {t.task}
                          </span>
                          <span className="mt-0.5 block text-xs text-text-muted">
                            {t.challengeTitle}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-border bg-bg-elevated p-6 text-sm leading-relaxed text-text-muted">
      <p className="mb-2 font-display text-lg text-text">
        Kein aktiver Plan
      </p>
      <p>
        <span className="notranslate" translate="no">MyBro</span> schlägt dir im Chat eine Challenge vor, wenn es organisch passt –
        gezielt, selten und immer nur eine zurzeit. Bis dahin bleibt hier Platz
        für Ruhe.
      </p>
    </div>
  );
}
