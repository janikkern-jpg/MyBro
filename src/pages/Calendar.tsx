import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

type InteractionRow = { date: string };

const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

export default function CalendarPage() {
  const [cursor, setCursor] = useState<Date>(() => {
    const t = new Date();
    return startOfMonth(t.getFullYear(), t.getMonth());
  });
  const [dates, setDates] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await supabase
        .from("interaction_dates")
        .select("date");
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const set = new Set<string>();
      for (const row of (data ?? []) as InteractionRow[]) {
        set.add(row.date);
      }
      setDates(set);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const todayIso = useMemo(() => toIsoDate(new Date()), []);

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Montag zuerst: JS-getDay: 0=So..6=Sa → verschieben.
    const leading = (first.getDay() + 6) % 7;
    const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
    const result: (Date | null)[] = [];
    for (let i = 0; i < leading; i++) result.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      result.push(new Date(year, month, d));
    }
    while (result.length < totalCells) result.push(null);
    return result;
  }, [cursor]);

  const monthInteractionCount = useMemo(() => {
    let count = 0;
    for (const c of cells) {
      if (c && dates.has(toIsoDate(c))) count++;
    }
    return count;
  }, [cells, dates]);

  function goPrev() {
    setCursor((prev) => startOfMonth(prev.getFullYear(), prev.getMonth() - 1));
  }
  function goNext() {
    setCursor((prev) => startOfMonth(prev.getFullYear(), prev.getMonth() + 1));
  }
  function goToday() {
    const t = new Date();
    setCursor(startOfMonth(t.getFullYear(), t.getMonth()));
  }

  const monthLabel = `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;

  return (
    <section className="mx-auto w-full max-w-xl md:max-w-2xl">
      <header className="mb-6 flex items-baseline justify-between pr-12 md:pr-0">
        <h1 className="text-3xl md:text-4xl">Kalender</h1>
        <button
          type="button"
          onClick={goToday}
          className="inline-flex min-h-10 items-center rounded-md px-3 py-2 text-sm text-text-muted transition-colors hover:text-accent"
        >
          Heute
        </button>
      </header>

      <div className="rounded-2xl border border-border bg-bg-elevated p-3 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={goPrev}
            aria-label="Vorheriger Monat"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <ChevronLeftIcon />
          </button>
          <h2 className="font-display text-xl md:text-2xl">{monthLabel}</h2>
          <button
            type="button"
            onClick={goNext}
            aria-label="Nächster Monat"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
          >
            <ChevronRightIcon />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium uppercase tracking-wide text-text-muted">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-2">
              {w}
            </div>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) {
              return <div key={`empty-${i}`} aria-hidden="true" />;
            }
            const iso = toIsoDate(d);
            const hasInteraction = dates.has(iso);
            const isToday = iso === todayIso;
            return (
              <div
                key={iso}
                aria-label={
                  hasInteraction
                    ? `${d.getDate()}. ${MONTHS[d.getMonth()]}, Interaktion`
                    : `${d.getDate()}. ${MONTHS[d.getMonth()]}`
                }
                className={[
                  "relative flex aspect-square items-center justify-center rounded-md text-sm transition-colors",
                  isToday
                    ? "border border-accent text-text"
                    : "border border-transparent",
                  hasInteraction ? "text-text" : "text-text-muted",
                ].join(" ")}
              >
                <span>{d.getDate()}</span>
                {hasInteraction ? (
                  <span
                    aria-hidden="true"
                    className="absolute bottom-1 h-1.5 w-1.5 rounded-full bg-accent"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-6 rounded-xl border border-border bg-bg-elevated p-4">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-text-muted">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-3xl text-accent">
              {loading ? "…" : dates.size}
            </span>
            <span>Tage mit Interaktion insgesamt</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-2xl text-text">
              {loading ? "…" : monthInteractionCount}
            </span>
            <span>diesen Monat</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
