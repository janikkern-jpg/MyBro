# MyBro

Persönliche Coaching- und Journaling-Webapp mit Chat, Kalender und Plan.

**Stack:** React 19 + TypeScript + Vite · Tailwind CSS v4 · React Router 7 ·
Supabase (Auth + Postgres mit RLS) · Cloudflare Pages (Hosting) + Cloudflare
Pages Functions (Server-Endpoints) · Anthropic Claude & OpenAI (serverseitig).

---

## 1. Lokales Setup

Voraussetzungen: **Node 20+** und **npm**.

```powershell
# Abhängigkeiten installieren
npm install

# .env aus Vorlage erstellen und ausfüllen (Build-Variablen für Vite)
Copy-Item .env.example .env
```

`.env` (nur Build-/Frontend-Variablen mit `VITE_`-Präfix):

```dotenv
# Frontend – landet im Client-Bundle. Nur öffentliche Werte hier.
VITE_SUPABASE_URL=https://<projekt>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
```

Die **serverseitigen Secrets** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) gehören
für die Pages-Functions in eine separate Datei `.dev.vars` (Wrangler-
Konvention):

```dotenv
# .dev.vars – wird von `wrangler pages dev` gelesen, NICHT von Vite.
# Kein VITE_-Präfix, sonst würde Vite das ins Client-Bundle mischen.
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

`.dev.vars` gehört – wie `.env` – in `.gitignore`.

Danach:

```powershell
# Nur Frontend (kein Chat, weil /api/* nicht verfügbar)
npm run dev            # Vite auf http://localhost:5173

# Frontend + Pages Functions gemeinsam (empfohlen)
npm run pages:dev      # Wrangler auf http://localhost:8788 – /api/* funktioniert
```

`npm run pages:dev` startet Vite als Backend-Proxy und hängt die Functions
aus `functions/` an denselben Origin – `/api/chat`, `/api/smalltalk`,
`/api/smalltalk-image` und `/api/status` sind damit erreichbar.

### Function smoke test

```powershell
$body = @{ messages = @( @{ role = "user"; content = "Sag PONG." } ) } |
        ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8788/api/chat `
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

Die Migration [supabase/migrations/0002_smalltalk.sql](supabase/migrations/0002_smalltalk.sql)
ergänzt den Smalltalk-Modus (Prinzipien, Projekte, Konversationen,
Nachrichten). Ein Trigger auf `profiles` legt beim ersten Login 7 leere
`smalltalk_principles`-Zeilen an. Die Ansicht *Zuletzt verwendet* filtert
per Query auf `project_id is null and created_at > now() - interval '30
days'`; ein automatisches Löschen ist nicht nötig. Optional lässt sich das
später per Supabase Cron (`pg_cron`) ergänzen – Beispiel-Schedule steht als
Kommentar am Ende der Migration.

---

## 3. Deployment auf Cloudflare Pages

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

Wichtig: `.env` und `.dev.vars` werden durch die `.gitignore` ausgeschlossen
und dürfen **niemals** committed werden.

### 3.2 Pages-Projekt anlegen

1. <https://dash.cloudflare.com> öffnen → links **Workers & Pages**.
2. **Create application** → Tab **Pages** → **Connect to Git**.
3. GitHub-Konto autorisieren, das Repo auswählen, **Begin setup**.
4. Build-Einstellungen:
   - **Framework preset:** *None* (oder *Vite*, beides funktioniert).
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** leer lassen.
   - Node-Version: unter *Settings → Environment variables* zusätzlich
     `NODE_VERSION=20` setzen, falls Cloudflare nicht automatisch Node 20
     wählt.
5. **Save and Deploy**.

Cloudflare erkennt automatisch den Ordner `functions/` und deployt jede
Datei unter `functions/api/*.ts` als Endpoint unter `/api/*`. Der Ordner
`functions/_shared/` wird durch das führende `_` nicht als Route
interpretiert und dient nur als Helfer-Modul.

### 3.3 Umgebungsvariablen setzen

Unter *Site → Settings → Environment variables* (getrennt für *Production*
und *Preview*):

