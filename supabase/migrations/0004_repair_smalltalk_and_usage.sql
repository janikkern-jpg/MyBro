-- 0004_repair_smalltalk_and_usage.sql
-- Idempotenter Ersatz für 0002_smalltalk.sql + 0003_usage_log.sql.
-- Kann beliebig oft ausgeführt werden, auch wenn Teile schon existieren.
-- Alle policies werden per DROP + CREATE neu angelegt, um "already exists"
-- Konflikte aus einem vorherigen, teilweise gelaufenen Run zu heilen.

-- =========================================================================
-- profiles.last_mode
-- =========================================================================
alter table public.profiles
  add column if not exists last_mode text not null default 'mybro';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_last_mode_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_last_mode_check
      check (last_mode in ('mybro', 'smalltalk'));
  end if;
end$$;

-- =========================================================================
-- smalltalk_principles
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

drop policy if exists "smalltalk_principles_select_own" on public.smalltalk_principles;
create policy "smalltalk_principles_select_own"
  on public.smalltalk_principles for select
  using (auth.uid() = user_id);

drop policy if exists "smalltalk_principles_insert_own" on public.smalltalk_principles;
create policy "smalltalk_principles_insert_own"
  on public.smalltalk_principles for insert
  with check (auth.uid() = user_id);

drop policy if exists "smalltalk_principles_update_own" on public.smalltalk_principles;
create policy "smalltalk_principles_update_own"
  on public.smalltalk_principles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "smalltalk_principles_delete_own" on public.smalltalk_principles;
create policy "smalltalk_principles_delete_own"
  on public.smalltalk_principles for delete
  using (auth.uid() = user_id);

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

drop policy if exists "st_projects_select_own" on public.st_projects;
create policy "st_projects_select_own"
  on public.st_projects for select
  using (auth.uid() = user_id);

drop policy if exists "st_projects_insert_own" on public.st_projects;
create policy "st_projects_insert_own"
  on public.st_projects for insert
  with check (auth.uid() = user_id);

drop policy if exists "st_projects_update_own" on public.st_projects;
create policy "st_projects_update_own"
  on public.st_projects for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "st_projects_delete_own" on public.st_projects;
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

create index if not exists st_conversations_recent_no_project_idx
  on public.st_conversations(user_id, created_at desc)
  where project_id is null;

alter table public.st_conversations enable row level security;

drop policy if exists "st_conversations_select_own" on public.st_conversations;
create policy "st_conversations_select_own"
  on public.st_conversations for select
  using (auth.uid() = user_id);

drop policy if exists "st_conversations_insert_own" on public.st_conversations;
create policy "st_conversations_insert_own"
  on public.st_conversations for insert
  with check (auth.uid() = user_id);

drop policy if exists "st_conversations_update_own" on public.st_conversations;
create policy "st_conversations_update_own"
  on public.st_conversations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "st_conversations_delete_own" on public.st_conversations;
create policy "st_conversations_delete_own"
  on public.st_conversations for delete
  using (auth.uid() = user_id);

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

drop policy if exists "st_messages_select_own" on public.st_messages;
create policy "st_messages_select_own"
  on public.st_messages for select
  using (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "st_messages_insert_own" on public.st_messages;
create policy "st_messages_insert_own"
  on public.st_messages for insert
  with check (
    exists (
      select 1 from public.st_conversations c
      where c.id = st_messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists "st_messages_update_own" on public.st_messages;
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

drop policy if exists "st_messages_delete_own" on public.st_messages;
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
-- usage_log  (0003)
-- =========================================================================
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

create index if not exists usage_log_user_created_at_idx
  on public.usage_log (user_id, created_at desc);

alter table public.usage_log enable row level security;

drop policy if exists "usage_log_select_own" on public.usage_log;
create policy "usage_log_select_own"
  on public.usage_log for select
  using (auth.uid() = user_id);

drop policy if exists "usage_log_insert_own" on public.usage_log;
create policy "usage_log_insert_own"
  on public.usage_log for insert
  with check (auth.uid() = user_id);

-- =========================================================================
-- PostgREST schema cache reload, damit /rest/v1 die neuen Tabellen sofort sieht
-- =========================================================================
notify pgrst, 'reload schema';
