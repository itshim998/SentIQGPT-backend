-- SentIQ Chat guest text trial quota.
--
-- RUN ON: Control database (Database 1).
--
-- Guest chat is intentionally a small, sign-in-oriented trial. It uses one
-- lifetime 8,000-token text allowance per anonymous billing identity, shared
-- across Standard/Lite fallback routes and isolated from signed-in plan usage.
-- Existing billing tables are reused so request-id uniqueness, reservation
-- lifecycle, auditability, and service-role-only access stay consistent.

create or replace function public.get_guest_text_usage_summary(
    p_anonymous_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'guest-text-trial-v1';
    v_limit constant integer := 8000;
    v_used integer := 0;
    v_reserved integer := 0;
    v_remaining integer := 0;
begin
    if nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is null then
      raise exception 'anonymous_key_hash is required';
    end if;

    update public.quota_reservations
    set status = 'released',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('guest_expired_reclaimed', true),
        updated_at = now()
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and status = 'reserved'
      and reservation_expires_at <= now()
      and metadata ->> 'quota_policy_version' = v_policy_version;

    select coalesce(sum(units), 0)
    into v_used
    from public.usage_events
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and metadata ->> 'quota_policy_version' = v_policy_version;

    select coalesce(sum(units), 0)
    into v_reserved
    from public.quota_reservations
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and status = 'reserved'
      and reservation_expires_at > now()
      and metadata ->> 'quota_policy_version' = v_policy_version;

    v_remaining := greatest(0, v_limit - v_used - v_reserved);

    return jsonb_build_object(
      'policy_version', v_policy_version,
      'limit_tokens', v_limit,
      'used_tokens', v_used,
      'active_reserved_tokens', v_reserved,
      'remaining_tokens', v_remaining,
      'fast_available_tokens', v_remaining,
      'intuitive_available_tokens', 0,
      'intuitive_allowed', false,
      'required_mode', 'fast',
      'exhausted', v_remaining <= 0,
      'next_recovery_at', null,
      'full_reset_at', null
    );
end;
$$;

create or replace function public.reserve_guest_text_tokens(
    p_anonymous_key_hash text,
    p_feature text,
    p_requested_tokens integer,
    p_minimum_tokens integer,
    p_request_id text,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'guest-text-trial-v1';
    v_limit constant integer := 8000;
    v_used integer := 0;
    v_reserved integer := 0;
    v_available integer := 0;
    v_reservation_tokens integer := 0;
    v_ttl_seconds integer := 600;
    v_existing public.quota_reservations%rowtype;
begin
    if nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is null then
      raise exception 'anonymous_key_hash is required';
    end if;
    if p_feature not in ('premium_text', 'lite_text') then
      return jsonb_build_object('reserved', false, 'reason', 'feature_not_supported');
    end if;
    if p_requested_tokens is null or p_requested_tokens <= 0 then
      raise exception 'requested_tokens must be positive';
    end if;
    if nullif(trim(coalesce(p_request_id, '')), '') is null then
      raise exception 'request_id is required';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('sentiq:guest-text:' || p_anonymous_key_hash, 0));

    update public.quota_reservations
    set status = 'released',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('guest_expired_reclaimed', true),
        updated_at = now()
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and status = 'reserved'
      and reservation_expires_at <= now()
      and metadata ->> 'quota_policy_version' = v_policy_version;

    select * into v_existing
    from public.quota_reservations
    where request_id = p_request_id
    limit 1;

    if v_existing.id is not null then
      if v_existing.user_id is null
         and v_existing.anonymous_key_hash = p_anonymous_key_hash
         and v_existing.metadata ->> 'quota_policy_version' = v_policy_version then
        return jsonb_build_object(
          'reserved', v_existing.status in ('reserved', 'committed'),
          'idempotent', true,
          'reservation_id', v_existing.id,
          'status', v_existing.status,
          'feature', v_existing.feature,
          'plan_code', 'free',
          'reservation_tokens', v_existing.units,
          'reservation_units', v_existing.units,
          'limit_tokens', v_limit,
          'limit', v_limit
        );
      end if;
      return jsonb_build_object('reserved', false, 'reason', 'request_identity_mismatch');
    end if;

    select coalesce(sum(units), 0)
    into v_used
    from public.usage_events
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and metadata ->> 'quota_policy_version' = v_policy_version;

    select coalesce(sum(units), 0)
    into v_reserved
    from public.quota_reservations
    where user_id is null
      and anonymous_key_hash = p_anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and status = 'reserved'
      and reservation_expires_at > now()
      and metadata ->> 'quota_policy_version' = v_policy_version;

    v_available := greatest(0, v_limit - v_used - v_reserved);
    v_reservation_tokens := least(greatest(0, p_requested_tokens), v_available);

    if v_reservation_tokens < greatest(1, coalesce(p_minimum_tokens, 1)) then
      return jsonb_build_object(
        'reserved', false,
        'reason', case when v_available <= 0 then 'guest_text_quota_exhausted' else 'guest_text_insufficient_for_request' end,
        'feature', p_feature,
        'plan_code', 'free',
        'used_tokens', v_used,
        'active_reserved_tokens', v_reserved,
        'limit_tokens', v_limit,
        'remaining_tokens', v_available,
        'used', v_used,
        'reserved_units', v_reserved,
        'limit', v_limit,
        'remaining', v_available,
        'required_mode', 'fast',
        'next_recovery_at', null,
        'reset_at', null
      );
    end if;

    if p_metadata ? 'ttl_seconds' then
      v_ttl_seconds := greatest(30, least(3600, (p_metadata ->> 'ttl_seconds')::integer));
    end if;

    insert into public.quota_reservations (
      user_id,
      anonymous_key_hash,
      plan_code,
      feature,
      units,
      request_id,
      metadata,
      reservation_expires_at
    ) values (
      null,
      p_anonymous_key_hash,
      'free',
      p_feature,
      v_reservation_tokens,
      p_request_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'quota_policy_version', v_policy_version,
        'guest_text_trial', true,
        'execution_mode', 'fast'
      ),
      now() + make_interval(secs => v_ttl_seconds)
    )
    returning * into v_existing;

    return jsonb_build_object(
      'reserved', true,
      'idempotent', false,
      'reservation_id', v_existing.id,
      'status', v_existing.status,
      'feature', p_feature,
      'plan_code', 'free',
      'reservation_tokens', v_reservation_tokens,
      'reservation_units', v_reservation_tokens,
      'used_tokens', v_used,
      'active_reserved_tokens', v_reserved + v_reservation_tokens,
      'remaining_tokens', greatest(0, v_available - v_reservation_tokens),
      'used', v_used,
      'reserved_units', v_reserved + v_reservation_tokens,
      'limit_tokens', v_limit,
      'limit', v_limit,
      'remaining', greatest(0, v_available - v_reservation_tokens),
      'required_mode', 'fast',
      'next_recovery_at', null,
      'reset_at', null
    );
