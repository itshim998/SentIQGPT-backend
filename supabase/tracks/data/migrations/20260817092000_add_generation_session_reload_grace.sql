-- Phase 15: refresh-safe browser generation sessions.
-- A page close is first marked as close-pending for a short grace window.
-- A reload reuses the same session id from sessionStorage and heartbeats it open.

alter table public.chat_generation_sessions
  add column if not exists close_requested_at timestamptz,
  add column if not exists close_grace_expires_at timestamptz;

create index if not exists chat_generation_sessions_close_grace_idx
  on public.chat_generation_sessions (status, close_grace_expires_at)
  where status = 'open' and close_grace_expires_at is not null;

create or replace function public.attach_latest_generation_session()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_session_id uuid;
  v_requested_session public.chat_generation_sessions%rowtype;
begin
  if new.generation_session_id is not null then
    select * into v_requested_session
    from public.chat_generation_sessions
    where id = new.generation_session_id;

    if v_requested_session.id is not null
       and v_requested_session.status = 'open'
       and v_requested_session.user_id = new.user_id
       and (v_requested_session.close_grace_expires_at is null or v_requested_session.close_grace_expires_at > now()) then
      return new;
    end if;

    new.generation_session_id := null;
  end if;

  select s.id into v_session_id
  from public.chat_generation_sessions s
  where s.status = 'open'
    and s.user_id = new.user_id
    and (s.close_grace_expires_at is null or s.close_grace_expires_at > now())
  order by s.created_at desc
  limit 1;

  new.generation_session_id := v_session_id;
  return new;
end;
$$;

create or replace function public.heartbeat_chat_generation_session(
  p_session_id uuid,
  p_user_id uuid,
  p_anonymous_id text
)
returns public.chat_generation_sessions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.chat_generation_sessions%rowtype;
begin
  update public.chat_generation_sessions
  set last_heartbeat_at = now(),
      close_requested_at = null,
      close_grace_expires_at = null,
      status = 'open'
  where id = p_session_id
    and (user_id = p_user_id or (user_id is null and anonymous_id = nullif(btrim(p_anonymous_id), '')))
    and (status = 'open' or close_grace_expires_at > now())
  returning * into v_row;

  if not found then raise exception 'Generation session not found or closed'; end if;
  return v_row;
end;
$$;

create or replace function public.close_chat_generation_session(
  p_session_id uuid,
  p_user_id uuid,
  p_anonymous_id text
)
returns public.chat_generation_sessions
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row public.chat_generation_sessions%rowtype;
begin
  update public.chat_generation_sessions
  set close_requested_at = coalesce(close_requested_at, now()),
      close_grace_expires_at = coalesce(close_grace_expires_at, now() + interval '12 seconds')
  where id = p_session_id
    and status = 'open'
    and (user_id = p_user_id or (user_id is null and anonymous_id = nullif(btrim(p_anonymous_id), '')))
  returning * into v_row;

  if not found then raise exception 'Generation session not found or already closing'; end if;
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
  set status = 'closed',
      closed_at = coalesce(s.closed_at, now())
  where s.status = 'open'
    and (
      (s.close_grace_expires_at is not null and s.close_grace_expires_at <= now())
      or s.last_heartbeat_at < now() - make_interval(secs => greatest(15, p_lease_seconds))
    )
  returning s.id, s.user_id, s.anonymous_id;
end;
$$;
