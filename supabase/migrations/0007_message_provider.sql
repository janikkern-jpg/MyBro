-- Provider- und Modell-Metadaten für Antwortnachrichten.
-- Ziel: an jeder KI-Antwort transparent machen, welcher Anbieter (und
-- welches konkrete Modell) sie tatsächlich generiert hat. Wichtig vor
-- allem für den Fallback-Fall (Anthropic → OpenAI), aber auch für
-- Bildergebnisse (immer OpenAI/gpt-image-1).
--
-- Beide Spalten sind optional (NULLable): historische Zeilen behalten
-- ihren Zustand, das Frontend zeigt in dem Fall einfach kein Badge.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text;

ALTER TABLE public.st_messages
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS model text;

-- Kein CHECK-Constraint auf provider – wir wollen bewusst
-- vorwärtskompatibel bleiben, falls später weitere Anbieter dazu-
-- kommen. Das Frontend behandelt unbekannte Werte als „ohne Badge".

COMMENT ON COLUMN public.messages.provider IS
  'Anbieter, der diese Nachricht generiert hat (z. B. anthropic | openai). NULL bei alten Zeilen und bei User-Nachrichten.';
COMMENT ON COLUMN public.messages.model IS
  'Konkretes Modell hinter der Antwort (z. B. claude-sonnet-5, gpt-image-1). NULL bei alten Zeilen und bei User-Nachrichten.';
COMMENT ON COLUMN public.st_messages.provider IS
  'Anbieter, der diese Nachricht generiert hat (z. B. anthropic | openai). NULL bei alten Zeilen und bei User-Nachrichten.';
COMMENT ON COLUMN public.st_messages.model IS
  'Konkretes Modell hinter der Antwort (z. B. claude-sonnet-5, gpt-image-1). NULL bei alten Zeilen und bei User-Nachrichten.';
