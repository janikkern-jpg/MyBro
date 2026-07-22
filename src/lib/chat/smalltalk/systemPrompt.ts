import type { SmalltalkPrinciple } from "./types";

const NEUTRAL_DEFAULT =
  "Du bist ein hilfreicher, freundlicher Alltagsassistent für Fragen, Gespräche und kreative Aufgaben.";

const GUIDANCE =
  "Antworte auf Deutsch, klar und natürlich. Halte dich kurz, außer der Nutzer bittet um Details.";

/**
 * Baut den Smalltalk-System-Prompt aus den ausgefüllten Prinzipien-Zeilen.
 * Leere Felder (weder title noch body) werden ignoriert. Sind ALLE Zeilen
 * leer, wird der neutrale Standard-Prompt genutzt.
 */
export function buildSmalltalkSystemPrompt(
  principles: readonly SmalltalkPrinciple[],
): string {
  const filled = [...principles]
    .sort((a, b) => a.position - b.position)
    .filter((p) => (p.title ?? "").trim() || (p.body ?? "").trim());

  if (filled.length === 0) {
    return `${NEUTRAL_DEFAULT}\n\n${GUIDANCE}`;
  }

  const lines = filled.map((p, i) => {
    const title = (p.title ?? "").trim();
    const body = (p.body ?? "").trim();
    if (title && body) return `${i + 1}. ${title} — ${body}`;
    return `${i + 1}. ${title || body}`;
  });

  return [
    "CHARAKTER (dein innerer Kompass; in jeder Antwort spürbar, nie explizit zitiert):",
    ...lines,
    "",
    GUIDANCE,
  ].join("\n");
}
