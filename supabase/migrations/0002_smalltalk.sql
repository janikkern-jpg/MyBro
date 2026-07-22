-- MyBro – Smalltalk-Modus (zweiter Chat-Modus neben "MyBro")
-- Fügt Modus-Merkmerker in profiles, editierbare Smalltalk-Prinzipien
-- sowie Projekte / Konversationen / Nachrichten mit RLS hinzu.

-- =========================================================================
-- profiles: zuletzt aktiver Chat-Modus
-- =========================================================================
alter table public.profiles
  add column if not exists last_mode text not null default 'mybro';

-- Check-Constraint nur anlegen, wenn er noch nicht existiert
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_last_mode_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_last_mode_check
      check (last_mode in ('mybro', 'smalltalk'));
  end if;
end$$;

-- =========================================================================
-- smalltalk_principles (7 Prinzipien, im Gegensatz zu MyBro über die
-- App-Oberfläche editierbar)
-- =========================================================================
create table if not exists public.smalltalk_principles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position int not null,
  title text not null default '',
  body text not null default ''
);

create index if not exists smalltalk_principles_user_id_idx
  on public.smalltalk_principles(user_id);

create index if not exists smalltalk_principles_user_position_idx
  on public.smalltalk_principles(user_id, position);

alter table public.smalltalk_principles enable row level security;

create policy "smalltalk_principles_select_own"
  on public.smalltalk_principles for select
  using (auth.uid() = user_id);

create policy "smalltalk_principles_insert_own"
  on public.smalltalk_principles for insert
  with check (auth.uid() = user_id);

create policy "smalltalk_principles_update_own"
  on public.smalltalk_principles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "smalltalk_principles_delete_own"
  on public.smalltalk_principles for delete
  using (auth.uid() = user_id);

-- -------------------------------------------------------------------------
-- Beim ersten Anlegen eines profiles-Eintrags automatisch 7 leere
-- Prinzipien-Zeilen anlegen (title: "", body: ""). Trigger läuft mit den
-- Rechten des Table-Owners (security definer), damit die Inserts nicht an
-- RLS scheitern.
-- -------------------------------------------------------------------------
create or replace function public.seed_smalltalk_principles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.smalltalk_principles (user_id, position, title, body)
  select new.user_id, gs, '', ''
  from generate_series(1, 7) as gs
  where not exists (
    select 1 from public.smalltalk_principles
    where user_id = new.user_id
  );
  return new;
end;
$$;

drop trigger if exists profiles_seed_smalltalk_principles on public.profiles;

create trigger profiles_seed_smalltalk_principles
  after insert on public.profiles
  for each row
  execute function public.seed_smalltalk_principles();

-- Bestehende profiles (die vor dieser Migration angelegt wurden)
-- nachträglich mit 7 leeren Zeilen versorgen.
insert into public.smalltalk_principles (user_id, position, title, body)
select p.user_id, gs, '', ''
from public.profiles p
cross join generate_series(1, 7) as gs
where not exists (
  select 1 from public.smalltalk_principles sp
  where sp.user_id = p.user_id
);

-- =========================================================================
-- st_projects
-- =========================================================================
create table if not exists public.st_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists st_projects_user_id_created_at_idx
  on public.st_projects(user_id, created_at desc);

alter table public.st_projects enable row level security;

create policy "st_projects_select_own"
  on public.st_projects for select
  using (auth.uid() = user_id);

create policy "st_projects_insert_own"
  on public.st_projects for insert
  with check (auth.uid() = user_id);

create policy "st_projects_update_own"
  on public.st_projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "st_projects_delete_own"
  on public.st_projects for delete
  using (auth.uid() = user_id);

-- =========================================================================
-- st_conversations
-- =========================================================================
create table if not exists public.st_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.st_projects(id) on delete set null,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists st_conversations_user_id_updated_at_idx
  on public.st_conversations(user_id, updated_at desc);

create index if not exists st_conversations_project_id_idx
  on public.st_conversations(project_id);

-- Für die "Zuletzt verwendet"-Ansicht (nur Konversationen ohne Projekt,
-- innerhalb der letzten 30 Tage) – Partial-Index auf project_id IS NULL.
create index if not exists st_conversations_recent_no_project_idx
  on public.st_conversations(user_id, created_at desc)
  where project_id is null;

alter table public.st_conversations enable row level security;

create policy "st_conversations_select_own"
  on public.st_conversations for select
  using (auth.uid() = user_id);

create policy "st_conversations_insert_own"
  on public.st_conversations for insert
  with check (auth.uid() = user_id);

create policy "st_conversations_update_own"
  on public.st_conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "st_conversations_delete_own"
  on public.st_conversations for delete
  using (auth.uid() = user_id);

-- updated_at automatisch pflegen
create or replace function public.st_conversations_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists st_conversations_set_updated_at on public.st_conversations;

create trigger st_conversations_set_updated_at
  before update on public.st_conversations
  for each row
  execute function public.st_conversations_touch_updated_at();

-- =========================================================================
-- st_messages
-- =========================================================================
create table if not exists public.st_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.st_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists st_messages_conversation_id_created_at_idx
  on public.st_messages(conversation_id, created_at);

alter table public.st_messages enable row level security;

-- RLS läuft indirekt über die zugehörige Konversation. Jede Policy prüft,
-- dass die Konversation dem eingeloggten Nutzer gehört.
create policy "st_messages_select_own"
  on public.st_messages for select
  using (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

create policy "st_messages_insert_own"
  on public.st_messages for insert
  with check (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

create policy "st_messages_update_own"
  on public.st_messages for update
  using (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

create policy "st_messages_delete_own"
  on public.st_messages for delete
  using (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- =========================================================================
-- Hinweis "Zuletzt verwendet"
-- =========================================================================
-- Die Ansicht filtert per Abfrage (project_id is null and created_at >
-- now() - interval '30 days'). Ein automatisches Löschen ist nicht nötig.
-- Optional per Supabase Cron (pg_cron) einrichten, wenn die Tabelle
-- irgendwann zu groß wird, z. B.:
--
--   select cron.schedule(
--     'st_conversations_cleanup',
--     '0 3 * * *',
--     $$ delete from public.st_conversations
--        where project_id is null
--          and created_at < now() - interval '30 days' $$
--   );
