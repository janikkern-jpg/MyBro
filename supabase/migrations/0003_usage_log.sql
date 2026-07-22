-- 0003_usage_log.sql
-- Nutzungs-Tracking für Anthropic- und OpenAI-API-Aufrufe.
-- Zeilen werden clientseitig aus dem `_usage`-Feld der Server-Response
-- eingefügt; RLS stellt sicher, dass niemand fremde Zeilen sieht/schreibt.

create table if not exists public.usage_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('anthropic','openai')),
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost_usd numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);

-- Für "aktueller Monat"-Aggregation.
create index if not exists usage_log_user_created_at_idx
  on public.usage_log (user_id, created_at desc);

alter table public.usage_log enable row level security;

create policy "usage_log_select_own"
  on public.usage_log for select
  using (auth.uid() = user_id);

create policy "usage_log_insert_own"
  on public.usage_log for insert
  with check (auth.uid() = user_id);

-- Update/Delete brauchen wir nicht – Logs sind Append-Only.
