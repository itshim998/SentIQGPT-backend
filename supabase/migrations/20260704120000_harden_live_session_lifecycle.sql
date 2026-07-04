-- SentIQ Live startup/finalization hardening.
--
-- RUN ON: Database 1, 2, 3, 4.
-- Distinguishes a reserved/token-created session from a session whose audio
-- path actually started. Unstarted stale reservations are refunded instead of
-- consuming a full session and its reserved time.

alter table public.live_sessions
  add column if not exists audio_started_at timestamptz;

create or replace function public.mark_live_session_started(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_grace_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  session_row public.live_sessions%rowtype;
  effective_started_at timestamptz;
  effective_expires_at timestamptz;
  was_started boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('sentiq-live-user:' || p_owner_user_id::text, 0));
  select * into session_row
  from public.live_sessions
  where session_id = p_session_id
    and owner_user_id = p_owner_user_id
  for update;

  if session_row.session_id is null then
    return jsonb_build_object('found', false, 'started', false);
  end if;

  if session_row.status <> 'active' then
    return jsonb_build_object(
      'found', true,
      'started', false,
      'status', session_row.status
    );
  end if;

  was_started := session_row.audio_started_at is not null;
  effective_started_at := coalesce(session_row.audio_started_at, now());
  effective_expires_at := greatest(
    session_row.expires_at,
    effective_started_at + make_interval(secs => session_row.reserved_seconds + greatest(5, p_grace_seconds))
  );

  update public.live_sessions
  set audio_started_at = effective_started_at,
      expires_at = effective_expires_at,
      metadata = metadata || jsonb_build_object('audio_started', true)
  where session_id = p_session_id;

  return jsonb_build_object(
    'found', true,
    'started', true,
    'already_started', was_started,
    'audio_started_at', effective_started_at,
    'expires_at', effective_expires_at
  );
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

  if session_row.session_id is null
    or session_row.status not in ('provisioning', 'active')
    or session_row.audio_started_at is not null then
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
    select session_id, owner_user_id, reserved_seconds, started_at, audio_started_at
    from public.live_sessions
    where status in ('provisioning', 'active')
      and expires_at <= now()
      and (p_owner_user_id is null or owner_user_id = p_owner_user_id)
    order by expires_at
    for update skip locked
  loop
    session_usage_date := (stale_session.started_at at time zone 'UTC')::date;

    if stale_session.audio_started_at is null then
      update public.live_sessions
      set status = 'cancelled',
          ended_at = now(),
          used_seconds = 0,
          metadata = metadata || jsonb_build_object('finalized_by', 'stale_startup_cleanup')
      where session_id = stale_session.session_id
        and status in ('provisioning', 'active');

      if found then
        update public.live_daily_usage
        set sessions_started = greatest(0, sessions_started - 1),
            seconds_reserved = greatest(0, seconds_reserved - stale_session.reserved_seconds),
            updated_at = now()
        where owner_user_id = stale_session.owner_user_id
          and usage_date = session_usage_date;
        cleaned_count := cleaned_count + 1;
      end if;
    else
      update public.live_sessions
      set status = 'timeout',
          ended_at = now(),
          used_seconds = reserved_seconds,
          metadata = metadata || jsonb_build_object('finalized_by', 'stale_cleanup')
      where session_id = stale_session.session_id
        and status in ('provisioning', 'active');

      if found then
        update public.live_daily_usage
        set seconds_reserved = greatest(0, seconds_reserved - stale_session.reserved_seconds),
            seconds_used = seconds_used + stale_session.reserved_seconds,
            updated_at = now()
        where owner_user_id = stale_session.owner_user_id
          and usage_date = session_usage_date;
        cleaned_count := cleaned_count + 1;
      end if;
    end if;
  end loop;

  return cleaned_count;
end;
$$;

revoke all on function public.mark_live_session_started(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.cancel_live_session_reservation(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_live_session_started(uuid, uuid, integer) to service_role;
grant execute on function public.cancel_live_session_reservation(uuid, uuid, text) to service_role;
