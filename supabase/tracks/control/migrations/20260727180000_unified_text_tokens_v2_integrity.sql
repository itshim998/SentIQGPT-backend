-- Unified text-token V2 integrity follow-up.
--
-- RUN ON: Control database (Database 1).
-- This additive migration closes two rollout-safety gaps:
--   1. V2 -> V1 rollback now blocks both the Standard and Lite allowance paths.
--   2. Reliable provider usage may settle idempotently after a reservation TTL elapsed.
--
-- The original V2 ledgers and V1 policy remain intact.

create or replace function public.sync_unified_text_v2_rollback_shadows(
    p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_reservation public.unified_text_reservations_v2%rowtype;
    v_event public.unified_text_usage_events_v2%rowtype;
    v_standard_limit integer := 25000;
    v_identity_material text;
    v_identity_fingerprint text;
    v_standard_gate_request_id text;
    v_lite_request_id text;
    v_latest_v2_event_at timestamptz;
begin
    select * into v_reservation
    from public.unified_text_reservations_v2
    where id = p_reservation_id;

    if v_reservation.id is null or v_reservation.status <> 'committed' then
      return jsonb_build_object('synced', false, 'reason', 'reservation_not_committed');
    end if;

    select * into v_event
    from public.unified_text_usage_events_v2
    where reservation_id = v_reservation.id;

    if v_event.id is null then
      return jsonb_build_object('synced', false, 'reason', 'usage_event_not_found');
    end if;

    select greatest(
      1,
      coalesce(
        (entitlements -> 'quotas' -> 'premium_text' ->> 'limit')::integer,
        25000
      )
    )
    into v_standard_limit
    from public.billing_plans
    where code = 'free';

    v_standard_limit := greatest(1, coalesce(v_standard_limit, 25000));
    v_identity_material := case
      when v_reservation.user_id is not null then 'user:' || v_reservation.user_id::text
      else 'guest:' || v_reservation.anonymous_key_hash
    end;
    v_identity_fingerprint := encode(digest(v_identity_material, 'sha256'), 'hex');
    v_standard_gate_request_id := 'unified-text-v2-rollback-standard-gate:' || v_identity_fingerprint;
    v_lite_request_id := 'unified-text-v2-rollback-lite:' || v_reservation.id::text;

    select max(created_at)
    into v_latest_v2_event_at
    from public.unified_text_usage_events_v2
    where policy_version = 'unified-text-tokens-v2'
      and plan_code = 'free'
      and (
        (v_reservation.user_id is not null and user_id = v_reservation.user_id)
        or (
          v_reservation.user_id is null
          and user_id is null
          and anonymous_key_hash = v_reservation.anonymous_key_hash
        )
      );

    v_latest_v2_event_at := coalesce(v_latest_v2_event_at, v_event.created_at, now());

    -- Remove the original Passes 4-5 single Standard shadow if this reservation
    -- was already committed before this integrity migration was installed.
    delete from public.usage_events
    where request_id = 'unified-text-v2-rollback:' || v_reservation.id::text
      and metadata ->> 'unified_text_v2_rollback_shadow' = 'true';

    -- One identity-scoped Standard gate is refreshed to the latest V2 commit.
    -- This prevents the normal V1 Standard -> Lite route from granting the
    -- extra 25K Standard allowance after rollback.
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
      v_standard_limit,
      'Text',
      'unified_text_rollback_standard_gate',
      v_reservation.request_id,
      v_standard_gate_request_id,
      jsonb_build_object(
        'quota_policy_version', 'standard-lite-tokens-v1',
        'unified_text_v2_rollback_shadow', true,
        'unified_text_v2_rollback_shadow_class', 'standard_gate',
        'source_policy_version', 'unified-text-tokens-v2',
        'latest_source_request_id', v_reservation.request_id,
        'latest_source_reservation_id', v_reservation.id
      ),
      v_latest_v2_event_at
    )
    on conflict (request_id) where request_id is not null do update set
      units = excluded.units,
      client_request_id = excluded.client_request_id,
      metadata = public.usage_events.metadata || excluded.metadata,
      created_at = excluded.created_at;

    -- Actual V2 usage is mirrored into Lite. With Standard gated, Lite's
    -- remaining capacity is exactly the conservative V1 rollback capacity.
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
      'lite_text',
      v_event.units,
      'Text',
      'unified_text_rollback_lite_usage',
      v_reservation.request_id,
      v_lite_request_id,
      jsonb_build_object(
        'quota_policy_version', 'standard-lite-tokens-v1',
        'unified_text_v2_rollback_shadow', true,
        'unified_text_v2_rollback_shadow_class', 'lite_usage',
        'source_policy_version', 'unified-text-tokens-v2',
        'source_request_id', v_reservation.request_id,
        'source_reservation_id', v_reservation.id,
        'usage_overrun_tokens', v_event.usage_overrun_tokens,
        'fast_reserve_breach_tokens', v_event.fast_reserve_breach_tokens
      ),
      v_event.created_at
    )
    on conflict (request_id) where request_id is not null do update set
      units = excluded.units,
      metadata = public.usage_events.metadata || excluded.metadata,
      created_at = excluded.created_at;

    return jsonb_build_object(
      'synced', true,
      'standard_gate_tokens', v_standard_limit,
      'lite_usage_tokens', v_event.units,
      'standard_gate_request_id', v_standard_gate_request_id,
      'lite_request_id', v_lite_request_id
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
    v_fast_reserve_tokens constant integer := 10000;
    v_reservation public.unified_text_reservations_v2%rowtype;
    v_event public.unified_text_usage_events_v2%rowtype;
    v_identity_lock text;
    v_usage_overrun_tokens integer;
    v_fast_reserve_breach_tokens integer;
    v_post_reservation_remaining_tokens integer;
    v_safe_metadata jsonb;
    v_snapshot jsonb;
    v_current_remaining_tokens integer := 0;
    v_late_settlement boolean := false;
    v_late_capacity_overrun_tokens integer := 0;
    v_shadow_result jsonb;
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

    if v_reservation.status = 'committed' then
      select * into v_event
      from public.unified_text_usage_events_v2
      where reservation_id = v_reservation.id;
      v_shadow_result := public.sync_unified_text_v2_rollback_shadows(v_reservation.id);
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
        'fast_reserve_breach_tokens', v_event.fast_reserve_breach_tokens,
        'late_settlement', coalesce((v_event.metadata ->> 'late_settlement')::boolean, false),
        'late_capacity_overrun_tokens', greatest(
          0,
          coalesce((v_event.metadata ->> 'late_capacity_overrun_tokens')::integer, 0)
        ),
        'rollback_shadows_synced', coalesce((v_shadow_result ->> 'synced')::boolean, false)
      );
    end if;

    v_late_settlement := v_reservation.status = 'expired'
      or v_reservation.reservation_expires_at <= now();
    v_snapshot := public.unified_text_tokens_v2_snapshot(
      v_reservation.user_id,
      v_reservation.anonymous_key_hash
    );
    v_current_remaining_tokens := greatest(
      0,
      coalesce((v_snapshot ->> 'remaining_tokens')::integer, 0)
    );

    v_late_capacity_overrun_tokens := case
      when v_late_settlement then greatest(0, p_actual_tokens - v_current_remaining_tokens)
      else 0
    end;
    v_usage_overrun_tokens := greatest(
      0,
      p_actual_tokens - v_reservation.reserved_tokens,
      v_late_capacity_overrun_tokens
    );

    v_post_reservation_remaining_tokens := greatest(
      0,
      coalesce(
        (v_reservation.metadata ->> 'post_reservation_remaining_tokens')::integer,
        v_fast_reserve_tokens
      )
    );
    v_fast_reserve_breach_tokens := case
      when v_reservation.execution_mode <> 'intuitive' then 0
      when v_late_settlement then greatest(
        0,
        p_actual_tokens - greatest(0, v_current_remaining_tokens - v_fast_reserve_tokens)
      )
      else greatest(
        0,
        greatest(0, p_actual_tokens - v_reservation.reserved_tokens)
          - greatest(0, v_post_reservation_remaining_tokens - v_fast_reserve_tokens)
      )
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
      'fast_reserve_breach_tokens', v_fast_reserve_breach_tokens,
      'late_settlement', v_late_settlement,
      'pre_settlement_remaining_tokens', v_current_remaining_tokens,
      'late_capacity_overrun_tokens', v_late_capacity_overrun_tokens
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

    v_shadow_result := public.sync_unified_text_v2_rollback_shadows(v_reservation.id);

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
      'fast_reserve_breach_tokens', v_fast_reserve_breach_tokens,
      'late_settlement', v_late_settlement,
      'late_capacity_overrun_tokens', v_late_capacity_overrun_tokens,
      'rollback_shadows_synced', coalesce((v_shadow_result ->> 'synced')::boolean, false)
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
    v_v1_lite_window_seconds integer := 86400;
    v_rollback_shadow_v1_standard_tokens bigint := 0;
    v_rollback_shadow_v1_lite_tokens bigint := 0;
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
    select
      greatest(
        1,
        coalesce(
          (entitlements -> 'quotas' -> 'premium_text' ->> 'window_seconds')::integer,
          28800
        )
      ),
      greatest(
        1,
        coalesce(
          (entitlements -> 'quotas' -> 'lite_text' ->> 'window_seconds')::integer,
          86400
        )
      )
    into v_v1_standard_window_seconds, v_v1_lite_window_seconds
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

    select coalesce(sum(units), 0)
    into v_rollback_shadow_v1_lite_tokens
    from public.usage_events
    where plan_code = 'free'
      and feature = 'lite_text'
      and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
      and metadata ->> 'unified_text_v2_rollback_shadow' = 'true'
      and created_at >= now() - make_interval(secs => v_v1_lite_window_seconds)
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      );

    return v_snapshot || jsonb_build_object(
      'eligible', true,
      'stale_reclaimed_tokens', v_reclaimed_tokens,
      'rollback_shadow_v1_standard_tokens', v_rollback_shadow_v1_standard_tokens,
      'rollback_shadow_v1_lite_tokens', v_rollback_shadow_v1_lite_tokens,
      'rollback_shadow_v1_total_tokens',
        v_rollback_shadow_v1_standard_tokens + v_rollback_shadow_v1_lite_tokens
    );
end;
$$;

create or replace function public.get_unified_text_tokens_v2_schema_version()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select '20260727180000'::text;
$$;

-- Backfill/repair rollback shadows for any commits made before this migration.
do $$
declare
    v_row record;
begin
    for v_row in
      select id
      from public.unified_text_reservations_v2
      where policy_version = 'unified-text-tokens-v2'
        and plan_code = 'free'
        and status = 'committed'
    loop
      perform public.sync_unified_text_v2_rollback_shadows(v_row.id);
    end loop;
end;
$$;

revoke all on function public.sync_unified_text_v2_rollback_shadows(uuid) from public, anon, authenticated;
revoke all on function public.commit_unified_text_tokens_v2(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.get_unified_text_usage_summary_v2(uuid, text) from public, anon, authenticated;
revoke all on function public.get_unified_text_tokens_v2_schema_version() from public, anon, authenticated;

grant execute on function public.commit_unified_text_tokens_v2(uuid, text, integer, jsonb) to service_role;
grant execute on function public.get_unified_text_usage_summary_v2(uuid, text) to service_role;
grant execute on function public.get_unified_text_tokens_v2_schema_version() to service_role;
