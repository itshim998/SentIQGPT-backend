-- SentIQ Chat — Phase 13/14: browser generation session + server lease.
-- Each page gets one generation session. Generations belong to that session.
-- A page-close request is best-effort; the lease closes stale sessions and
-- cancels their active generations when the browser disappears unexpectedly.

create table if not exists public.chat_generation_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  anonymous_id text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint chat_generation_sessions_status_check check (status in ('open', 'closed')),
  constraint chat_generation_sessions_owner_check check (user_id is not null or nullif(btrim(anonymous_id), '') is not null)
);

create index if not exists chat_generation_sessions_user_status_idx
  on public.chat_generation_sessions (user_id, status, last_heartbeat_at desc);
create index if not exists chat_generation_sessions_heartbeat_idx
  on public.chat_generation_sessions (status, last_heartbeat_at desc);

alter table public.chat_generations
  add column if not exists generation_session_id uuid references public.chat_generation_sessions (id) on delete set null;
create index if not exists chat_generations_session_status_idx
  on public.chat_generations (generation_session_id, status, created_at desc)
  where generation_session_id is not null;

alter table public.chat_generation_sessions enable row level security;
drop policy if exists "chat_generation_sessions_service_only" on public.chat_generation_sessions;
create policy "chat_generation_sessions_service_only" on public.chat_generation_sessions for all using (false) with check (false);
revoke all on table public.chat_generation_sessions from public;
revoke all on table public.chat_generation_sessions from anon;
revoke all on table public.chat_generation_sessions from authenticated;
grant all on table public.chat_generation_sessions to service_role;

create or replace function public.open_chat_generation_session(p_user_id uuid, p_anonymous_id text)
returns public.chat_generation_sessions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.chat_generation_sessions%rowtype;
begin
  insert into public.chat_generation_sessions (user_id, anonymous_id, status, last_heartbeat_at)
  values (p_user_id, nullif(btrim(p_anonymous_id), ''), 'open', now())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.heartbeat_chat_generation_session(p_session_id uuid, p_user_id uuid, p_anonymous_id text)
returns public.chat_generation_sessions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.chat_generation_sessions%rowtype;
begin
  update public.chat_generation_sessions
  set last_heartbeat_at = now()
  where id = p_session_id and status = 'open'
    and (user_id = p_user_id or (user_id is null and anonymous_id = nullif(btrim(p_anonymous_id), '')))
  returning * into v_row;
  if not found then raise exception 'Generation session not found or closed'; end if;
  return v_row;
end;
$$;

create or replace function public.close_chat_generation_session(p_session_id uuid, p_user_id uuid, p_anonymous_id text)
returns public.chat_generation_sessions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.chat_generation_sessions%rowtype;
begin
  update public.chat_generation_sessions
  set status = 'closed', closed_at = coalesce(closed_at, now())
  where id = p_session_id
    and (user_id = p_user_id or (user_id is null and anonymous_id = nullif(btrim(p_anonymous_id), '')))
  returning * into v_row;
  if not found then raise exception 'Generation session not found'; end if;
  return v_row;
end;
$$;

create or replace function public.expire_stale_chat_generation_sessions(p_lease_seconds integer default 45)
returns table (session_id uuid, user_id uuid, anonymous_id text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update public.chat_generation_sessions s
  set status = 'closed', closed_at = coalesce(s.closed_at, now())
  where s.status = 'open'
    and s.last_heartbeat_at < now() - make_interval(secs => greatest(15, p_lease_seconds))
  returning s.id, s.user_id, s.anonymous_id;
end;
$$;

create or replace function public.cancel_generations_for_session(p_session_id uuid, p_user_id uuid)
returns setof public.chat_generations
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update public.chat_generations g
  set status = 'cancelled', cancelled_at = coalesce(g.cancelled_at, now())
  where g.generation_session_id = p_session_id
    and g.user_id = p_user_id
    and g.status not in ('completed', 'failed', 'cancelled')
  returning g.*;
end;
$$;

revoke all on function public.open_chat_generation_session(uuid, text) from public;
revoke all on function public.open_chat_generation_session(uuid, text) from anon;
revoke all on function public.open_chat_generation_session(uuid, text) from authenticated;
grant execute on function public.open_chat_generation_session(uuid, text) to service_role;
revoke all on function public.heartbeat_chat_generation_session(uuid, uuid, text) from public;
revoke all on function public.heartbeat_chat_generation_session(uuid, uuid, text) from anon;
revoke all on function public.heartbeat_chat_generation_session(uuid, uuid, text) from authenticated;
grant execute on function public.heartbeat_chat_generation_session(uuid, uuid, text) to service_role;
revoke all on function public.close_chat_generation_session(uuid, uuid, text) from public;
revoke all on function public.close_chat_generation_session(uuid, uuid, text) from anon;
revoke all on function public.close_chat_generation_session(uuid, uuid, text) from authenticated;
grant execute on function public.close_chat_generation_session(uuid, uuid, text) to service_role;
revoke all on function public.expire_stale_chat_generation_sessions(integer) from public;
revoke all on function public.expire_stale_chat_generation_sessions(integer) from anon;
revoke all on function public.expire_stale_chat_generation_sessions(integer) from authenticated;
grant execute on function public.expire_stale_chat_generation_sessions(integer) to service_role;
revoke all on function public.cancel_generations_for_session(uuid, uuid) from public;
revoke all on function public.cancel_generations_for_session(uuid, uuid) from anon;
revoke all on function public.cancel_generations_for_session(uuid, uuid) from authenticated;
grant execute on function public.cancel_generations_for_session(uuid, uuid) to service_role;
