# Netlify Functions

Serverless Functions für MyBro. Hier läuft der Anthropic-Proxy (`chat.ts`).
API-Keys bleiben ausschließlich hier (Environment-Variablen in Netlify),
niemals im Frontend-Bundle.

## Benötigte Environment-Variablen

In Netlify unter **Site settings → Environment variables** eintragen:

- **`ANTHROPIC_API_KEY`** (Pflicht, als *Secret*) – Anthropic-Schlüssel für Claude.
- **`OPENAI_API_KEY`** (empfohlen, als *Secret*) – OpenAI-Schlüssel für den
  automatischen Fallback. Springt nur ein, wenn Anthropic nach allen
  Wiederholungsversuchen mit einem 5xx-Fehler (z. B. `529 overloaded_error`)
  antwortet oder gar nicht erreichbar ist. Ohne diesen Key läuft die Function
  weiter, aber der Chat fällt bei Anthropic-Ausfällen aus.

Nach dem Setzen einer neuen Variable ist ein **Redeploy** nötig, damit die
Function den neuen Wert sieht.

## Provider-Logs

Die Function loggt bei jeder Antwort, welcher Anbieter tatsächlich geantwortet
hat. Nachvollziehbar im Netlify-Dashboard unter **Logs → Functions → chat**:

- `[provider=claude] Antwort erfolgreich.`
- `[provider=openai-fallback] Antwort erfolgreich.`
