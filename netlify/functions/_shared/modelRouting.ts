// Gemeinsames Modell-Routing für alle Anthropic-Aufrufe (MyBro + Smalltalk).
//
// Vor jedem "echten" Aufruf entscheidet ein günstiger Klassifikator-
// Aufruf (claude-haiku-4-5, max. 8 Tokens Antwort) grob, wie aufwendig
// die Nutzeranfrage ist. Danach wird passend geroutet:
//
//   "einfach"  → claude-haiku-4-5   (kurze Alltagsfragen, Check-ins)
//   "mittel"   → claude-sonnet-5    (Standardfall, Großteil aller Antworten)
//   "komplex"  → claude-opus-4-8    (nur echte Tiefgang-Anfragen)
//
// Wichtige Grundsätze:
//  - Opus ist die Ausnahme, nicht die Regel. Der Klassifikator ist
//    ausdrücklich auf "im Zweifel mittel" kalibriert.
//  - Schlägt der Klassifikator fehl (Fehler, unklare Antwort, leerer
//    User-Text), fällt das Routing hart auf "mittel" (Sonnet) zurück.
//  - Für jede Stufe gibt es einen kurzen Overload-Fallback (529),
//    damit ein temporär überlasteter Opus/Sonnet nicht die ganze
//    Anfrage sprengt.
//
// Genutzt sowohl in `chat.ts` (MyBro) als auch in `smalltalk.ts`. Der
// Klassifikator sieht nur den letzten menschlich verfassten User-Text
// (Tool-Result-Nachrichten aus dem MyBro-Loop werden übersprungen), was
// die Kosten pro Klassifikation vernachlässigbar hält.

import {
  callAnthropicWithFallback,
  type AnthropicMessage,
} from "./anthropic";
import { usageFromAnthropicRaw, type UsageRecord } from "./pricing";

export type Complexity = "einfach" | "mittel" | "komplex";

const CLASSIFIER_MODEL = "claude-haiku-4-5";
const CLASSIFIER_MAX_TOKENS = 8;
const DEFAULT_COMPLEXITY: Complexity = "mittel";

/**
 * Fallback-Ketten pro Komplexitätsstufe. Erstes Element ist das
 * primäre Modell; die folgenden dienen nur als Overload-Fallback (529).
 * Bewusst konservativ: kein Auto-Upgrade in die nächsthöhere Stufe.
 */
const MODEL_CHAINS: Record<Complexity, readonly string[]> = {
  einfach: ["claude-haiku-4-5"],
  mittel: ["claude-sonnet-5", "claude-haiku-4-5"],
  komplex: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
};

const CLASSIFIER_SYSTEM =
  "Du klassifizierst die letzte Nutzeranfrage in EIN Wort für ein Modell-Routing.\n" +
  "Erlaubt sind ausschließlich: 'einfach', 'mittel', 'komplex'.\n" +
  "\n" +
  "Regeln (streng befolgen):\n" +
  "- 'einfach': sehr kurze Alltagsfragen, Smalltalk, kurze Bestätigungen, kurze Check-ins, Terminfragen, einfache Definitionen.\n" +
  "- 'mittel': STANDARDFALL. Nutze diese Stufe, wann immer du unsicher bist. Übliche Coaching-Antworten, normale Erklärungen, Alltagsberatung, mittellange Reflexion, Umformulierungen, Zusammenfassungen kurzer Texte.\n" +
  "- 'komplex': NUR bei klar erkennbar tiefgehenden Anfragen. Beispiele: mehrjährige Lebens- oder Karriereplanung, umfangreiche Lernpläne, Analyse von Denkmustern über mehrere Nachrichten hinweg, systematisches Durcharbeiten schwieriger emotionaler Situationen, mehrschichtige fachliche Argumentation.\n" +
  "\n" +
  "Kalibrierung: Die überwiegende Mehrheit aller Anfragen ist 'mittel'. Wähle 'komplex' nur, wenn eine ernsthafte, mehrstufige Auseinandersetzung offensichtlich nötig ist – nicht bei jeder etwas längeren Frage.\n" +
  "\n" +
  "Antwortformat: NUR das eine Wort ('einfach', 'mittel' oder 'komplex'). Kein Punkt, keine Anführungszeichen, keine Erklärung.";