| Variable | Wert | Typ | Zweck |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `https://<projekt>.supabase.co` | **Plaintext** (Build) | Supabase-Endpoint fürs Frontend |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` | **Plaintext** (Build) | Supabase Anon-Key fürs Frontend |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | **Secret** | Anthropic-API-Key, wird von Pages Functions gelesen |
| `OPENAI_API_KEY` | `sk-...` | **Secret** | OpenAI-Fallback + Bildgenerierung |

Wichtig:

- Die beiden Secrets dürfen **keinen** `VITE_`-Präfix haben – sonst
  landen sie im Client-Bundle.
- Nach dem Setzen neuer Variablen einmal *Deployments → latest → Retry
  deployment* auslösen, damit sie greifen.

### 3.4 Fertig

- Frontend liegt unter der Pages-URL (`https://<projekt>.pages.dev`) bzw.
  der verknüpften Custom-Domain.
- Endpoints: `/api/chat`, `/api/smalltalk`, `/api/smalltalk-image`,
  `/api/status`.
- SPA-Routen wie `/chat`, `/kalender`, `/plan` werden über
  [public/_redirects](public/_redirects) auf `index.html` aufgelöst.

> **Übergangszeit:** Die alten Netlify-Dateien ([netlify.toml](netlify.toml)
> und [netlify/functions/](netlify/functions/)) bleiben absichtlich noch im
> Repo, bis Cloudflare nachweislich läuft. Sobald das der Fall ist, können
> beide gelöscht werden.

---

## 4. Sicherheit: warum Server-Keys niemals `VITE_`-Präfix bekommen

Vite übernimmt beim Build **nur** Umgebungsvariablen mit dem Präfix `VITE_`
in das Client-Bundle. Alle anderen Variablen sind ausschließlich zur Build-/
Server-Zeit sichtbar und landen nicht im ausgelieferten JavaScript.

Deshalb gilt strikt:

- ✅ `ANTHROPIC_API_KEY=…` / `OPENAI_API_KEY=…` in Cloudflare Pages →
  *Environment variables* als **Secret** setzen. Wird von
  [functions/api/chat.ts](functions/api/chat.ts),
  [functions/api/smalltalk.ts](functions/api/smalltalk.ts),
  [functions/api/smalltalk-image.ts](functions/api/smalltalk-image.ts) und
  [functions/api/status.ts](functions/api/status.ts) über `context.env`
  gelesen.
- ❌ **Niemals** `VITE_ANTHROPIC_API_KEY=…` verwenden. Das würde den Key
  als String in `dist/assets/index-*.js` einbrennen und für jeden Besucher
  der Seite über die Browser-DevTools sichtbar machen.
- ❌ Den Key niemals in Quellcode, Kommentare, Tests, README-Beispiele oder
  Commit-Messages schreiben. Für lokale Tests immer aus `.dev.vars` lesen,
  `.dev.vars` bleibt gitignored.

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
  components/     Layout, Navigation, SettingsPanel, Icons
  lib/            supabase.ts, auth.tsx, bootstrap.ts, chat/*, usage.ts
functions/
  api/            chat.ts, smalltalk.ts, smalltalk-image.ts, status.ts
  _shared/        anthropic, openaiText, openaiImage, modelRouting, pricing
supabase/
  migrations/     0001_init.sql, 0002_smalltalk.sql, 0003_usage_log.sql
public/
  _redirects      SPA-Fallback für Cloudflare Pages
wrangler.toml     Pages-Projektname + compatibility_date
netlify.toml      (Legacy – wird nach erfolgreichem Cloudflare-Deploy entfernt)
```

## Skripte

| Skript | Zweck |
|---|---|
| `npm run dev` | Vite dev-server (ohne Functions) |
| `npm run pages:dev` | Vite + Pages Functions gemeinsam (`/api/*` verfügbar) |
| `npm run build` | Produktions-Build nach `dist/` |
| `npm run preview` | Vite-Preview des Builds |
| `npm run lint` | Oxlint über `src/` |
