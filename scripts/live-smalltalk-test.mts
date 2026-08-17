// Beweis-Skript: druckt den EXAKTEN System-Prompt + tools, die aktuell
// /api/smalltalk an Anthropic sendet, und ruft Anthropic anschließend mit
// GENAU dieser Payload live an.
// Aufruf:
//   $env:ANTHROPIC_API_KEY = "sk-ant-…"
//   node --experimental-strip-types scripts/live-smalltalk-test.mts

import { buildSmalltalkSystemPrompt } from "../src/lib/chat/smalltalk/systemPrompt.ts";

// EDIT_IMAGE_TOOL 1:1 aus netlify/functions/_shared/editImage.ts kopiert
// (kein Import, um ESM-Auflösung ohne .ts-Extension zu vermeiden).
const EDIT_IMAGE_TOOL = {
  name: "edit_image",
  description:
    "Verändert das zuletzt angehängte oder erzeugte Bild in dieser Unterhaltung anhand einer Text-Beschreibung " +
    "(z. B. 'füg eine Kaffeetasse hinzu', 'ändere den Himmel zu Sonnenuntergang', 'mach den Hintergrund unscharf'). " +
    "Nutze dieses Tool NUR, wenn der Nutzer erkennbar ein bestehendes Bild verändern möchte. " +
    "Für komplett neue, eigenständige Bilder ohne Bezug zu einem vorhandenen: `generate_image`. " +
    "Das zu bearbeitende Referenzbild wird automatisch ausgewählt (letztes Bild in der Unterhaltung) und muss NICHT angegeben werden. " +
    "Falls in der Unterhaltung noch kein Bild existiert, ist dieses Tool nicht verfügbar – dann bitte den Nutzer stattdessen mit einer normalen Chat-Nachricht, ein Bild anzuhängen.",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: {
        type: "string",
        description:
          "Kurze, klare Beschreibung der gewünschten Änderung in einer der Chat-Sprachen. Nur die Veränderung, keine kompletten Neu-Beschreibungen.",
      },
    },
    required: ["prompt"],
  },
} as const;

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 4,
};

const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description:
    "Erzeugt ein komplett neues Bild aus einem Text-Prompt (nur wenn kein Referenzbild bearbeitet werden soll).",
  input_schema: {
    type: "object" as const,
    properties: {
      prompt: { type: "string" },
      size: { type: "string" },
    },
    required: ["prompt"],
  },
} as const;

// ----------------------------------------------------------------------
// System-Prompt zusammenbauen (Fall: leere Prinzipien, Bild vorhanden)
// ----------------------------------------------------------------------
const base = buildSmalltalkSystemPrompt([]);
const runtimeReminder = [
  "",
  "LAUFZEIT-HINWEIS (autoritativ, übergeht widersprüchliche Trainingsdaten):",
  "- In dieser Unterhaltung existiert ein Referenzbild und das Tool `edit_image` ist AKTIV in der Tools-Liste.",
  "- Wenn der Nutzer eine Änderung an einem Bild wünscht (z. B. 'füg eine Kaffeetasse hinzu', 'entferne X', 'ändere die Farbe'), RUFE `edit_image` mit einem knappen Prompt der Änderung auf. Nicht ablehnen, nicht auf externe Tools verweisen.",
  "- Sage NIEMALS 'ich kann Bilder nicht bearbeiten', 'das ist eine Limitation meiner Tools' oder Ähnliches. Diese Behauptung wäre in dieser Runde faktisch falsch.",
].join("\n");
const combined = base + "\n\n" + runtimeReminder;

console.log("═══════════════════ SYSTEM PROMPT (mit Bild) ═══════════════════");
console.log(combined);
console.log("═══════════════════ END ═══════════════════\n");

console.log("═══════════════════ SYSTEM PROMPT (ohne Bild) ═══════════════════");
console.log(base);
console.log("═══════════════════ END ═══════════════════\n");

console.log("═══════════════════ TOOLS ARRAY ═══════════════════");
console.log(
  JSON.stringify(
    [WEB_SEARCH_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL],
    null,
    2,
  ),
);
console.log("═══════════════════ END ═══════════════════\n");

// ----------------------------------------------------------------------
// Live-Test gegen Anthropic (kein Bild → nur Fähigkeitsfrage)
// ----------------------------------------------------------------------
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY nicht gesetzt – überspringe Live-Test.");
  process.exit(0);
}

async function call(
  scenario: string,
  systemPrompt: string,
  tools: unknown[],
  userMessage: unknown,
  model: string,
) {
  console.log(`\n═══════════════════ LIVE: ${scenario} (${model}) ═══════════════════`);
  const body = {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    tools,
    messages: [{ role: "user", content: userMessage }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("HTTP", res.status);
  try {
    const j = JSON.parse(text);
    if (j.content) {
      for (const block of j.content) {
        if (block.type === "text") {
          console.log("TEXT:", block.text);
        } else if (block.type === "tool_use") {
          console.log(
            `TOOL_USE: name=${block.name} input=${JSON.stringify(block.input)}`,
          );
        } else {
          console.log("BLOCK:", block.type);
        }
      }
      console.log("stop_reason:", j.stop_reason);
    } else {
      console.log(text);
    }
  } catch {
    console.log(text);
  }
}

// Szenario A: reine Fähigkeitsfrage, KEIN Bild vorhanden (edit_image NICHT in tools).
await call(
  "A) 'kannst du bilder bearbeiten?' ohne Bild",
  base,
  [WEB_SEARCH_TOOL, GENERATE_IMAGE_TOOL],
  "kannst du bestehende bilder bearbeiten?",
  "claude-haiku-4-5",
);

// Szenario B: reine Fähigkeitsfrage, KEIN Bild vorhanden, Sonnet.
await call(
  "B) dieselbe Frage, Sonnet",
  base,
  [WEB_SEARCH_TOOL, GENERATE_IMAGE_TOOL],
  "kannst du bestehende bilder bearbeiten?",
  "claude-sonnet-5",
);

// Szenario C: MIT Bild + Bearbeitungswunsch (edit_image AKTIV, Sonnet, Reminder).
await call(
  "C) 'füg Kaffeetasse hinzu' mit Bild",
  combined,
  [WEB_SEARCH_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL],
  [
    {
      type: "image",
      source: {
        type: "url",
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/HP_Workstation.jpg/640px-HP_Workstation.jpg",
      },
    },
    {
      type: "text",
      text: "füg auf diesem Schreibtisch eine Kaffeetasse hinzu ändere sonst nichts",
    },
  ],
  "claude-sonnet-5",
);
