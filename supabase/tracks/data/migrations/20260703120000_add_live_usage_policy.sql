-- SentIQ Live durable quota/session ledger and cross-instance capacity leases.
--
-- RUN ON: Database 1, 2, 3, 4.
-- User session/usage rows are used on data shards. Capacity leases are used on
-- the control database so optional global/per-project limits remain atomic.

create extension if not exists pgcrypto;

create table if not exists public.live_sessions (
  session_id uuid primary key,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  plan text not null check (plan in ('free', 'student_core', 'premium', 'pro')),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'ended', 'timeout', 'cancelled')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  expires_at timestamptz not null,
  reserved_seconds integer not null check (reserved_seconds >= 0),
  used_seconds integer not null default 0 check (used_seconds >= 0),
  key_slot smallint check (key_slot between 1 and 5),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists live_sessions_owner_status_idx
  on public.live_sessions(owner_user_id, status, started_at desc);

create index if not exists live_sessions_active_expiry_idx
  on public.live_sessions(expires_at)
  where status in ('provisioning', 'active');

create table if not exists public.live_daily_usage (
  owner_user_id uuid not null references public.users(id) on delete cascade,
  usage_date date not null,
  plan text not null check (plan in ('free', 'student_core', 'premium', 'pro')),
  sessions_started integer not null default 0 check (sessions_started >= 0),
  seconds_used integer not null default 0 check (seconds_used >= 0),
  seconds_reserved integer not null default 0 check (seconds_reserved >= 0),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, usage_date)
);

