-- Free unified text-token allowance V2.
--
-- RUN ON: Control database (Database 1).
-- This migration is additive. It preserves the Standard/Lite V1 tables,
-- functions, policy rows, and rollback path.

create extension if not exists pgcrypto;

create table if not exists public.unified_text_reservations_v2 (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    anonymous_key_hash text,
    request_id text not null unique,
    plan_code text not null default 'free' check (plan_code = 'free'),
    policy_version text not null check (policy_version = 'unified-text-tokens-v2'),
    execution_mode text not null check (execution_mode in ('fast', 'intuitive')),
    requested_tokens integer not null check (requested_tokens > 0),
    minimum_tokens integer not null check (minimum_tokens > 0),
    reserved_tokens integer not null check (reserved_tokens > 0),
    actual_tokens integer check (actual_tokens is null or actual_tokens > 0),
    status text not null default 'reserved'
      check (status in ('reserved', 'committed', 'released', 'expired')),
    reservation_expires_at timestamptz not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check ((user_id is not null) <> (anonymous_key_hash is not null))
);

create table if not exists public.unified_text_usage_events_v2 (
    id uuid primary key default gen_random_uuid(),
    reservation_id uuid not null unique
      references public.unified_text_reservations_v2(id),
    user_id uuid,
    anonymous_key_hash text,
    request_id text not null unique,
    plan_code text not null default 'free' check (plan_code = 'free'),
    policy_version text not null check (policy_version = 'unified-text-tokens-v2'),
    execution_mode text not null check (execution_mode in ('fast', 'intuitive')),
    units integer not null check (units > 0),
    usage_overrun_tokens integer not null default 0 check (usage_overrun_tokens >= 0),
    fast_reserve_breach_tokens integer not null default 0 check (fast_reserve_breach_tokens >= 0),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    check ((user_id is not null) <> (anonymous_key_hash is not null))
);

create index if not exists unified_text_usage_v2_user_window_idx
on public.unified_text_usage_events_v2(user_id, created_at desc)
where user_id is not null;

create index if not exists unified_text_usage_v2_anon_window_idx
on public.unified_text_usage_events_v2(anonymous_key_hash, created_at desc)
where anonymous_key_hash is not null;

create index if not exists unified_text_reservations_v2_user_active_idx
on public.unified_text_reservations_v2(user_id, reservation_expires_at)
where user_id is not null and status = 'reserved';

create index if not exists unified_text_reservations_v2_anon_active_idx
on public.unified_text_reservations_v2(anonymous_key_hash, reservation_expires_at)
where anonymous_key_hash is not null and status = 'reserved';

