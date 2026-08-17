import type { SmalltalkPrinciple } from "./types";

const NEUTRAL_DEFAULT =
  "Du bist ein hilfreicher, freundlicher Alltagsassistent für Fragen, Gespräche und kreative Aufgaben.";

const GUIDANCE =
  "Antworte auf Deutsch, klar und natürlich. Halte dich kurz, außer der Nutzer bittet um Details.\n" +
  "Formatiere strukturierte Informationen (Listen von Dingen mit mehreren " +
  "Eigenschaften, Vergleiche, Schritt-für-Schritt-Anleitungen) als Markdown – " +
  "Tabellen für tabellarische Daten (z. B. Firmenlisten mit Name/Adresse/etc.), " +
  "Listen für Aufzählungen, **Fett** für Hervorhebungen. Bei einfachem Gesprächstext bleibt es beim Fließtext.";

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

// Hinweis für das zweite serverseitige Tool: `create_file`. Wichtig ist
// vor allem, dass das Modell den Inhalt NICHT zusätzlich in den Chat
// schreibt, sonst hätte der Nutzer alles doppelt (einmal als Text,
// einmal in der Datei).
function buildCreateFileGuidance(): string {
  return [
    "WERKZEUG: Dir steht das Tool `create_file` zur Verfügung. Nutze es, wenn der Nutzer explizit um eine Datei, einen Export oder ein Dokument bittet – z. B. „als CSV\", „mach mir daraus eine Excel-Liste\", „exportiere das als PDF\", „gib mir das als Word-Datei\", „speicher das als .txt\", „gib mir die Daten als JSON\".",
    "",
    "Regeln:",
    "- Erlaubte `file_type`-Werte: `csv`, `txt`, `pdf`, `docx`, `json`. Bei „Excel-Liste\" nimm `csv` (öffnet sich in Excel).",
    "- Wähle einen kurzen, sprechenden Dateinamen ohne Pfad, mit passender Endung (z. B. `einkaufsliste.csv`, `bewerbung.pdf`).",
    "- CSV: erste Zeile = Kopfzeile, Felder mit Komma trennen, Werte mit `,`/`\"`/Zeilenumbruch in doppelten Anführungszeichen quoten.",
    "- JSON: gültiges, formatiertes JSON (nicht in ```-Blöcke einwickeln).",
    "- PDF/DOCX/TXT: Klartext-Content mit Absätzen und einfachen Listen (`- ` / `* ` / `1. `). Keine komplexen Layouts, Bilder oder Formeln.",
    "- Wenn die Datei erzeugt wurde, WIEDERHOLE ihren Inhalt NICHT im Chat. Sag stattdessen kurz, dass die Datei bereitsteht (z. B. „Ich habe dir `einkaufsliste.csv` erstellt.\") – die UI zeigt automatisch eine Download-Karte.",
    "- Nur benutzen, wenn der Nutzer klar eine Datei will. Bei „schreib mir einen Text über…\" bleibt es Chat-Text.",
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
    return `${NEUTRAL_DEFAULT}\n\n${GUIDANCE}\n\n${buildWebSearchGuidance()}\n\n${buildCreateFileGuidance()}`;
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
    "",
    buildCreateFileGuidance(),
  ].join("\n");
}
