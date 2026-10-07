-- SentIQ Chat weighted image credits and revised billing plan tiers.
--
-- RUN ON: Auth/control database only (Database 1 / SUPABASE_URL_1).
-- DO NOT RUN ON: Data shards 2, 3, or 4. Those shards do not own
-- public.billing_plans or the public.reserve_usage billing ledger.
--
-- This migration is idempotent and preserves every non-image entitlement
-- and provider_plan_ids.

begin;

do $$
begin
    if to_regclass('public.billing_plans') is null then
        raise exception
            'weighted image credits policy requires public.billing_plans on the auth/control database';
    end if;
end
$$;

with desired(code, price_paise, quota_limit, window_seconds, quota_label, quota_unit) as (
    values
        ('free'::text, 0::integer, 2::integer, 86400::integer, 'Image credits'::text, 'credits'::text),
        ('student_core'::text, 12900::integer, 12::integer, 43200::integer, 'Image credits'::text, 'credits'::text),
        ('premium'::text, 29900::integer, 20::integer, 43200::integer, 'Image credits'::text, 'credits'::text),
        ('pro'::text, 69900::integer, 32::integer, 43200::integer, 'Image credits'::text, 'credits'::text)
), prepared as (
    select
        bp.code,
        desired.price_paise,
        desired.quota_limit,
        desired.window_seconds,
        desired.quota_label,
        desired.quota_unit,
        jsonb_set(
            coalesce(bp.entitlements, '{}'::jsonb),
            '{quotas}',
            coalesce(bp.entitlements -> 'quotas', '{}'::jsonb),
            true
        ) as entitlements_with_quotas
    from public.billing_plans bp
    join desired on desired.code = bp.code
)
update public.billing_plans bp
set
    price_paise = prepared.price_paise,
    entitlements = jsonb_set(
        prepared.entitlements_with_quotas,
        '{quotas,image_generation}',
        jsonb_build_object(
            'limit', prepared.quota_limit,
            'window_seconds', prepared.window_seconds,
            'label', prepared.quota_label,
            'unit', prepared.quota_unit
        ),
        true
    ),
    updated_at = now()
from prepared
where bp.code = prepared.code;