/**
 * Extrahiert den letzten wirklich menschlich formulierten User-Text aus
 * der Nachrichtenliste. Rein technische User-Turns (nur `tool_result`
 * ohne Text-Block) werden übersprungen, weil sie im MyBro-Tool-Loop
 * regelmäßig als "letzte" User-Message auftauchen und nichts über die
 * Absicht der Person aussagen.
 */
export function lastUserText(messages: AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") {
      const trimmed = m.content.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts: string[] = [];
      for (const block of m.content) {
        if (block && typeof block === "object") {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push(b.text);
          }
        }
      }
      const joined = parts.join("\n").trim();
      if (joined) return joined;
    }
  }
  return "";
}

/**
 * Kurzer Klassifikations-Roundtrip. Liefert die erkannte Stufe oder
 * `null`, wenn nichts Verwertbares zurückkommt. Ist absichtlich sehr
 * knappe Nutzung von Tokens: 8 Response-Tokens genügen für ein Wort,
 * und der User-Text wird auf 2000 Zeichen gekappt, damit sehr lange
 * Verläufe die Klassifikation nicht teurer machen als nötig.
 */
async function classifyComplexity(
  userText: string,
  apiKey: string,
): Promise<{ complexity: Complexity | null; usage: UsageRecord | null }> {
  const body: Record<string, unknown> = {
    max_tokens: CLASSIFIER_MAX_TOKENS,
    system: CLASSIFIER_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          userText.length > 2000 ? userText.slice(0, 2000) : userText,
      },
    ],
  };

  const outcome = await callAnthropicWithFallback(body, apiKey, [
    CLASSIFIER_MODEL,
  ]);
  if (outcome.kind !== "response" || !outcome.response.ok) {
    return { complexity: null, usage: null };
  }

  const usage = usageFromAnthropicRaw(outcome.rawText, CLASSIFIER_MODEL);

  try {
    const parsed = JSON.parse(outcome.rawText) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = (parsed.content ?? [])
      .map((b) =>
        b?.type === "text" && typeof b.text === "string" ? b.text : "",
      )
      .join("")
      .trim()
      .toLowerCase();
    let complexity: Complexity | null = null;
    if (text.startsWith("komplex")) complexity = "komplex";
    else if (text.startsWith("mittel")) complexity = "mittel";
    else if (text.startsWith("einfach")) complexity = "einfach";
    return { complexity, usage };
  } catch {
    return { complexity: null, usage };
  }
}

export type ModelSelection = {
  complexity: Complexity;
  /**
   * `true`, wenn `complexity` aus dem Fallback ("mittel") stammt, weil
   * der Klassifikator nichts Verwertbares geliefert hat.
   */
  fromFallback: boolean;
  /**
   * Modellkette: erstes Modell ist das primäre, weitere sind reine
   * 529-Overload-Fallbacks. Direkt in
   * `callAnthropicWithFallback(_, _, models)` einsetzbar.
   */
  models: readonly string[];
  /**
   * Usage-Zeile für den Klassifikator-Aufruf selbst (haiku), damit die
   * Kosten auch dieses Vorab-Aufrufs im `usage_log` landen.
   */
  classifierUsage: UsageRecord | null;
};

/**
 * Führt Klassifikation + Modell-Auswahl in einem Rutsch aus. Bei
 * fehlender/leerer User-Nachricht ODER Klassifikator-Fehler wird
 * "mittel" (Sonnet) als sicherer Standard verwendet – wie in der
 * Produkt-Spezifikation gefordert.
 */
export async function selectModelForMessages(
  messages: AnthropicMessage[],
  apiKey: string,
): Promise<ModelSelection> {
  const userText = lastUserText(messages);
  if (userText.length === 0) {
    return {
      complexity: DEFAULT_COMPLEXITY,
      fromFallback: true,
      models: MODEL_CHAINS[DEFAULT_COMPLEXITY],
      classifierUsage: null,
    };
  }
  const { complexity: detected, usage } = await classifyComplexity(
    userText,
    apiKey,
  );
  const complexity: Complexity = detected ?? DEFAULT_COMPLEXITY;
  return {
    complexity,
    fromFallback: detected === null,
    models: MODEL_CHAINS[complexity],
    classifierUsage: usage,
  };
}
