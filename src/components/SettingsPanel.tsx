import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { supabase } from "../lib/supabase";
import { CloseIcon, SettingsIcon } from "./icons";

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

        <div className="space-y-8 px-4 py-6 sm:px-6">
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
            <h3 className="font-display text-lg text-red-300">Gefahrenzone</h3>
            <p className="mt-1 text-sm text-text-muted">
              Löscht deinen Chatverlauf, alle Archive, alle Challenges und alle
              Interaktionsdaten. Das Onboarding startet neu. Diese Aktion lässt
              sich nicht rückgängig machen.
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
        </div>
      </div>
    </div>
  );
}
