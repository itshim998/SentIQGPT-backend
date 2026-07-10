-- SentIQ Live setup-failure refund hardening.
--
-- RUN ON: Database 1, 2, 3, 4.
-- A provider can acknowledge setup and then reject the WebSocket before the
-- first usable audio second. A failed handshake must not consume one of the
-- user's daily sessions.

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
  final_status text;
  refund_failed_start boolean;
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
  refund_failed_start := p_status <> 'timeout'
    and finalized_seconds = 0
    and coalesce(p_metadata->>'end_reason', '') in (
      'websocket_failed',
      'audio_start_failed',
      'mic_blocked'
    );
  final_status := case
    when refund_failed_start then 'cancelled'
    when p_status = 'timeout' then 'timeout'
    else 'ended'
  end;
  session_usage_date := (session_row.started_at at time zone 'UTC')::date;

  update public.live_sessions
  set status = final_status,
      ended_at = now(),
      used_seconds = finalized_seconds,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
        || case when refund_failed_start
          then jsonb_build_object('startup_refunded', true)
          else '{}'::jsonb
        end
  where session_id = p_session_id;

  update public.live_daily_usage
  set sessions_started = greatest(
        0,
        sessions_started - case when refund_failed_start then 1 else 0 end
      ),
      seconds_reserved = greatest(0, seconds_reserved - session_row.reserved_seconds),
      seconds_used = seconds_used + finalized_seconds,
      updated_at = now()
  where owner_user_id = p_owner_user_id
    and usage_date = session_usage_date;

  return jsonb_build_object(
    'found', true,
    'finalized', true,
    'status', final_status,
    'used_seconds', finalized_seconds,
    'reserved_seconds', session_row.reserved_seconds
  );
end;
$$;

-- Repair already-finalized zero-second WebSocket failures. Reserved time was
-- already released by the previous finalizer, so only return the session count.
with refunded as (
  update public.live_sessions
  set status = 'cancelled',
      metadata = metadata || jsonb_build_object(
        'startup_refunded', true,
        'refunded_by', '20260710190000'
      )
  where status = 'ended'
    and used_seconds = 0
    and metadata->>'end_reason' = 'websocket_failed'
  returning owner_user_id, (started_at at time zone 'UTC')::date as usage_date
), refund_counts as (
  select owner_user_id, usage_date, count(*)::integer as session_count
  from refunded
  group by owner_user_id, usage_date
)
update public.live_daily_usage as usage
set sessions_started = greatest(0, usage.sessions_started - refunds.session_count),
    updated_at = now()
from refund_counts as refunds
where usage.owner_user_id = refunds.owner_user_id
  and usage.usage_date = refunds.usage_date;

revoke all on function public.finalize_live_session(uuid, uuid, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_live_session(uuid, uuid, integer, text, jsonb)
  to service_role;

-- Startup/readiness uses this versioned marker to ensure every shard has the
-- semantic refund change, not merely an older finalize_live_session signature.
create or replace function public.get_sentiq_live_refund_policy_version()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 1;
$$;

revoke all on function public.get_sentiq_live_refund_policy_version()
  from public, anon, authenticated;
grant execute on function public.get_sentiq_live_refund_policy_version()
  to service_role;