create or replace function public.unified_text_tokens_v2_snapshot(
    p_user_id uuid,
    p_anonymous_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_limit_tokens constant integer := 50000;
    v_window_seconds constant integer := 18000;
    v_fast_reserve_tokens constant integer := 10000;
    v_used_tokens bigint := 0;
    v_v2_used_tokens bigint := 0;
    v_legacy_used_tokens bigint := 0;
    v_active_reserved_tokens bigint := 0;
    v_v2_reserved_tokens bigint := 0;
    v_legacy_reserved_tokens bigint := 0;
    v_remaining_tokens integer := 0;
    v_next_committed_recovery_at timestamptz;
    v_next_reservation_recovery_at timestamptz;
    v_next_recovery_at timestamptz;
    v_full_reset_at timestamptz;
begin
    if (p_user_id is not null) = (nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is not null) then
      raise exception 'exactly one billing identity is required';
    end if;

    with counted_committed as (
      select
        'v2'::text as source,
        greatest(0, units)::bigint as units,
        created_at,
        created_at + make_interval(secs => v_window_seconds) as recovers_at
      from public.unified_text_usage_events_v2
      where policy_version = 'unified-text-tokens-v2'
        and plan_code = 'free'
        and created_at >= now() - make_interval(secs => v_window_seconds)
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
      union all
      select
        'legacy_v1'::text as source,
        greatest(0, units)::bigint as units,
        created_at,
        created_at + make_interval(secs => v_window_seconds) as recovers_at
      from public.usage_events
      where plan_code = 'free'
        and feature in ('premium_text', 'lite_text')
        and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
        and coalesce(metadata ->> 'unified_text_v2_rollback_shadow', 'false') <> 'true'
        and created_at >= now() - make_interval(secs => v_window_seconds)
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
    ),
    counted_reserved as (
      select
        'v2'::text as source,
        greatest(0, reserved_tokens)::bigint as units,
        reservation_expires_at as recovers_at
      from public.unified_text_reservations_v2
      where policy_version = 'unified-text-tokens-v2'
        and plan_code = 'free'
        and status = 'reserved'
        and reservation_expires_at > now()
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
      union all
      select
        'legacy_v1'::text as source,
        greatest(0, units)::bigint as units,
        reservation_expires_at as recovers_at
      from public.quota_reservations
      where plan_code = 'free'
        and feature in ('premium_text', 'lite_text')
        and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
        and status = 'reserved'
        and reservation_expires_at > now()
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
    )
    select
      coalesce((select sum(units) from counted_committed), 0),
      coalesce((select sum(units) from counted_committed where source = 'v2'), 0),
      coalesce((select sum(units) from counted_committed where source = 'legacy_v1'), 0),
      coalesce((select sum(units) from counted_reserved), 0),
      coalesce((select sum(units) from counted_reserved where source = 'v2'), 0),
      coalesce((select sum(units) from counted_reserved where source = 'legacy_v1'), 0),
      (select min(recovers_at) from counted_committed where recovers_at > now()),
      (select min(recovers_at) from counted_reserved where recovers_at > now()),
      (select max(recovers_at) from counted_committed where recovers_at > now())
    into
      v_used_tokens,
      v_v2_used_tokens,
      v_legacy_used_tokens,
      v_active_reserved_tokens,
      v_v2_reserved_tokens,
      v_legacy_reserved_tokens,
      v_next_committed_recovery_at,
      v_next_reservation_recovery_at,
      v_full_reset_at;

    v_remaining_tokens := greatest(
      0,
      v_limit_tokens
        - least(2147483647::bigint, v_used_tokens)
        - least(2147483647::bigint, v_active_reserved_tokens)
    )::integer;
    v_next_recovery_at := case
      when v_next_committed_recovery_at is null then v_next_reservation_recovery_at
      when v_next_reservation_recovery_at is null then v_next_committed_recovery_at
      else least(v_next_committed_recovery_at, v_next_reservation_recovery_at)
    end;

    return jsonb_build_object(
      'policy_version', 'unified-text-tokens-v2',
      'plan_code', 'free',
      'limit_tokens', v_limit_tokens,
      'window_seconds', v_window_seconds,
      'fast_reserve_tokens', v_fast_reserve_tokens,
      'used_tokens', v_used_tokens,
      'canonical_v2_used_tokens', v_v2_used_tokens,
      'legacy_v1_used_tokens', v_legacy_used_tokens,
      'active_reserved_tokens', v_active_reserved_tokens,
      'canonical_v2_reserved_tokens', v_v2_reserved_tokens,
      'legacy_v1_reserved_tokens', v_legacy_reserved_tokens,
      'remaining_tokens', v_remaining_tokens,
      'fast_available_tokens', v_remaining_tokens,
      'intuitive_available_tokens', greatest(0, v_remaining_tokens - v_fast_reserve_tokens),
      'intuitive_allowed', v_remaining_tokens > v_fast_reserve_tokens,
      'required_mode', case
        when v_remaining_tokens > 0 and v_remaining_tokens <= v_fast_reserve_tokens then 'fast'
        else null
      end,
      'exhausted', v_remaining_tokens = 0,
      'next_recovery_at', v_next_recovery_at,
      'full_reset_at', v_full_reset_at
    );
end;
$$;

create or replace function public.reserve_unified_text_tokens_v2(
    p_user_id uuid,
    p_anonymous_key_hash text,
    p_request_id text,
    p_execution_mode text,
    p_requested_tokens integer,
    p_minimum_tokens integer,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'unified-text-tokens-v2';
    v_limit_tokens constant integer := 50000;
    v_window_seconds constant integer := 18000;
    v_fast_reserve_tokens constant integer := 10000;
    v_effective record;
    v_plan_code text;
    v_identity_lock text;
    v_existing public.unified_text_reservations_v2%rowtype;
    v_snapshot jsonb;
    v_remaining_tokens integer;
    v_maximum_reservable integer;
    v_reservation_tokens integer;
    v_ttl_seconds integer := 600;
    v_reclaimed_tokens bigint := 0;
begin
    if (p_user_id is not null) = (nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is not null) then
      raise exception 'exactly one billing identity is required';
    end if;
    if nullif(trim(coalesce(p_request_id, '')), '') is null then
      raise exception 'request_id is required';
    end if;
    if p_execution_mode not in ('fast', 'intuitive') then
      raise exception 'execution_mode must be fast or intuitive';
    end if;
    if p_requested_tokens is null or p_requested_tokens <= 0 then
      raise exception 'requested_tokens must be positive';
    end if;
    if p_minimum_tokens is null or p_minimum_tokens <= 0 then
      raise exception 'minimum_tokens must be positive';
    end if;

    select * into v_effective from public.get_effective_plan(p_user_id) limit 1;
    v_plan_code := coalesce(v_effective.plan_code, 'free');
    if v_plan_code <> 'free' then
      return jsonb_build_object(
        'reserved', false,
        'reason', 'plan_not_eligible',
        'plan_code', v_plan_code,
        'policy_version', v_policy_version
      );
    end if;

    v_identity_lock := case
      when p_user_id is not null then 'user:' || p_user_id::text
      else 'guest:' || p_anonymous_key_hash
    end;
    perform pg_advisory_xact_lock(hashtextextended(
      'sentiq:quota:' || v_policy_version || ':' || v_identity_lock,
      0
    ));
    perform pg_advisory_xact_lock(hashtextextended(
      'sentiq:quota:' || v_policy_version || ':request:' || p_request_id,
      0
    ));

    with reclaimed as (
      update public.unified_text_reservations_v2
      set status = 'expired',
          updated_at = now()
      where policy_version = v_policy_version
        and plan_code = 'free'
        and status = 'reserved'
        and reservation_expires_at <= now()
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
      returning reserved_tokens
    )
    select coalesce(sum(reserved_tokens), 0) into v_reclaimed_tokens from reclaimed;

    select * into v_existing
    from public.unified_text_reservations_v2
    where request_id = p_request_id;

    if v_existing.id is not null then
      if not (
        (p_user_id is not null and v_existing.user_id = p_user_id and v_existing.anonymous_key_hash is null)
        or (
          p_user_id is null
          and v_existing.user_id is null
          and v_existing.anonymous_key_hash = p_anonymous_key_hash
        )
      ) then
        return jsonb_build_object(
          'reserved', false,
          'idempotent', false,
          'reason', 'request_identity_mismatch',
          'plan_code', 'free',
          'policy_version', v_policy_version
        );
      end if;
      if v_existing.execution_mode <> p_execution_mode then
        return jsonb_build_object(
          'reserved', false,
          'idempotent', false,
          'reason', 'request_mode_mismatch',
          'plan_code', 'free',
          'policy_version', v_policy_version
        );
      end if;
      if v_existing.policy_version <> v_policy_version then
        return jsonb_build_object(
          'reserved', false,
          'idempotent', false,
          'reason', 'request_policy_mismatch',
          'plan_code', 'free',
          'policy_version', v_policy_version
        );
      end if;

      v_snapshot := public.unified_text_tokens_v2_snapshot(p_user_id, p_anonymous_key_hash);
      return v_snapshot || jsonb_build_object(
        'reserved', v_existing.status in ('reserved', 'committed'),
        'idempotent', true,
        'reservation_id', v_existing.id,
        'request_id', v_existing.request_id,
        'status', v_existing.status,
        'execution_mode', v_existing.execution_mode,
        'reservation_tokens', v_existing.reserved_tokens,
        'stale_reclaimed_tokens', v_reclaimed_tokens,
        'reason', case
          when v_existing.status = 'released' then 'reservation_released'
          when v_existing.status = 'expired' then 'reservation_expired'
          else null
        end
      );
    end if;

    v_snapshot := public.unified_text_tokens_v2_snapshot(p_user_id, p_anonymous_key_hash);
    v_remaining_tokens := greatest(0, coalesce((v_snapshot ->> 'remaining_tokens')::integer, 0));
    v_maximum_reservable := case
      when p_execution_mode = 'intuitive'
        then greatest(0, v_remaining_tokens - v_fast_reserve_tokens)
      else v_remaining_tokens
    end;
    v_reservation_tokens := greatest(0, least(p_requested_tokens, v_maximum_reservable));

    if v_reservation_tokens < p_minimum_tokens then
      return v_snapshot || jsonb_build_object(
        'reserved', false,
        'idempotent', false,
        'request_id', p_request_id,
        'execution_mode', p_execution_mode,
        'reservation_tokens', 0,
        'stale_reclaimed_tokens', v_reclaimed_tokens,
        'reason', case
          when v_remaining_tokens = 0 then 'unified_text_quota_exhausted'
          when p_execution_mode = 'intuitive' and v_remaining_tokens <= v_fast_reserve_tokens
            then 'intuitive_fast_required'
          else 'unified_text_insufficient_for_request'
        end
      );
    end if;

    if coalesce(p_metadata, '{}'::jsonb) ? 'ttl_seconds' then
      v_ttl_seconds := greatest(
        60,
        least(1800, coalesce((p_metadata ->> 'ttl_seconds')::integer, 600))
      );
    end if;

    insert into public.unified_text_reservations_v2 (
      user_id,
      anonymous_key_hash,
      request_id,
      plan_code,
      policy_version,
      execution_mode,
      requested_tokens,
      minimum_tokens,
      reserved_tokens,
      status,
      reservation_expires_at,
      metadata
    ) values (
      p_user_id,
      case when p_user_id is null then p_anonymous_key_hash else null end,
      p_request_id,
      'free',
      v_policy_version,
      p_execution_mode,
      p_requested_tokens,
      p_minimum_tokens,
      v_reservation_tokens,
      'reserved',
      now() + make_interval(secs => v_ttl_seconds),
      jsonb_build_object(
        'policy_version', v_policy_version,
        'requested_tokens', p_requested_tokens,
        'minimum_tokens', p_minimum_tokens,
        'post_reservation_remaining_tokens',
          greatest(0, v_remaining_tokens - v_reservation_tokens)
      )
    ) returning * into v_existing;

    v_snapshot := public.unified_text_tokens_v2_snapshot(p_user_id, p_anonymous_key_hash);
    return v_snapshot || jsonb_build_object(
      'reserved', true,
      'idempotent', false,
      'reservation_id', v_existing.id,
      'request_id', v_existing.request_id,
      'status', v_existing.status,
      'execution_mode', v_existing.execution_mode,
      'reservation_tokens', v_existing.reserved_tokens,
      'stale_reclaimed_tokens', v_reclaimed_tokens,
      'reason', null
    );
end;
$$;

create or replace function public.commit_unified_text_tokens_v2(
    p_reservation_id uuid,
    p_request_id text,
    p_actual_tokens integer,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'unified-text-tokens-v2';
    v_reservation public.unified_text_reservations_v2%rowtype;
    v_event public.unified_text_usage_events_v2%rowtype;
    v_identity_lock text;
    v_usage_overrun_tokens integer;
    v_fast_reserve_breach_tokens integer;
    v_post_reservation_remaining_tokens integer;
    v_safe_metadata jsonb;
    v_shadow_request_id text;
begin
    if p_reservation_id is null or nullif(trim(coalesce(p_request_id, '')), '') is null then
      return jsonb_build_object('committed', false, 'reason', 'reservation_not_found');
    end if;
    if p_actual_tokens is null or p_actual_tokens <= 0 then
      raise exception 'actual_tokens must be positive';
    end if;

    select * into v_reservation
    from public.unified_text_reservations_v2
    where id = p_reservation_id
      and request_id = p_request_id;

    if v_reservation.id is null then
      return jsonb_build_object('committed', false, 'idempotent', true, 'reason', 'reservation_not_found');
    end if;

    v_identity_lock := case
      when v_reservation.user_id is not null then 'user:' || v_reservation.user_id::text
      else 'guest:' || v_reservation.anonymous_key_hash
    end;
    perform pg_advisory_xact_lock(hashtextextended(
      'sentiq:quota:' || v_policy_version || ':' || v_identity_lock,
      0
    ));

    -- Identity advisory locks are always acquired before row locks. This keeps
    -- commit/release ordering compatible with reserve/summary expiry cleanup.
    select * into v_reservation
    from public.unified_text_reservations_v2
    where id = p_reservation_id
      and request_id = p_request_id
    for update;

    if v_reservation.id is null then
      return jsonb_build_object('committed', false, 'idempotent', true, 'reason', 'reservation_not_found');
    end if;

    if v_reservation.status = 'released' then
      return jsonb_build_object(
        'committed', false,
        'idempotent', true,
        'reason', 'reservation_released',
        'reservation_id', v_reservation.id,
        'request_id', v_reservation.request_id,
        'policy_version', v_policy_version,
        'plan_code', v_reservation.plan_code,
        'execution_mode', v_reservation.execution_mode
      );
    end if;
    if v_reservation.status = 'expired' then
      return jsonb_build_object(
        'committed', false,
        'idempotent', true,
        'reason', 'reservation_expired',
        'reservation_id', v_reservation.id,
        'request_id', v_reservation.request_id,
        'policy_version', v_policy_version,
        'plan_code', v_reservation.plan_code,
        'execution_mode', v_reservation.execution_mode
      );
    end if;
    if v_reservation.status = 'committed' then
      select * into v_event
      from public.unified_text_usage_events_v2
      where reservation_id = v_reservation.id;
      return jsonb_build_object(
        'committed', true,
        'idempotent', true,
        'usage_event_id', v_event.id,
        'reservation_id', v_reservation.id,
        'request_id', v_reservation.request_id,
        'policy_version', v_policy_version,
        'plan_code', v_reservation.plan_code,
        'execution_mode', v_reservation.execution_mode,
        'reserved_tokens', v_reservation.reserved_tokens,
        'actual_tokens', v_event.units,
        'released_tokens', greatest(0, v_reservation.reserved_tokens - v_event.units),
        'usage_overrun_tokens', v_event.usage_overrun_tokens,
        'fast_reserve_breach_tokens', v_event.fast_reserve_breach_tokens
      );
    end if;

    v_usage_overrun_tokens := greatest(0, p_actual_tokens - v_reservation.reserved_tokens);
    v_post_reservation_remaining_tokens := greatest(
      0,
      coalesce(
        (v_reservation.metadata ->> 'post_reservation_remaining_tokens')::integer,
        10000
      )
    );
    v_fast_reserve_breach_tokens := case
      when v_reservation.execution_mode = 'intuitive' then greatest(
        0,
        v_usage_overrun_tokens
          - greatest(0, v_post_reservation_remaining_tokens - 10000)
      )
      else 0
    end;
    v_safe_metadata := jsonb_build_object(
      'quota_policy_version', v_policy_version,
      'input_tokens', greatest(0, coalesce((p_metadata ->> 'input_tokens')::integer, 0)),
      'output_tokens', greatest(0, coalesce((p_metadata ->> 'output_tokens')::integer, 0)),
      'observed_input_tokens', greatest(0, coalesce((p_metadata ->> 'observed_input_tokens')::integer, 0)),
      'observed_output_tokens', greatest(0, coalesce((p_metadata ->> 'observed_output_tokens')::integer, 0)),
      'successful_model_calls', greatest(0, coalesce((p_metadata ->> 'successful_model_calls')::integer, 0)),
      'usage_reported_calls', greatest(0, coalesce((p_metadata ->> 'usage_reported_calls')::integer, 0)),
      'usage_estimated_calls', greatest(0, coalesce((p_metadata ->> 'usage_estimated_calls')::integer, 0)),
      'usage_overrun_tokens', v_usage_overrun_tokens,
      'fast_reserve_breach_tokens', v_fast_reserve_breach_tokens
    );

    insert into public.unified_text_usage_events_v2 (
      reservation_id,
      user_id,
      anonymous_key_hash,
      request_id,
      plan_code,
      policy_version,
      execution_mode,
      units,
      usage_overrun_tokens,
      fast_reserve_breach_tokens,
      metadata,
      created_at
    ) values (
      v_reservation.id,
      v_reservation.user_id,
      v_reservation.anonymous_key_hash,
      v_reservation.request_id,
      v_reservation.plan_code,
      v_reservation.policy_version,
      v_reservation.execution_mode,
      p_actual_tokens,
      v_usage_overrun_tokens,
      v_fast_reserve_breach_tokens,
      v_safe_metadata,
      now()
    )
    on conflict (reservation_id) do update set
      metadata = public.unified_text_usage_events_v2.metadata || excluded.metadata
    returning * into v_event;

    update public.unified_text_reservations_v2
    set status = 'committed',
        actual_tokens = p_actual_tokens,
        metadata = metadata || v_safe_metadata,
        updated_at = now()
    where id = v_reservation.id;

    -- Conservative V2 -> V1 rollback continuity. V2 calculations explicitly
    -- exclude these Standard-compatible shadow rows.
    v_shadow_request_id := 'unified-text-v2-rollback:' || v_reservation.id::text;
    insert into public.usage_events (
      user_id,
      anonymous_key_hash,
      plan_code,
      feature,
      units,
      safe_model_label,
      route,
      client_request_id,
      request_id,
      metadata,
      created_at
    ) values (
      v_reservation.user_id,
      v_reservation.anonymous_key_hash,
      'free',
      'premium_text',
      p_actual_tokens,
      'Text',
      'unified_text_rollback',
      v_reservation.request_id,
      v_shadow_request_id,
      jsonb_build_object(
        'quota_policy_version', 'standard-lite-tokens-v1',
        'unified_text_v2_rollback_shadow', true,
        'source_policy_version', v_policy_version,
        'source_request_id', v_reservation.request_id,
        'source_reservation_id', v_reservation.id,
        'usage_overrun_tokens', v_usage_overrun_tokens
      ),
      now()
    )
    on conflict (request_id) where request_id is not null do nothing;

    return jsonb_build_object(
      'committed', true,
      'idempotent', false,
      'usage_event_id', v_event.id,
      'reservation_id', v_reservation.id,
      'request_id', v_reservation.request_id,
      'policy_version', v_policy_version,
      'plan_code', v_reservation.plan_code,
      'execution_mode', v_reservation.execution_mode,
      'reserved_tokens', v_reservation.reserved_tokens,
      'actual_tokens', p_actual_tokens,
      'released_tokens', greatest(0, v_reservation.reserved_tokens - p_actual_tokens),
      'usage_overrun_tokens', v_usage_overrun_tokens,
      'fast_reserve_breach_tokens', v_fast_reserve_breach_tokens
    );
end;
$$;

create or replace function public.release_unified_text_tokens_v2(
    p_reservation_id uuid,
    p_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'unified-text-tokens-v2';
    v_reservation public.unified_text_reservations_v2%rowtype;
    v_identity_lock text;
begin
    if p_reservation_id is null or nullif(trim(coalesce(p_request_id, '')), '') is null then
      return jsonb_build_object(
        'released', false,
        'idempotent', true,
        'reason', 'reservation_not_found'
      );
    end if;

    select * into v_reservation
    from public.unified_text_reservations_v2
    where id = p_reservation_id
      and request_id = p_request_id;

    if v_reservation.id is null then
      return jsonb_build_object(
        'released', false,
        'idempotent', true,
        'reason', 'reservation_not_found'
      );
    end if;

    v_identity_lock := case
      when v_reservation.user_id is not null then 'user:' || v_reservation.user_id::text
      else 'guest:' || v_reservation.anonymous_key_hash
    end;
    perform pg_advisory_xact_lock(hashtextextended(
      'sentiq:quota:' || v_policy_version || ':' || v_identity_lock,
      0
    ));

    -- Match reserve/summary lock ordering to avoid holding a row lock while
    -- waiting for the identity-scoped advisory lock.
    select * into v_reservation
    from public.unified_text_reservations_v2
    where id = p_reservation_id
      and request_id = p_request_id
    for update;

    if v_reservation.id is null then
      return jsonb_build_object(
        'released', false,
        'idempotent', true,
        'reason', 'reservation_not_found'
      );
    end if;

    if v_reservation.status = 'committed' then
      return jsonb_build_object(
        'released', false,
        'idempotent', true,
        'reason', 'reservation_committed',
        'reservation_id', v_reservation.id,
        'request_id', v_reservation.request_id,
        'policy_version', v_policy_version,
        'plan_code', v_reservation.plan_code,
        'execution_mode', v_reservation.execution_mode
      );
    end if;
    if v_reservation.status in ('released', 'expired') then
      return jsonb_build_object(
        'released', v_reservation.status = 'released',
        'idempotent', true,
        'reason', case
          when v_reservation.status = 'expired' then 'reservation_expired'
          else null
        end,
        'reservation_id', v_reservation.id,
        'request_id', v_reservation.request_id,
        'policy_version', v_policy_version,
        'plan_code', v_reservation.plan_code,
        'execution_mode', v_reservation.execution_mode,
        'released_tokens', case
          when v_reservation.status = 'released' then v_reservation.reserved_tokens
          else 0
        end
      );
    end if;

    update public.unified_text_reservations_v2
    set status = case
          when reservation_expires_at <= now() then 'expired'
          else 'released'
        end,
        updated_at = now()
    where id = v_reservation.id
    returning * into v_reservation;

    return jsonb_build_object(
      'released', v_reservation.status = 'released',
      'idempotent', false,
      'reason', case when v_reservation.status = 'expired' then 'reservation_expired' else null end,
      'reservation_id', v_reservation.id,
      'request_id', v_reservation.request_id,
      'policy_version', v_policy_version,
      'plan_code', v_reservation.plan_code,
      'execution_mode', v_reservation.execution_mode,
      'released_tokens', v_reservation.reserved_tokens
    );
end;
$$;

create or replace function public.get_unified_text_usage_summary_v2(
    p_user_id uuid,
    p_anonymous_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'unified-text-tokens-v2';
    v_effective record;
    v_plan_code text;
    v_identity_lock text;
    v_snapshot jsonb;
    v_reclaimed_tokens bigint := 0;
    v_v1_standard_window_seconds integer := 28800;
    v_rollback_shadow_v1_standard_tokens bigint := 0;
begin
    if (p_user_id is not null) = (nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is not null) then
      raise exception 'exactly one billing identity is required';
    end if;

    select * into v_effective from public.get_effective_plan(p_user_id) limit 1;
    v_plan_code := coalesce(v_effective.plan_code, 'free');
    if v_plan_code <> 'free' then
      return jsonb_build_object(
        'eligible', false,
        'plan_code', v_plan_code,
        'policy_version', v_policy_version
      );
    end if;

    v_identity_lock := case
      when p_user_id is not null then 'user:' || p_user_id::text
      else 'guest:' || p_anonymous_key_hash
    end;
    perform pg_advisory_xact_lock(hashtextextended(
      'sentiq:quota:' || v_policy_version || ':' || v_identity_lock,
      0
    ));

    with reclaimed as (
      update public.unified_text_reservations_v2
      set status = 'expired',
          updated_at = now()
      where policy_version = v_policy_version
        and plan_code = 'free'
        and status = 'reserved'
        and reservation_expires_at <= now()
        and (
          (p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
        )
      returning reserved_tokens
    )
    select coalesce(sum(reserved_tokens), 0) into v_reclaimed_tokens from reclaimed;

    v_snapshot := public.unified_text_tokens_v2_snapshot(p_user_id, p_anonymous_key_hash);
    select greatest(
      1,
      coalesce(
        (entitlements -> 'quotas' -> 'premium_text' ->> 'window_seconds')::integer,
        28800
      )
    )
    into v_v1_standard_window_seconds
    from public.billing_plans
    where code = 'free';

    select coalesce(sum(units), 0)
    into v_rollback_shadow_v1_standard_tokens
    from public.usage_events
    where plan_code = 'free'
      and feature = 'premium_text'
      and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
      and metadata ->> 'unified_text_v2_rollback_shadow' = 'true'
      and created_at >= now() - make_interval(secs => v_v1_standard_window_seconds)
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      );

    return v_snapshot || jsonb_build_object(
      'eligible', true,
      'stale_reclaimed_tokens', v_reclaimed_tokens,
      'rollback_shadow_v1_standard_tokens', v_rollback_shadow_v1_standard_tokens
    );
end;
$$;

create or replace function public.get_unified_text_tokens_v2_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260727120000'::text;
$$;

alter table public.unified_text_reservations_v2 enable row level security;
alter table public.unified_text_usage_events_v2 enable row level security;

revoke all on table public.unified_text_reservations_v2 from public, anon, authenticated;
revoke all on table public.unified_text_usage_events_v2 from public, anon, authenticated;
revoke all on function public.unified_text_tokens_v2_snapshot(uuid, text) from public, anon, authenticated;
revoke all on function public.reserve_unified_text_tokens_v2(uuid, text, text, text, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.commit_unified_text_tokens_v2(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.release_unified_text_tokens_v2(uuid, text) from public, anon, authenticated;
revoke all on function public.get_unified_text_usage_summary_v2(uuid, text) from public, anon, authenticated;
revoke all on function public.get_unified_text_tokens_v2_schema_version() from public, anon, authenticated;

grant execute on function public.reserve_unified_text_tokens_v2(uuid, text, text, text, integer, integer, jsonb) to service_role;
grant execute on function public.commit_unified_text_tokens_v2(uuid, text, integer, jsonb) to service_role;
grant execute on function public.release_unified_text_tokens_v2(uuid, text) to service_role;
grant execute on function public.get_unified_text_usage_summary_v2(uuid, text) to service_role;
grant execute on function public.get_unified_text_tokens_v2_schema_version() to service_role;
