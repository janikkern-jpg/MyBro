# MyBro

Persönliche Coaching- und Journaling-Webapp mit Chat, Kalender und Plan.

**Stack:** React 19 + TypeScript + Vite · Tailwind CSS v4 · React Router 7 ·
Supabase (Auth + Postgres mit RLS) · Netlify (Hosting + Serverless Functions) ·
Anthropic Claude (serverseitig).

---

## 1. Lokales Setup

Voraussetzungen: **Node 20+** und **npm**.

```powershell
# Abhängigkeiten installieren
npm install

# .env aus Vorlage erstellen und ausfüllen
Copy-Item .env.example .env
```

`.env` mit deinen Werten befüllen:

```dotenv
# Frontend – landet im Client-Bundle. Nur öffentliche Werte hier.
VITE_SUPABASE_URL=https://<projekt>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...

# Server-only. Wird NUR von `netlify dev` bzw. den Netlify Functions gelesen.
# Niemals mit VITE_-Präfix versehen und niemals ins Frontend importieren.
ANTHROPIC_API_KEY=sk-ant-...
```

Danach:

```powershell
# Nur Frontend (kein Chat, weil /api/chat nicht verfügbar)
npm run dev            # Vite auf http://localhost:5173

# Frontend + Netlify Functions gemeinsam (empfohlen)
npx netlify dev        # http://localhost:8888  – /api/chat funktioniert
```

`netlify dev` proxied `/api/*` und `/.netlify/functions/*` an die lokalen
Functions und lädt `.env` automatisch.

### Function smoke test

```powershell
$body = @{ messages = @( @{ role = "user"; content = "Sag PONG." } ) } |
        ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8888/api/chat `
  -ContentType "application/json" -Body $body
```

---

## 2. Supabase-Setup

1. Neues Supabase-Projekt anlegen (<https://supabase.com/dashboard>).
2. `VITE_SUPABASE_URL` und den **Publishable/Anon Key** aus
   *Project Settings → API* in die `.env` eintragen.
3. Schema + Row-Level-Security-Policies einspielen:

   **Option A – SQL-Editor (schnell)**

   Datei [supabase/migrations/0001_init.sql](supabase/migrations/0001_init.sql)
   im Supabase-Dashboard unter *SQL editor* öffnen und einmal ausführen.

   **Option B – Supabase CLI**

   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

4. In *Authentication → Providers* Email-Login aktivieren. Optional:
   *Confirm email* ausschalten, falls du im Test ohne E-Mail-Bestätigung
   arbeiten willst.

Beim ersten Anmelden legt [src/lib/bootstrap.ts](src/lib/bootstrap.ts)
automatisch einen `profiles`-Eintrag und die sieben Standard-Charakter-
Prinzipien an. RLS erzwingt auf jeder Tabelle `auth.uid() = user_id`, jeder
Nutzer sieht ausschließlich seine eigenen Zeilen.

---

## 3. Deployment auf Netlify

### 3.1 Repo auf GitHub pushen

Falls noch kein Git-Repo existiert:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

Wichtig: `.env` wird durch die `.gitignore` ausgeschlossen und darf **niemals**
committed werden.

### 3.2 Site in Netlify anlegen

1. In Netlify *Add new site → Import an existing project* wählen und das
   GitHub-Repo verbinden.
2. Netlify erkennt [netlify.toml](netlify.toml) und übernimmt Build-Command,
   Publish-Verzeichnis, Functions-Verzeichnis und den SPA-Redirect
   automatisch. Manuell nichts überschreiben.

### 3.3 Umgebungsvariablen setzen

Unter *Site settings → Environment variables* folgende Variablen anlegen
(Scope: **All scopes** oder mindestens *Builds* + *Functions*):

| Variable | Wert | Scope | Zweck |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `https://<projekt>.supabase.co` | Build | Supabase-Endpoint fürs Frontend |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` | Build | Supabase Anon-Key fürs Frontend |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | **Functions (Runtime)** | Anthropic-API-Key, nur serverseitig |

Nach dem ersten Deploy: *Deploys → Trigger deploy → Clear cache and deploy site*,
damit die neuen Env-Werte auch in den Build einfließen.

### 3.4 Fertig

- Frontend liegt unter der Netlify-URL (`https://<site>.netlify.app`).
- Chat-Endpunkt: `/api/chat` (Alias in [netlify.toml](netlify.toml)) bzw.
  `/.netlify/functions/chat`.
- SPA-Routen wie `/chat`, `/kalender`, `/plan` werden per Redirect auf
  `index.html` aufgelöst.

---

## 4. Sicherheit: warum `ANTHROPIC_API_KEY` niemals `VITE_`-Präfix bekommt

Vite übernimmt beim Build **nur** Umgebungsvariablen mit dem Präfix `VITE_` in
das Client-Bundle. Alle anderen Variablen sind ausschließlich zur Build-/Server-
Zeit sichtbar und landen nicht im ausgelieferten JavaScript.

Deshalb gilt strikt:

- ✅ `ANTHROPIC_API_KEY=…` in Netlify → *Environment variables* mit Scope
  **Functions** (und ggf. Builds, falls für die Function beim Deploy nötig).
  Wird von [netlify/functions/chat.ts](netlify/functions/chat.ts) über
  `process.env.ANTHROPIC_API_KEY` gelesen.
- ❌ **Niemals** `VITE_ANTHROPIC_API_KEY=…` verwenden. Das würde den Key als
  String in `dist/assets/index-*.js` einbrennen und für jeden Besucher der
  Seite über die Browser-DevTools sichtbar machen.
- ❌ Den Key niemals in Quellcode, Kommentare, Tests, README-Beispiele oder
  Commit-Messages schreiben. Für lokale Tests immer aus `.env` lesen, `.env`
  bleibt gitignored.

Die Function selbst ruft Anthropic mit dem Key im `x-api-key`-Header auf – der
Browser sieht nur die Antwort der Function, nie den Header. Ein Grep nach
`sk-ant-`, `x-api-key` oder `anthropic.com` in `dist/` muss leer bleiben:

```powershell
Select-String -Path dist\assets\*.js -Pattern "sk-ant-|x-api-key|anthropic\.com"
```

---

## Ordnerstruktur

```text
src/
  pages/          Chat, Kalender, Plan, Login
  components/    Layout, Navigation, SettingsPanel, Icons
  lib/            supabase.ts, auth.tsx, bootstrap.ts, chat/*
netlify/
  functions/      chat.ts  (Server-Endpoint für Anthropic)
supabase/
  migrations/     0001_init.sql
netlify.toml     Build, Functions, Redirects, Dev-Port
```

## Skripte

| Skript | Zweck |
|---|---|
| `npm run dev` | Vite dev-server (ohne Functions) |
| `npx netlify dev` | Vite + Functions gemeinsam (`/api/chat` verfügbar) |
| `npm run build` | Produktions-Build nach `dist/` |
| `npm run preview` | Vite-Preview des Builds |
| `npm run lint` | Oxlint über `src/` |