end;
$$;

create or replace function public.commit_guest_text_tokens(
    p_request_id text,
    p_reservation_id uuid,
    p_actual_tokens integer,
    p_provider text default null,
    p_model text default null,
    p_route text default null,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'guest-text-trial-v1';
    v_limit constant integer := 8000;
    v_reservation public.quota_reservations%rowtype;
    v_event public.usage_events%rowtype;
    v_used integer := 0;
    v_other_reserved integer := 0;
    v_requested_actual integer := 0;
    v_settled integer := 0;
    v_merged_metadata jsonb := '{}'::jsonb;
begin
    select * into v_reservation
    from public.quota_reservations
    where (nullif(trim(coalesce(p_request_id, '')), '') is not null and request_id = p_request_id)
       or (p_reservation_id is not null and id = p_reservation_id)
    order by case when request_id = p_request_id then 0 else 1 end
    limit 1
    for update;

    if v_reservation.id is null
       or v_reservation.user_id is not null
       or v_reservation.metadata ->> 'quota_policy_version' <> v_policy_version then
      return jsonb_build_object('matched', false, 'committed', false, 'reason', 'reservation_not_found');
    end if;

    if v_reservation.status = 'released' then
      return jsonb_build_object('matched', true, 'committed', false, 'reason', 'reservation_released');
    end if;

    if v_reservation.status = 'committed' then
      select * into v_event from public.usage_events where request_id = v_reservation.request_id limit 1;
      return jsonb_build_object(
        'matched', true,
        'committed', true,
        'idempotent', true,
        'reservation_id', v_reservation.id,
        'usage_event_id', v_event.id,
        'actual_tokens', coalesce(v_event.units, v_reservation.units),
        'settled_units', coalesce(v_event.units, v_reservation.units),
        'released_tokens', greatest(0, v_reservation.units - coalesce(v_event.units, v_reservation.units)),
        'released_units', greatest(0, v_reservation.units - coalesce(v_event.units, v_reservation.units))
      );
    end if;

    perform pg_advisory_xact_lock(hashtextextended('sentiq:guest-text:' || v_reservation.anonymous_key_hash, 0));

    select coalesce(sum(units), 0)
    into v_used
    from public.usage_events
    where user_id is null
      and anonymous_key_hash = v_reservation.anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and metadata ->> 'quota_policy_version' = v_policy_version;

    select coalesce(sum(units), 0)
    into v_other_reserved
    from public.quota_reservations
    where id <> v_reservation.id
      and user_id is null
      and anonymous_key_hash = v_reservation.anonymous_key_hash
      and feature in ('premium_text', 'lite_text')
      and status = 'reserved'
      and reservation_expires_at > now()
      and metadata ->> 'quota_policy_version' = v_policy_version;

    v_requested_actual := greatest(1, coalesce(p_actual_tokens, v_reservation.units));
    v_settled := greatest(1, least(
      v_requested_actual,
      greatest(1, v_limit - v_used - v_other_reserved)
    ));

    v_merged_metadata := coalesce(v_reservation.metadata, '{}'::jsonb)
      || coalesce(p_metadata, '{}'::jsonb)
      || jsonb_build_object(
        'quota_policy_version', v_policy_version,
        'guest_text_trial', true,
        'actual_token_units', v_requested_actual,
        'usage_overrun_tokens', greatest(0, v_requested_actual - v_reservation.units)
      );

    insert into public.usage_events (
      user_id,
      anonymous_key_hash,
      plan_code,
      feature,
      units,
      provider,
      model,
      safe_model_label,
      route,
      conversation_id,
      client_request_id,
      request_id,
      metadata
    ) values (
      null,
      v_reservation.anonymous_key_hash,
      'free',
      v_reservation.feature,
      v_settled,
      p_provider,
      p_model,
      coalesce(v_merged_metadata ->> 'safe_model_label', 'Text'),
      p_route,
      coalesce(v_merged_metadata ->> 'conversation_id', null),
      coalesce(v_merged_metadata ->> 'client_request_id', null),
      v_reservation.request_id,
      v_merged_metadata
    ) on conflict (request_id) where request_id is not null do update set
      metadata = public.usage_events.metadata || excluded.metadata
    returning * into v_event;

    update public.quota_reservations
    set status = 'committed',
        units = v_settled,
        metadata = v_merged_metadata,
        updated_at = now()
    where id = v_reservation.id;

    return jsonb_build_object(
      'matched', true,
      'committed', true,
      'idempotent', false,
      'reservation_id', v_reservation.id,
      'usage_event_id', v_event.id,
      'actual_tokens', v_settled,
      'settled_units', v_settled,
      'released_tokens', greatest(0, v_reservation.units - v_settled),
      'released_units', greatest(0, v_reservation.units - v_settled),
      'usage_overrun_tokens', greatest(0, v_requested_actual - v_reservation.units),
      'remaining_tokens', greatest(0, v_limit - v_used - v_settled - v_other_reserved)
    );
end;
$$;

create or replace function public.release_guest_text_tokens(
    p_request_id text,
    p_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'guest-text-trial-v1';
    v_reservation public.quota_reservations%rowtype;
begin
    select * into v_reservation
    from public.quota_reservations
    where (nullif(trim(coalesce(p_request_id, '')), '') is not null and request_id = p_request_id)
       or (p_reservation_id is not null and id = p_reservation_id)
    order by case when request_id = p_request_id then 0 else 1 end
    limit 1
    for update;

    if v_reservation.id is null
       or v_reservation.user_id is not null
       or v_reservation.metadata ->> 'quota_policy_version' <> v_policy_version then
      return jsonb_build_object('matched', false, 'released', false, 'idempotent', true, 'reason', 'reservation_not_found');
    end if;

    if v_reservation.status in ('released', 'committed') then
      return jsonb_build_object(
        'matched', true,
        'released', v_reservation.status = 'released',
        'idempotent', true,
        'reservation_id', v_reservation.id,
        'status', v_reservation.status,
        'released_tokens', case when v_reservation.status = 'released' then v_reservation.units else 0 end,
        'released_units', case when v_reservation.status = 'released' then v_reservation.units else 0 end
      );
    end if;

    update public.quota_reservations
    set status = 'released', updated_at = now()
    where id = v_reservation.id;

    return jsonb_build_object(
      'matched', true,
      'released', true,
      'idempotent', false,
      'reservation_id', v_reservation.id,
      'released_tokens', v_reservation.units,
      'released_units', v_reservation.units
    );
end;
$$;

revoke all on function public.get_guest_text_usage_summary(text) from public, anon, authenticated;
revoke all on function public.reserve_guest_text_tokens(text,text,integer,integer,text,jsonb) from public, anon, authenticated;
revoke all on function public.commit_guest_text_tokens(text,uuid,integer,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.release_guest_text_tokens(text,uuid) from public, anon, authenticated;

grant execute on function public.get_guest_text_usage_summary(text) to service_role;
grant execute on function public.reserve_guest_text_tokens(text,text,integer,integer,text,jsonb) to service_role;
grant execute on function public.commit_guest_text_tokens(text,uuid,integer,text,text,text,jsonb) to service_role;
grant execute on function public.release_guest_text_tokens(text,uuid) to service_role;
