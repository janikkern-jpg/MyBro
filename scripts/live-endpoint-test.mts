// Live-Test gegen die DEPLOYTE Netlify-Function.
// Sendet exakt den Client-System-Prompt (buildSmalltalkSystemPrompt([])) und
// prüft, was der Endpoint für die reine Fähigkeitsfrage tatsächlich antwortet.

import { buildSmalltalkSystemPrompt } from "../src/lib/chat/smalltalk/systemPrompt.ts";

const systemPrompt = buildSmalltalkSystemPrompt([]);

const body = {
  systemPrompt,
  messages: [
    { role: "user", content: "kannst du bestehende bilder bearbeiten?" },
  ],
};

console.log("POST https://mybropsych.netlify.app/api/smalltalk");
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
    console.log(
      "provider=", j._provider,
      " model=", j._model,
      " fallback=", j._fallback,
    );
    for (const block of j.content) {
      if (block.type === "text") {
        console.log("── TEXT ──");
        console.log(block.text);
      } else if (block.type === "tool_use") {
        console.log(
          `── TOOL_USE ── name=${block.name} input=${JSON.stringify(block.input)}`,
        );
      } else {
        console.log("── BLOCK ──", block.type);
      }
    }
    console.log("stop_reason:", j.stop_reason);
  } else {
    console.log(JSON.stringify(j, null, 2));
  }
} catch {
  console.log(text);
}
