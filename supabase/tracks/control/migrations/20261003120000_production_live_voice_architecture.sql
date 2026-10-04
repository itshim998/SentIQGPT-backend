-- SentIQ Live Production Architecture Migration
--
-- 1. Expands key_slot constraint to support 6+ keys on public.live_sessions and public.live_capacity_leases.
-- 2. Adds source_conversation_id, live_conversation_id, and transcript_committed columns to public.live_sessions.
-- 3. Creates public.live_session_transcript_segments table for durable turn persistence.
-- 4. Creates atomic idempotent public.commit_live_session_transcript RPC.
--
-- RUN ON: Database 1 (Control), Database 2 (Data Shard 1), Database 3 (Data Shard 2).

create extension if not exists pgcrypto;

-- 1. Key slot constraint expansion on live_sessions
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'live_sessions_key_slot_check'
      and conrelid = 'public.live_sessions'::regclass
  ) then
    alter table public.live_sessions drop constraint live_sessions_key_slot_check;
  end if;
  alter table public.live_sessions
    add constraint live_sessions_key_slot_check check (key_slot is null or key_slot >= 1);
end $$;

-- 2. Key slot constraint expansion on live_capacity_leases (if table exists on this database)
do $$
begin
  if exists (
    select 1 from pg_tables
    where schemaname = 'public' and tablename = 'live_capacity_leases'
  ) then
    if exists (
      select 1 from pg_constraint
      where conname = 'live_capacity_leases_key_slot_check'
        and conrelid = 'public.live_capacity_leases'::regclass
    ) then
      alter table public.live_capacity_leases drop constraint live_capacity_leases_key_slot_check;
    end if;
    alter table public.live_capacity_leases
      add constraint live_capacity_leases_key_slot_check check (key_slot >= 1);
  end if;
end $$;

-- 3. Fresh-chat separation & transcript status columns on public.live_sessions
alter table public.live_sessions
  add column if not exists source_conversation_id uuid,
  add column if not exists live_conversation_id uuid,
  add column if not exists transcript_committed boolean not null default false,
  add column if not exists transcript_committed_at timestamptz;

create index if not exists live_sessions_live_conversation_idx
  on public.live_sessions(live_conversation_id)
  where live_conversation_id is not null;

create index if not exists live_sessions_source_conversation_idx
  on public.live_sessions(source_conversation_id)
  where source_conversation_id is not null;

-- 4. Dedicated durable live session transcript segments table
create table if not exists public.live_session_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_sessions(session_id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  role text not null check (role in ('user', 'assistant', 'system')),
  text text not null,
  created_at timestamptz not null default now(),
  constraint live_session_transcript_segments_session_seq_unique unique (session_id, sequence)
);

create index if not exists live_session_transcript_segments_session_idx
  on public.live_session_transcript_segments(session_id, sequence);

alter table public.live_session_transcript_segments enable row level security;

drop policy if exists "live_session_transcript_segments_select_own" on public.live_session_transcript_segments;
create policy "live_session_transcript_segments_select_own"
on public.live_session_transcript_segments
for select
using (
  exists (
    select 1 from public.live_sessions s
    where s.session_id = live_session_transcript_segments.session_id
      and s.owner_user_id = auth.uid()
  )
);

revoke all on table public.live_session_transcript_segments from public, anon, authenticated;
grant select on table public.live_session_transcript_segments to authenticated;
grant all on table public.live_session_transcript_segments to service_role;

-- 5. Atomic idempotent transcript commit RPC
create or replace function public.commit_live_session_transcript(
  p_session_id uuid,
  p_owner_user_id uuid,
  p_conversation_id uuid,
  p_segments jsonb default '[]'::jsonb,
  p_summary text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.live_sessions%rowtype;
  v_segment record;
begin
  if p_session_id is null or p_owner_user_id is null then
    raise exception 'session_id and owner_user_id are required';
  end if;

  select * into v_session
  from public.live_sessions
  where session_id = p_session_id
    and owner_user_id = p_owner_user_id
  for update;

  if not found then
    raise exception 'live_session_not_found';
  end if;

  if v_session.transcript_committed then
    return jsonb_build_object(
      'success', true,
      'already_committed', true,
      'session_id', p_session_id,
      'conversation_id', coalesce(v_session.live_conversation_id, p_conversation_id)
    );
  end if;

  update public.live_sessions
  set transcript_committed = true,
      transcript_committed_at = now(),
      live_conversation_id = coalesce(live_conversation_id, p_conversation_id)
  where session_id = p_session_id;

  if p_segments is not null and jsonb_typeof(p_segments) = 'array' and jsonb_array_length(p_segments) > 0 then
    for v_segment in
      select
        coalesce((elem->>'sequence')::integer, ord::integer - 1) as sequence,
        case when (elem->>'role') in ('user', 'assistant', 'system') then (elem->>'role') else 'assistant' end as role,
        coalesce(elem->>'text', '') as text
      from jsonb_array_elements(p_segments) with ordinality as arr(elem, ord)
      where coalesce(elem->>'text', '') <> ''
    loop
      insert into public.live_session_transcript_segments (
        session_id,
        sequence,
        role,
        text
      ) values (
        p_session_id,
        v_segment.sequence,
        v_segment.role,
        v_segment.text
      )
      on conflict (session_id, sequence) do update
        set text = excluded.text;
    end loop;
  end if;

  return jsonb_build_object(
    'success', true,
    'already_committed', false,
    'session_id', p_session_id,
    'conversation_id', coalesce(v_session.live_conversation_id, p_conversation_id)
  );
end;
$$;

revoke all on function public.commit_live_session_transcript(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.commit_live_session_transcript(uuid, uuid, uuid, jsonb, text) to service_role;
