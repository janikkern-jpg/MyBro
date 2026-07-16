import { useState, type FormEvent } from "react";
import { useAuth } from "../lib/auth";
import logoUrl from "../assets/logo.svg";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setSubmitting(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
        setInfo(
          "Konto erstellt. Bitte prüfe dein E-Mail-Postfach, falls eine Bestätigung nötig ist.",
        );
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Etwas ist schiefgelaufen.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
  }

  return (
    <div className="min-h-dvh bg-bg text-text flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-10 flex flex-col items-center text-center">
          <img
            src={logoUrl}
            alt="MyBro"
            width={220}
            height={61}
            className="h-auto w-[220px]"
          />
          <p className="mt-4 text-sm text-text-muted">
            Dein persönlicher Begleiter – Coaching, Kalender, Plan.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-bg-elevated p-6 shadow-lg shadow-black/20">
          <div
            role="tablist"
            aria-label="Anmelden oder registrieren"
            className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-sm"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signin"}
              onClick={() => switchMode("signin")}
              className={[
                "min-h-10 rounded-md py-2 font-medium transition-colors",
                mode === "signin"
                  ? "bg-bg-elevated text-accent"
                  : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              Anmelden
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "signup"}
              onClick={() => switchMode("signup")}
              className={[
                "min-h-10 rounded-md py-2 font-medium transition-colors",
                mode === "signup"
                  ? "bg-bg-elevated text-accent"
                  : "text-text-muted hover:text-text",
              ].join(" ")}
            >
              Registrieren
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="email"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-text-muted"
              >
                E-Mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent md:text-sm"
                placeholder="du@example.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-text-muted"
              >
                Passwort
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2.5 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent md:text-sm"
                placeholder={mode === "signup" ? "min. 8 Zeichen" : ""}
              />
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
              >
                {error}
              </p>
            ) : null}
            {info ? (
              <p className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-accent">
                {info}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 min-h-11 w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-bg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting
                ? "Bitte warten…"
                : mode === "signin"
                  ? "Anmelden"
                  : "Konto erstellen"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-text-muted">
          {mode === "signin"
            ? "Noch kein Konto? "
            : "Schon ein Konto? "}
          <button
            type="button"
            onClick={() =>
              switchMode(mode === "signin" ? "signup" : "signin")
            }
            className="-mx-1 rounded px-1 py-1 font-medium text-accent hover:underline"
          >
            {mode === "signin" ? "Jetzt registrieren" : "Zur Anmeldung"}
          </button>
        </p>
      </div>
    </div>
  );
}