create table if not exists public.live_capacity_leases (
  session_id uuid primary key,
  key_slot smallint not null check (key_slot between 1 and 5),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists live_capacity_leases_slot_expiry_idx
  on public.live_capacity_leases(key_slot, expires_at);

alter table public.live_sessions enable row level security;
alter table public.live_daily_usage enable row level security;
alter table public.live_capacity_leases enable row level security;

drop policy if exists "live_sessions_select_own" on public.live_sessions;
create policy "live_sessions_select_own"
on public.live_sessions
for select
using (owner_user_id = auth.uid());

drop policy if exists "live_daily_usage_select_own" on public.live_daily_usage;
create policy "live_daily_usage_select_own"
on public.live_daily_usage
for select
using (owner_user_id = auth.uid());

revoke all on table public.live_sessions from public, anon, authenticated;
revoke all on table public.live_daily_usage from public, anon, authenticated;
revoke all on table public.live_capacity_leases from public, anon, authenticated;
grant select on table public.live_sessions to authenticated;
grant select on table public.live_daily_usage to authenticated;
grant all on table public.live_sessions to service_role;
grant all on table public.live_daily_usage to service_role;
grant all on table public.live_capacity_leases to service_role;

create or replace function public.cleanup_stale_live_sessions(p_owner_user_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  stale_session record;
  cleaned_count integer := 0;
  session_usage_date date;
begin
  for stale_session in
    select session_id, owner_user_id, reserved_seconds, started_at
    from public.live_sessions
    where status in ('provisioning', 'active')
      and expires_at <= now()
      and (p_owner_user_id is null or owner_user_id = p_owner_user_id)
    order by expires_at
    for update skip locked
  loop
    update public.live_sessions
    set status = 'timeout',
        ended_at = now(),
        used_seconds = reserved_seconds,
        metadata = metadata || jsonb_build_object('finalized_by', 'stale_cleanup')
    where session_id = stale_session.session_id
      and status in ('provisioning', 'active');

    if found then
      session_usage_date := (stale_session.started_at at time zone 'UTC')::date;
      update public.live_daily_usage
      set seconds_reserved = greatest(0, seconds_reserved - stale_session.reserved_seconds),
          seconds_used = seconds_used + stale_session.reserved_seconds,
          updated_at = now()
      where owner_user_id = stale_session.owner_user_id
        and usage_date = session_usage_date;
      cleaned_count := cleaned_count + 1;
    end if;
  end loop;

  return cleaned_count;
end;
$$;

create or replace function public.reserve_live_session(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_plan text,
  p_daily_seconds integer,
  p_daily_sessions integer,
  p_max_active integer,
  p_reserve_seconds integer,
  p_grace_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  usage_row public.live_daily_usage%rowtype;
  today_utc date := (now() at time zone 'UTC')::date;
  active_count integer := 0;
  remaining_seconds integer := 0;
  reserved_seconds integer := 0;
  reset_at timestamptz := ((now() at time zone 'UTC')::date + 1)::timestamp at time zone 'UTC';
begin
  if p_owner_user_id is null or p_session_id is null then
    return jsonb_build_object('allowed', false, 'denial_reason', 'invalid_request');
  end if;

  if p_plan not in ('free', 'student_core', 'premium', 'pro') then
    p_plan := 'free';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('sentiq-live-user:' || p_owner_user_id::text, 0));
  perform public.cleanup_stale_live_sessions(p_owner_user_id);

  insert into public.live_daily_usage (owner_user_id, usage_date, plan)
  values (p_owner_user_id, today_utc, p_plan)
  on conflict (owner_user_id, usage_date) do update
    set plan = excluded.plan,
        updated_at = now();

  select * into usage_row
  from public.live_daily_usage
  where owner_user_id = p_owner_user_id
    and usage_date = today_utc
  for update;

  select count(*)::integer into active_count
  from public.live_sessions
  where owner_user_id = p_owner_user_id
    and status in ('provisioning', 'active')
    and expires_at > now();

  if p_daily_sessions <= 0 or usage_row.sessions_started >= p_daily_sessions then
    return jsonb_build_object(
      'allowed', false,
      'denial_reason', 'daily_sessions',
      'sessions_started', usage_row.sessions_started,
      'seconds_used', usage_row.seconds_used,
      'seconds_reserved', usage_row.seconds_reserved,
      'active_sessions', active_count,
      'reset_at', reset_at
    );
  end if;

  remaining_seconds := greatest(0, p_daily_seconds - usage_row.seconds_used - usage_row.seconds_reserved);
  if p_daily_seconds <= 0 or remaining_seconds <= 0 then
    return jsonb_build_object(
      'allowed', false,
      'denial_reason', 'daily_time',
      'sessions_started', usage_row.sessions_started,
      'seconds_used', usage_row.seconds_used,
      'seconds_reserved', usage_row.seconds_reserved,
      'active_sessions', active_count,
      'reset_at', reset_at
    );
  end if;

  if p_max_active <= 0 or active_count >= p_max_active then
    return jsonb_build_object(
      'allowed', false,
      'denial_reason', 'active_limit',
      'sessions_started', usage_row.sessions_started,
      'seconds_used', usage_row.seconds_used,
      'seconds_reserved', usage_row.seconds_reserved,
      'active_sessions', active_count,
      'reset_at', reset_at
    );
  end if;

  reserved_seconds := least(remaining_seconds, greatest(0, p_reserve_seconds));
  if reserved_seconds <= 0 then
    return jsonb_build_object('allowed', false, 'denial_reason', 'daily_time', 'reset_at', reset_at);
  end if;

  insert into public.live_sessions (
    session_id,
    owner_user_id,
    plan,
    status,
    reserved_seconds,
    expires_at
  ) values (
    p_session_id,
    p_owner_user_id,
    p_plan,
    'provisioning',
    reserved_seconds,
    now() + make_interval(secs => reserved_seconds + greatest(5, p_grace_seconds))
  );

  update public.live_daily_usage
  set sessions_started = sessions_started + 1,
      seconds_reserved = seconds_reserved + reserved_seconds,
      updated_at = now()
  where owner_user_id = p_owner_user_id
    and usage_date = today_utc
  returning * into usage_row;

  return jsonb_build_object(
    'allowed', true,
    'reserved_seconds', reserved_seconds,
    'sessions_started', usage_row.sessions_started,
    'seconds_used', usage_row.seconds_used,
    'seconds_reserved', usage_row.seconds_reserved,
    'active_sessions', active_count + 1,
    'reset_at', reset_at
  );
exception
  when unique_violation then
    return jsonb_build_object('allowed', false, 'denial_reason', 'duplicate_session');
end;
$$;

create or replace function public.activate_live_session(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_key_slot integer,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.live_sessions
  set status = 'active',
      key_slot = p_key_slot,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where session_id = p_session_id
    and owner_user_id = p_owner_user_id
    and status = 'provisioning';
  return found;
end;
$$;

create or replace function public.cancel_live_session_reservation(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_reason text default 'provisioning_failed'
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.live_sessions%rowtype;
  session_usage_date date;
begin
  perform pg_advisory_xact_lock(hashtextextended('sentiq-live-user:' || p_owner_user_id::text, 0));
  select * into session_row
  from public.live_sessions
  where session_id = p_session_id
    and owner_user_id = p_owner_user_id
  for update;

  if session_row.session_id is null or session_row.status not in ('provisioning', 'active') then
    return false;
  end if;

  update public.live_sessions
  set status = 'cancelled',
      ended_at = now(),
      used_seconds = 0,
      metadata = metadata || jsonb_build_object('cancel_reason', left(coalesce(p_reason, 'provisioning_failed'), 64))
  where session_id = p_session_id;

  session_usage_date := (session_row.started_at at time zone 'UTC')::date;
  update public.live_daily_usage
  set sessions_started = greatest(0, sessions_started - 1),
      seconds_reserved = greatest(0, seconds_reserved - session_row.reserved_seconds),
      updated_at = now()
  where owner_user_id = p_owner_user_id
    and usage_date = session_usage_date;
  return true;
end;
$$;

create or replace function public.finalize_live_session(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_used_seconds integer,
  p_status text default 'ended',
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.live_sessions%rowtype;
  finalized_seconds integer;
  session_usage_date date;
begin
  perform pg_advisory_xact_lock(hashtextextended('sentiq-live-user:' || p_owner_user_id::text, 0));
  select * into session_row
  from public.live_sessions
  where session_id = p_session_id
    and owner_user_id = p_owner_user_id
  for update;

  if session_row.session_id is null then
    return jsonb_build_object('found', false);
  end if;

  if session_row.status not in ('provisioning', 'active') then
    return jsonb_build_object(
      'found', true,
      'finalized', false,
      'status', session_row.status,
      'used_seconds', session_row.used_seconds,
      'reserved_seconds', session_row.reserved_seconds
    );
  end if;

  finalized_seconds := least(session_row.reserved_seconds, greatest(0, coalesce(p_used_seconds, 0)));
  session_usage_date := (session_row.started_at at time zone 'UTC')::date;

  update public.live_sessions
  set status = case when p_status = 'timeout' then 'timeout' else 'ended' end,
      ended_at = now(),
      used_seconds = finalized_seconds,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where session_id = p_session_id;

  update public.live_daily_usage
  set seconds_reserved = greatest(0, seconds_reserved - session_row.reserved_seconds),
      seconds_used = seconds_used + finalized_seconds,
      updated_at = now()
  where owner_user_id = p_owner_user_id
    and usage_date = session_usage_date;

  return jsonb_build_object(
    'found', true,
    'finalized', true,
    'status', case when p_status = 'timeout' then 'timeout' else 'ended' end,
    'used_seconds', finalized_seconds,
    'reserved_seconds', session_row.reserved_seconds
  );
end;
$$;

create or replace function public.reserve_live_capacity(
  p_session_id uuid,
  p_key_slot integer,
  p_global_max_active integer default null,
  p_project_max_active integer default null,
  p_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  global_active integer;
  project_active integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('sentiq-live-capacity', 0));
  delete from public.live_capacity_leases where expires_at <= now();

  if exists (select 1 from public.live_capacity_leases where session_id = p_session_id) then
    return jsonb_build_object('allowed', true, 'existing', true);
  end if;

  select count(*)::integer into global_active from public.live_capacity_leases;
  select count(*)::integer into project_active
  from public.live_capacity_leases
  where key_slot = p_key_slot;

  if p_global_max_active is not null and p_global_max_active > 0 and global_active >= p_global_max_active then
    return jsonb_build_object('allowed', false, 'denial_reason', 'global_capacity');
  end if;

  if p_project_max_active is not null and p_project_max_active > 0 and project_active >= p_project_max_active then
    return jsonb_build_object('allowed', false, 'denial_reason', 'project_capacity');
  end if;

  insert into public.live_capacity_leases (session_id, key_slot, expires_at)
  values (p_session_id, p_key_slot, greatest(coalesce(p_expires_at, now() + interval '11 minutes'), now() + interval '30 seconds'));

  return jsonb_build_object(
    'allowed', true,
    'global_active', global_active + 1,
    'project_active', project_active + 1
  );
end;
$$;

create or replace function public.release_live_capacity(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.live_capacity_leases where session_id = p_session_id;
  return found;
end;
$$;

revoke all on function public.cleanup_stale_live_sessions(uuid) from public, anon, authenticated;
revoke all on function public.reserve_live_session(uuid, uuid, text, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.activate_live_session(uuid, uuid, integer, jsonb) from public, anon, authenticated;
revoke all on function public.cancel_live_session_reservation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_live_session(uuid, uuid, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.reserve_live_capacity(uuid, integer, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.release_live_capacity(uuid) from public, anon, authenticated;

grant execute on function public.cleanup_stale_live_sessions(uuid) to service_role;
grant execute on function public.reserve_live_session(uuid, uuid, text, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.activate_live_session(uuid, uuid, integer, jsonb) to service_role;
grant execute on function public.cancel_live_session_reservation(uuid, uuid, text) to service_role;
grant execute on function public.finalize_live_session(uuid, uuid, integer, text, jsonb) to service_role;
grant execute on function public.reserve_live_capacity(uuid, integer, integer, integer, timestamptz) to service_role;
grant execute on function public.release_live_capacity(uuid) to service_role;

