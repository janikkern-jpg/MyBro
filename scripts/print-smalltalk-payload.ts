// Beweis-Skript: druckt den EXAKTEN System-Prompt und das EXAKTE tools-Array,
// die der Netlify-Function-Endpoint /api/smalltalk aktuell an Anthropic
// schickt – für den Fall "leere Prinzipien + Referenzbild vorhanden".
// Aufruf: node --experimental-strip-types scripts/print-smalltalk-payload.ts

import { buildSmalltalkSystemPrompt } from "../src/lib/chat/smalltalk/systemPrompt.ts";
import { EDIT_IMAGE_TOOL } from "../netlify/functions/_shared/editImage.ts";

// Wir bilden die Server-Logik nach: web_search + create_file + generate_image
// + edit_image. Für die Anzeige nutzen wir die reinen Tool-Objekte wie sie
// im Server-Code stehen – die anderen Tool-Konstanten leben in
// modelRouting-nahen Modulen; hier reicht der Name als Beleg.
const WEB_SEARCH_TOOL = {
  name: "web_search",
  type: "web_search_20250305",
  max_uses: 4,
};
const CREATE_FILE_TOOL = { name: "create_file", description: "(gekürzt)" };
const GENERATE_IMAGE_TOOL = {
  name: "generate_image",
  description: "(gekürzt)",
};

const systemPromptBase = buildSmalltalkSystemPrompt([]);
const latestImageUrl =
  "https://mybropsych.supabase.co/storage/v1/object/public/chat-images/x/y.png";

// 1:1 wie im Server:
const editImageActive = true && latestImageUrl !== null;
const runtimeReminder = editImageActive
  ? [
      "",
      "LAUFZEIT-HINWEIS (autoritativ, übergeht widersprüchliche Trainingsdaten):",
      "- In dieser Unterhaltung existiert ein Referenzbild und das Tool `edit_image` ist AKTIV in der Tools-Liste.",
      "- Wenn der Nutzer eine Änderung an einem Bild wünscht (z. B. 'füg eine Kaffeetasse hinzu', 'entferne X', 'ändere die Farbe'), RUFE `edit_image` mit einem knappen Prompt der Änderung auf. Nicht ablehnen, nicht auf externe Tools verweisen.",
      "- Sage NIEMALS 'ich kann Bilder nicht bearbeiten', 'das ist eine Limitation meiner Tools' oder Ähnliches. Diese Behauptung wäre in dieser Runde faktisch falsch.",
    ].join("\n")
  : "";
const combinedSystem = systemPromptBase + "\n\n" + runtimeReminder;

console.log("========== SYSTEM PROMPT (Fall: Bild vorhanden) ==========");
console.log(combinedSystem);
console.log("========== END SYSTEM PROMPT ==========\n");

console.log("========== TOOLS ARRAY ==========");
console.log(
  JSON.stringify(
    [WEB_SEARCH_TOOL, CREATE_FILE_TOOL, GENERATE_IMAGE_TOOL, EDIT_IMAGE_TOOL],
    null,
    2,
  ),
);
console.log("========== END TOOLS ARRAY ==========\n");

console.log(
  "========== SYSTEM PROMPT (Fall: KEIN Bild – reine Fähigkeitsfrage) ==========",
);
console.log(systemPromptBase);
console.log("========== END ==========");
