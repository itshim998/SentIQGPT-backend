\set ON_ERROR_STOP on

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create table public.users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  plan text not null default 'free',
  user_memory_usage_bytes bigint not null default 0
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  unique(id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now(),
  client_request_id text,
  message_type text
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('identity', 'preference', 'project')),
  summary text not null,
  importance integer not null check (importance between 1 and 10),
  created_at timestamptz not null default now(),
  scope text not null default 'global',
  chat_id uuid null references public.conversations(id) on delete cascade,
  embedding jsonb,
  embedding_model text,
  embedding_created_at timestamptz,
  embedding_backfill_requested_at timestamptz,
  embedding_backfill_attempts integer not null default 0,
  embedding_backfill_last_attempt_at timestamptz,
  embedding_backfill_error text,
  automatic_idempotency_key text
);

create unique index idx_memories_user_automatic_idempotency_key
  on public.memories(user_id, automatic_idempotency_key)
  where automatic_idempotency_key is not null;

create table public.context_capsules (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  scope text not null,
  conversation_id uuid null references public.conversations(id) on delete cascade,
  content text not null,
  source_message_count integer not null default 0,
  source_cursor text,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table public.source_documents (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  conversation_id uuid null references public.conversations(id) on delete cascade,
  title text not null,
  original_filename text not null,
  mime_type text not null,
  source_type text not null,
  status text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.ensure_user_exists(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users(id) values (p_user_id) on conflict do nothing;
end;
$$;

insert into public.users(id)
values ('10000000-0000-4000-8000-000000000001');

insert into public.conversations(id, user_id, title)
values (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Active project chat'
);

\i supabase/migrations/20260805150000_improve_memory_hybrid_retrieval.sql
\i supabase/migrations/20260805150050_guard_direct_memory_writes.sql
\i supabase/migrations/20260805150100_upgrade_fast_memory_snapshot.sql

-- First preference.
select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'preference',
  p_summary => 'The user prefers concise answers.',
  p_importance => 8,
  p_scope => 'global',
  p_confidence => 0.8
);

-- Reconfirmation must update the existing row rather than create a duplicate.
select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'preference',
  p_summary => 'The user prefers concise answers.',
  p_importance => 9,
  p_scope => 'global',
  p_confidence => 0.9
);

do $$
declare
  v_count integer;
  v_importance integer;
  v_confidence real;
begin
  select count(*), max(importance), max(confidence)
  into v_count, v_importance, v_confidence
  from public.memories
  where user_id = '10000000-0000-4000-8000-000000000001'
    and subject_key = 'preference:response_length';

  if v_count <> 1 or v_importance <> 9 or v_confidence < 0.89 then
    raise exception 'memory reconfirmation failed: count=% importance=% confidence=%',
      v_count, v_importance, v_confidence;
  end if;
end;
$$;

-- A conflicting preference must supersede the old row.
select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'preference',
  p_summary => 'The user now prefers detailed answers.',
  p_importance => 9,
  p_scope => 'global',
  p_confidence => 0.95
);

do $$
declare
  v_active integer;
  v_superseded integer;
  v_link uuid;
begin
  select
    count(*) filter (where status = 'active'),
    count(*) filter (where status = 'superseded')
  into v_active, v_superseded
  from public.memories
  where user_id = '10000000-0000-4000-8000-000000000001'
    and subject_key = 'preference:response_length';

  select supersedes_memory_id
  into v_link
  from public.memories
  where user_id = '10000000-0000-4000-8000-000000000001'
    and subject_key = 'preference:response_length'
    and status = 'active';

  if v_active <> 1 or v_superseded <> 1 or v_link is null then
    raise exception 'memory supersession failed: active=% superseded=% link=%',
      v_active, v_superseded, v_link;
  end if;
end;
$$;

-- An old exact project memory must be found beyond a recent-window boundary.
insert into public.memories(
  user_id, type, summary, importance, scope, created_at, project_scope
)
values (
  '10000000-0000-4000-8000-000000000001',
  'project',
  'Project Aster uses a deterministic recovery queue for unfinished requests.',
  8,
  'global',
  '2020-01-01T00:00:00Z',
  'Aster'
);

