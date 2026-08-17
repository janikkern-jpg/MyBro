import type { SmalltalkPrinciple } from "./types";

const NEUTRAL_DEFAULT =
  "Du bist ein hilfreicher, freundlicher Alltagsassistent für Fragen, Gespräche und kreative Aufgaben.";

const GUIDANCE =
  "Antworte auf Deutsch, klar und natürlich. Halte dich kurz, außer der Nutzer bittet um Details.";

// Wir liefern zusätzlich das aktuelle Datum, damit das Modell selbst
// erkennt, wie alt sein Trainingswissen relativ dazu ist – das erhöht
// die Bereitschaft, das Web-Search-Tool wirklich zu nutzen.
function buildWebSearchGuidance(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "WERKZEUG: Dir steht das Tool `web_search` zur Verfügung. Nutze es AKTIV und OHNE nachzufragen, sobald eine der folgenden Bedingungen zutrifft:",
    "- Die Antwort hängt von aktuellen oder sich ändernden Fakten ab (Preise, Kurse, Wetter, News, Sport-Ergebnisse, Öffnungszeiten, Events, Fahrpläne, Verfügbarkeiten, Produkt-Verfügbarkeit).",
    "- Die Frage bezieht sich auf ein Datum, ein Ereignis oder eine Person NACH deinem Trainings-Cutoff.",
    "- Du bist dir bei einer konkreten Zahl, einem Namen oder einem Termin nicht mehr als ~90 % sicher.",
    "- Der Nutzer fragt explizit „aktuell\", „gerade\", „heute\", „diese Woche\", „momentan\", „gerade jetzt\" o. ä.",
    "",
    "Regeln:",
    "- Sage NIEMALS „Ich habe keinen Internetzugriff\" oder „mein Wissen ist nicht aktuell\". Wenn eine dieser Bedingungen zutrifft, RUFE stattdessen `web_search` auf.",
    "- Erfinde keine Zahlen, Preise oder Termine. Im Zweifel: erst suchen, dann antworten.",
    "- Formuliere gezielte, kompakte Suchqueries (2–6 Wörter, ggf. Ort/Datum). Bei Bedarf mehrere Suchen hintereinander.",
    "- Fasse die gefundenen Fakten in eigener Sprache zusammen und behalte die Zitationen bei – die UI zeigt sie automatisch als Quellen-Liste an.",
    `- Heutiges Datum (Client-Zeit): ${today}.`,
  ].join("\n");
}

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
    return `${NEUTRAL_DEFAULT}\n\n${GUIDANCE}\n\n${buildWebSearchGuidance()}`;
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
    "",
    buildWebSearchGuidance(),
  ].join("\n");
}