-- Update commit_usage_reservation to settle actual image credits and release unused credits
create or replace function public.commit_usage_reservation(
    p_request_id text,
    p_provider text,
    p_model text,
    p_route text,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    reservation public.quota_reservations%rowtype;
    event_row public.usage_events%rowtype;
    merged_metadata jsonb;
    settled_units integer;
    requested_actual_units integer;
    quota jsonb;
    quota_limit integer;
    window_seconds integer;
    used_units integer;
    other_reserved_units integer;
    lock_identity text;
begin
    select * into reservation from public.quota_reservations
      where request_id = p_request_id for update;
    if reservation.id is null then
      return jsonb_build_object('committed', false, 'reason', 'reservation_not_found');
    end if;
    if reservation.status = 'released' then
      return jsonb_build_object('committed', false, 'reason', 'reservation_released');
    end if;
    if reservation.status = 'committed' then
      select * into event_row from public.usage_events where request_id = p_request_id limit 1;
      return jsonb_build_object('committed', true, 'idempotent', true,
        'usage_event_id', event_row.id, 'settled_units', event_row.units,
        'released_units', greatest(0, reservation.units - event_row.units));
    end if;

    merged_metadata := coalesce(reservation.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb);
    settled_units := reservation.units;
    if reservation.feature = 'image_generation' and (merged_metadata ? 'actual_image_credits') then
      settled_units := greatest(1, least(
        coalesce((merged_metadata ->> 'actual_image_credits')::integer, reservation.units),
        reservation.units
      ));
    elsif reservation.feature in ('premium_text', 'lite_text')
       and merged_metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1' then
      requested_actual_units := greatest(1, coalesce(
        (merged_metadata ->> 'actual_token_units')::integer,
        reservation.units
      ));
      lock_identity := coalesce(reservation.user_id::text, 'anon:' || reservation.anonymous_key_hash)
        || ':' || reservation.feature;
      perform pg_advisory_xact_lock(hashtextextended('sentiq:quota:' || lock_identity, 0));
      select entitlements -> 'quotas' -> reservation.feature into quota
      from public.billing_plans where code = reservation.plan_code;
      quota_limit := greatest(0, coalesce((quota ->> 'limit')::integer, reservation.units));
      window_seconds := greatest(1, coalesce((quota ->> 'window_seconds')::integer, 86400));
      select coalesce(sum(units), 0) into used_units
      from public.usage_events
      where feature = reservation.feature
        and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
        and created_at >= now() - make_interval(secs => window_seconds)
        and ((reservation.user_id is not null and user_id = reservation.user_id)
          or (reservation.user_id is null and anonymous_key_hash = reservation.anonymous_key_hash));
      select coalesce(sum(units), 0) into other_reserved_units
      from public.quota_reservations
      where feature = reservation.feature and id <> reservation.id
        and status = 'reserved' and reservation_expires_at > now()
        and created_at >= now() - make_interval(secs => window_seconds)
        and metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'
        and ((reservation.user_id is not null and user_id = reservation.user_id)
          or (reservation.user_id is null and anonymous_key_hash = reservation.anonymous_key_hash));
      settled_units := greatest(1, least(
        requested_actual_units,
        greatest(0, quota_limit - used_units - other_reserved_units)
      ));
      if settled_units < requested_actual_units then
        merged_metadata := merged_metadata || jsonb_build_object(
          'unsettled_overage_tokens', requested_actual_units - settled_units
        );
      end if;
    end if;

    insert into public.usage_events (
      user_id, anonymous_key_hash, plan_code, feature, units, provider, model,
      safe_model_label, route, conversation_id, client_request_id, request_id, metadata
    ) values (
      reservation.user_id, reservation.anonymous_key_hash, reservation.plan_code,
      reservation.feature, settled_units, p_provider, p_model,
      coalesce(merged_metadata ->> 'safe_model_label', null), p_route,
      coalesce(merged_metadata ->> 'conversation_id', null),
      coalesce(merged_metadata ->> 'client_request_id', null),
      reservation.request_id, merged_metadata
    ) on conflict (request_id) where request_id is not null do update set
      metadata = public.usage_events.metadata || excluded.metadata
    returning * into event_row;

    update public.quota_reservations set status = 'committed', units = settled_units,
      metadata = merged_metadata, updated_at = now() where id = reservation.id;
    return jsonb_build_object('committed', true, 'idempotent', false,
      'usage_event_id', event_row.id, 'settled_units', settled_units,
      'released_units', greatest(0, reservation.units - settled_units));
end;
$$;

revoke all on function public.commit_usage_reservation(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_usage_reservation(text, text, text, text, jsonb) to service_role;

-- Update get_usage_summary to include quota unit
create or replace function public.get_usage_summary(
    p_user_id uuid,
    p_anonymous_key_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    effective record;
    plan_row public.billing_plans%rowtype;
    feature_key text;
    quota jsonb;
    quota_limit integer;
    window_seconds integer;
    used_units integer;
    live_reserved_units integer;
    earliest_at timestamptz;
    reset_at timestamptz;
    is_token_feature boolean;
    migration jsonb := '{}'::jsonb;
    summary jsonb := '{}'::jsonb;
begin
    select * into effective from public.get_effective_plan(p_user_id) limit 1;
    select * into plan_row from public.billing_plans where code = coalesce(effective.plan_code, 'free');
    if plan_row.id is null then select * into plan_row from public.billing_plans where code = 'free'; end if;

    for feature_key, quota in select key, value from jsonb_each(plan_row.entitlements -> 'quotas')
    loop
      quota_limit := greatest(0, coalesce((quota ->> 'limit')::integer, 0));
      window_seconds := greatest(1, coalesce((quota ->> 'window_seconds')::integer, 86400));
      is_token_feature := feature_key in ('premium_text', 'lite_text');
      migration := '{}'::jsonb;
      if is_token_feature then
        migration := public.ensure_text_token_policy_migration(
          p_user_id, p_anonymous_key_hash, feature_key, plan_row.code,
          quota_limit, window_seconds
        );
      end if;

      select coalesce(sum(units), 0), min(created_at) into used_units, earliest_at
      from public.usage_events
      where feature = feature_key
        and created_at >= now() - make_interval(secs => window_seconds)
        and (not is_token_feature or metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1')
        and ((p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash));

      select coalesce(sum(units), 0),
        case when earliest_at is null then min(created_at)
          when min(created_at) is null then earliest_at else least(earliest_at, min(created_at)) end
      into live_reserved_units, earliest_at
      from public.quota_reservations
      where feature = feature_key and status = 'reserved'
        and reservation_expires_at > now()
        and created_at >= now() - make_interval(secs => window_seconds)
        and (not is_token_feature or metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1')
        and ((p_user_id is not null and user_id = p_user_id)
          or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash));

      reset_at := case when earliest_at is null then null
        else earliest_at + make_interval(secs => window_seconds) end;
      summary := summary || jsonb_build_object(feature_key, jsonb_build_object(
        'label', quota ->> 'label',
        'unit', quota ->> 'unit',
        'used', used_units, 'reserved', live_reserved_units,
        'limit', quota_limit, 'remaining', greatest(0, quota_limit - used_units - live_reserved_units),
        'window_seconds', window_seconds, 'window_start', earliest_at, 'reset_at', reset_at,
        'available', quota_limit > 0,
        'allowance_class', case when feature_key = 'premium_text' then 'standard'
          when feature_key = 'lite_text' then 'lite' else feature_key end,
        'token_limit', case when is_token_feature then quota_limit else null end,
        'tokens_consumed', case when is_token_feature then used_units else null end,
        'tokens_remaining', case when is_token_feature then greatest(0, quota_limit - used_units - live_reserved_units) else null end,
        'policy_version', case when is_token_feature then 'standard-lite-tokens-v1' else null end,
        'window_identity', case when is_token_feature then migration ->> 'window_identity' else null end
      ));
    end loop;

    return jsonb_build_object(
      'plan_code', plan_row.code, 'plan_name', plan_row.name,
      'status', coalesce(effective.status, 'free'),
      'subscription_id', effective.subscription_id,
      'current_period_end', effective.current_period_end,
      'quota_policy_version', 'standard-lite-tokens-v1',
      'quotas', summary
    );
end;
$$;

revoke all on function public.get_usage_summary(uuid, text) from public, anon, authenticated;
grant execute on function public.get_usage_summary(uuid, text) to service_role;

-- Verification of updated pricing and quotas
do $$
declare
    matching_plan_count integer;
begin
    select count(*)
    into matching_plan_count
    from public.billing_plans bp
    where
        (bp.code = 'free'
            and bp.price_paise = 0
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 2
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 86400
            and bp.entitlements #>> '{quotas,image_generation,label}' = 'Image credits'
            and bp.entitlements #>> '{quotas,image_generation,unit}' = 'credits')
        or
        (bp.code = 'student_core'
            and bp.price_paise = 12900
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 12
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200
            and bp.entitlements #>> '{quotas,image_generation,label}' = 'Image credits'
            and bp.entitlements #>> '{quotas,image_generation,unit}' = 'credits')
        or
        (bp.code = 'premium'
            and bp.price_paise = 29900
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 20
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200
            and bp.entitlements #>> '{quotas,image_generation,label}' = 'Image credits'
            and bp.entitlements #>> '{quotas,image_generation,unit}' = 'credits')
        or
        (bp.code = 'pro'
            and bp.price_paise = 69900
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 32
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200
            and bp.entitlements #>> '{quotas,image_generation,label}' = 'Image credits'
            and bp.entitlements #>> '{quotas,image_generation,unit}' = 'credits');

    if matching_plan_count <> 4 then
        raise exception
            'weighted image credits policy verification failed: expected 4 matching billing plans, found %',
            matching_plan_count;
    end if;
end
$$;

commit;