insert into public.memories(user_id, type, summary, importance, scope, created_at)
select
  '10000000-0000-4000-8000-000000000001',
  'project',
  'Recent unrelated project note number ' || series.value,
  4,
  'global',
  now() - make_interval(mins => series.value)
from generate_series(1, 35) as series(value);

-- High-importance stable identity anchor and active-chat state are included even
-- without a lexical hit.
insert into public.memories(user_id, type, summary, importance, scope)
values (
  '10000000-0000-4000-8000-000000000001',
  'identity',
  'The user is a B.Tech AI and ML student.',
  9,
  'global'
);

select *
from public.persist_memory_with_lifecycle(
  p_user_id => '10000000-0000-4000-8000-000000000001',
  p_type => 'project',
  p_summary => 'The next step is to verify the production migration.',
  p_importance => 8,
  p_scope => 'chat',
  p_chat_id => '20000000-0000-4000-8000-000000000001',
  p_source_conversation_id => '20000000-0000-4000-8000-000000000001',
  p_confidence => 0.9
);

create temporary table phase3_aster as
select *
from public.search_memories_lexical(
  '10000000-0000-4000-8000-000000000001',
  'What does Project Aster use?',
  '20000000-0000-4000-8000-000000000001',
  12
);

do $$
begin
  if not exists (
    select 1 from phase3_aster
    where summary like 'Project Aster%'
      and (entity_or_project_match or lexical_rank > 0)
  ) then
    raise exception 'full-collection Project Aster retrieval failed';
  end if;

  if exists (
    select 1 from phase3_aster
    where summary = 'The user prefers concise answers.'
  ) then
    raise exception 'superseded preference leaked into lexical retrieval';
  end if;
end;
$$;

create temporary table phase3_anchor as
select *
from public.search_memories_lexical(
  '10000000-0000-4000-8000-000000000001',
  'What should I focus on?',
  '20000000-0000-4000-8000-000000000001',
  12
);

do $$
begin
  if not exists (
    select 1 from phase3_anchor
    where summary = 'The user is a B.Tech AI and ML student.'
      and anchor_rank > 0
  ) then
    raise exception 'stable identity anchor was not included';
  end if;

  if not exists (
    select 1 from phase3_anchor
    where scope = 'chat'
      and source_conversation_id = '20000000-0000-4000-8000-000000000001'
      and fact_type = 'unresolved_commitment'
  ) then
    raise exception 'active-chat unresolved commitment was not included';
  end if;
end;
$$;

-- Fast mode must consume the same active-only lexical RPC.
create temporary table phase3_snapshot as
select public.get_fast_context_snapshot(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'Project Aster',
  null,
  array[]::uuid[],
  20,
  8,
  12
) as payload;

do $$
declare
  v_payload jsonb;
begin
  select payload into v_payload from phase3_snapshot;
  if (v_payload ->> 'schema_version')::integer <> 2 then
    raise exception 'Fast snapshot schema version was not upgraded: %', v_payload;
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(v_payload -> 'memories') as item(value)
    where item.value ->> 'summary' like 'Project Aster%'
  ) then
    raise exception 'Fast snapshot did not use full-collection memory FTS';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_payload -> 'memories') as item(value)
    where item.value ->> 'summary' = 'The user prefers concise answers.'
  ) then
    raise exception 'Fast snapshot returned a superseded memory';
  end if;
end;
$$;

-- Direct writes remain compatible and receive deterministic metadata.
insert into public.memories(user_id, type, summary, importance, scope)
values (
  '10000000-0000-4000-8000-000000000001',
  'project',
  'Currently testing a temporary branch condition.',
  5,
  'global'
);

do $$
begin
  if not exists (
    select 1
    from public.memories
    where summary = 'Currently testing a temporary branch condition.'
      and subject_key is not null
      and fact_type = 'temporary_condition'
      and last_confirmed_at is not null
  ) then
    raise exception 'direct-write lifecycle guard failed';
  end if;

  if to_regclass('public.memories_search_vector_gin_idx') is null then
    raise exception 'memory GIN index is missing';
  end if;
end;
$$;

select 'phase3-memory-hybrid-postgres-ok' as result;
