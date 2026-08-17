// Beweist die Cache-Diskrepanz: ruft dieselbe live Function
//   a) OHNE systemPrompt (worst case)
//   b) mit einem MINIMALEN alten Prompt (wie vor Commit f0d56ab)
// jeweils mit derselben Frage. Erwartung: hier antwortet das Modell "nein".

async function call(scenario: string, systemPrompt: string | undefined) {
  console.log(`\n────── ${scenario} ──────`);
  const body: Record<string, unknown> = {
    messages: [
      { role: "user", content: "kannst du bestehende bilder bearbeiten?" },
    ],
  };
  if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
  const res = await fetch("https://mybropsych.netlify.app/api/smalltalk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log("HTTP", res.status);
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.content)) {
      for (const block of j.content) {
        if (block.type === "text") console.log(block.text);
        else if (block.type === "tool_use")
          console.log(`[tool_use ${block.name}]`);
      }
    } else {
      console.log(JSON.stringify(j, null, 2));
    }
  } catch {
    console.log(text);
  }
}

// (a) leerer Prompt-Slot → Server sendet gar kein system-Feld
await call("A) kein systemPrompt", undefined);

// (b) alter Prompt-Text (grober Nachbau des Stands vor f0d56ab)
const OLD =
  "Du bist ein hilfreicher, freundlicher Alltagsassistent für Fragen, Gespräche und kreative Aufgaben.\n\n" +
  "Antworte auf Deutsch, klar und natürlich. Halte dich kurz.\n\n" +
  "WERKZEUG: Du hast das Tool `generate_image` – erzeugt komplett neue Bilder aus einem Text-Prompt.";
await call("B) alter Prompt (ohne Fähigkeitsaussage)", OLD);
