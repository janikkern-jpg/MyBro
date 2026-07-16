-- MyBro – initiales Schema
-- Alle Tabellen sind pro Nutzer isoliert (Row Level Security + Policies auf auth.uid()).

-- Für gen_random_uuid()
create extension if not exists "pgcrypto";

-- =========================================================================
-- profiles
-- =========================================================================
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  summary text,
  onboarding_complete boolean not null default false
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "profiles_delete_own"
  on public.profiles for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- character_principles (7 Prinzipien der KI, pro Nutzer editierbar)
-- =========================================================================
create table if not exists public.character_principles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null,
  title text not null,
  body text not null default ''
);

create index if not exists character_principles_user_id_idx
  on public.character_principles(user_id);

create index if not exists character_principles_user_position_idx
  on public.character_principles(user_id, position);

alter table public.character_principles enable row level security;

create policy "character_principles_select_own"
  on public.character_principles for select
  using (auth.uid() = user_id);

create policy "character_principles_insert_own"
  on public.character_principles for insert
  with check (auth.uid() = user_id);

create policy "character_principles_update_own"
  on public.character_principles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "character_principles_delete_own"
  on public.character_principles for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- messages
-- =========================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_user_id_created_at_idx
  on public.messages(user_id, created_at);

alter table public.messages enable row level security;

create policy "messages_select_own"
  on public.messages for select
  using (auth.uid() = user_id);

create policy "messages_insert_own"
  on public.messages for insert
  with check (auth.uid() = user_id);

create policy "messages_update_own"
  on public.messages for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "messages_delete_own"
  on public.messages for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- archive
-- =========================================================================
create table if not exists public.archive (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  summary text,
  archived_at timestamptz not null default now(),
  message_count int
);

create index if not exists archive_user_id_archived_at_idx
  on public.archive(user_id, archived_at desc);

alter table public.archive enable row level security;

create policy "archive_select_own"
  on public.archive for select
  using (auth.uid() = user_id);

create policy "archive_insert_own"
  on public.archive for insert
  with check (auth.uid() = user_id);

create policy "archive_update_own"
  on public.archive for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "archive_delete_own"
  on public.archive for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- challenges
-- =========================================================================
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists challenges_user_id_idx
  on public.challenges(user_id);

alter table public.challenges enable row level security;

create policy "challenges_select_own"
  on public.challenges for select
  using (auth.uid() = user_id);

create policy "challenges_insert_own"
  on public.challenges for insert
  with check (auth.uid() = user_id);

create policy "challenges_update_own"
  on public.challenges for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "challenges_delete_own"
  on public.challenges for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- challenge_days
-- =========================================================================
create table if not exists public.challenge_days (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  task text,
  done boolean not null default false
);

create index if not exists challenge_days_challenge_id_idx
  on public.challenge_days(challenge_id);

create index if not exists challenge_days_user_id_date_idx
  on public.challenge_days(user_id, date);

alter table public.challenge_days enable row level security;

create policy "challenge_days_select_own"
  on public.challenge_days for select
  using (auth.uid() = user_id);

create policy "challenge_days_insert_own"
  on public.challenge_days for insert
  with check (auth.uid() = user_id);

create policy "challenge_days_update_own"
  on public.challenge_days for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "challenge_days_delete_own"
  on public.challenge_days for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- interaction_dates
-- =========================================================================
create table if not exists public.interaction_dates (
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  primary key (user_id, date),
  unique (user_id, date)
);

create index if not exists interaction_dates_user_id_idx
  on public.interaction_dates(user_id);

alter table public.interaction_dates enable row level security;

create policy "interaction_dates_select_own"
  on public.interaction_dates for select
  using (auth.uid() = user_id);

create policy "interaction_dates_insert_own"
  on public.interaction_dates for insert
  with check (auth.uid() = user_id);

create policy "interaction_dates_update_own"
  on public.interaction_dates for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "interaction_dates_delete_own"
  on public.interaction_dates for delete
  using (auth.uid() = user_id);
