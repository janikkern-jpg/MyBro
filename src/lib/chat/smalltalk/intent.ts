// Heuristische Bild-Wunsch-Erkennung. Bewusst client-seitig, damit kein
// zusätzlicher LLM-Aufruf für Trivial-Fälle nötig wird. Nur wenn die
// Formulierung erkennbar ein Bild fordert, wird der Bild-Endpunkt angesprochen.

const IMAGE_PATTERNS: RegExp[] = [
  // Verben + "Bild"/"Foto"/"Grafik"/"Illustration"
  /\b(generier(?:e|st)?|zeichn(?:e|est|)|mal(?:e|st|)|erstell(?:e|st|)|entwirf|erzeug(?:e|st)?|design(?:e|st|)?)\b[^.?!]*\b(bild|foto|grafik|illustration|artwork|kunstwerk|zeichnung|logo|poster|szene|charakter|avatar)\b/i,
  // "Bild/Foto/... von ..."
  /\b(bild|foto|grafik|illustration|zeichnung|logo|poster)\b[^.?!]*\b(von|mit|zu|zeig)/i,
  // "kannst du ... zeichnen/malen/generieren ..."
  /\bkannst du (mir )?(ein[e]? )?(bild|foto|grafik|illustration|zeichnung|logo)/i,
  // "image of ..." / "picture of ..." (englische Variante)
  /\b(generate|draw|create|make|design)\b[^.?!]*\b(image|picture|photo|artwork|illustration|logo)\b/i,
];

export function detectImageIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return IMAGE_PATTERNS.some((rx) => rx.test(trimmed));
}

/**
 * Extrahiert aus dem Nutzertext den eigentlichen Bild-Prompt: entfernt
 * gängige Präfixe wie "Zeichne mir bitte ein Bild von …". Fallback ist
 * der ursprüngliche Text.
 */
export function extractImagePrompt(text: string): string {
  const trimmed = text.trim();
  const stripped = trimmed
    .replace(
      /^\s*(bitte\s+)?(kannst du\s+)?(mir\s+)?(bitte\s+)?(generier(?:e|st)?|zeichn(?:e|est|)|mal(?:e|st|)|erstell(?:e|st|)|entwirf|erzeug(?:e|st)?|design(?:e|st|)?)\s+(mir\s+)?(bitte\s+)?(ein[e]?\s+)?(bild|foto|grafik|illustration|zeichnung|logo|poster)\s*(von|mit|zu|:)?\s*/i,
      "",
    )
    .replace(
      /^\s*(please\s+)?(can you\s+)?(generate|draw|create|make|design)\s+(me\s+)?(an?|the)?\s*(image|picture|photo|artwork|illustration|logo)\s*(of|with|for|:)?\s*/i,
      "",
    )
    .trim();
  return stripped.length > 0 ? stripped : trimmed;
}
