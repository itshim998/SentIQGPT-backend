-- Standard/Lite token allowance migration.
-- Keeps legacy message events for rollback while moving only premium_text and
-- lite_text enforcement to the versioned token ledger.

create table if not exists public.text_token_policy_migrations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    anonymous_key_hash text,
    feature text not null check (feature in ('premium_text', 'lite_text')),
    policy_version text not null,
    plan_code text not null,
    legacy_message_limit integer not null,
    token_limit integer not null,
    legacy_used_messages integer not null default 0,
    converted_used_tokens integer not null default 0,
    window_start timestamptz,
    reset_at timestamptz,
    created_at timestamptz not null default now(),
    check ((user_id is not null) <> (anonymous_key_hash is not null))
);

create unique index if not exists text_token_policy_migrations_user_unique
on public.text_token_policy_migrations(user_id, feature, policy_version)
where user_id is not null;

create unique index if not exists text_token_policy_migrations_anon_unique
on public.text_token_policy_migrations(anonymous_key_hash, feature, policy_version)
where anonymous_key_hash is not null;

alter table public.text_token_policy_migrations enable row level security;

-- Old live message reservations are not meaningful token reservations. Release
-- them once; committed message events remain untouched for rollback/audit.
update public.quota_reservations
set status = 'released',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'released_for_policy_migration', 'standard-lite-tokens-v1'
    ),
    updated_at = now()
where feature in ('premium_text', 'lite_text')
  and status = 'reserved'
  and coalesce(metadata ->> 'quota_policy_version', '') <> 'standard-lite-tokens-v1';

-- Persisted billing plans are a deployment cache of backend/billing/planCatalog.ts.
-- Change only names/descriptions and the two text quota entries.
update public.billing_plans
set name = case code
      when 'student_core' then 'Essential'
      when 'premium' then 'Plus'
      else name
    end,
    description = case code
      when 'free' then 'A straightforward way to get started, with clear rolling limits.'
      when 'student_core' then 'Balanced access for regular, everyday use.'
      when 'premium' then 'Expanded limits for frequent and more involved workflows.'
      when 'pro' then 'Our highest limits for sustained, demanding use.'
      else description
    end,
    entitlements = jsonb_set(
      jsonb_set(
        entitlements,
        '{quotas,premium_text}',
        jsonb_build_object(
          'limit', case code
            when 'free' then 25000
            when 'student_core' then 100000
            when 'premium' then 180000
            when 'pro' then 300000
          end,
          'window_seconds', coalesce((entitlements #>> '{quotas,premium_text,window_seconds}')::integer, 28800),
          'label', 'Standard tokens',
          'policy_version', 'standard-lite-tokens-v1',
          'unit', 'tokens'
        ),
        true
      ),
      '{quotas,lite_text}',
      jsonb_build_object(
        'limit', case code
          when 'free' then 50000
          when 'student_core' then 175000
          when 'premium' then 325000
          when 'pro' then 550000
        end,
        'window_seconds', coalesce((entitlements #>> '{quotas,lite_text,window_seconds}')::integer, 86400),
        'label', 'Lite tokens',
        'policy_version', 'standard-lite-tokens-v1',
        'unit', 'tokens'
      ),
      true
    ),
    updated_at = now()
where code in ('free', 'student_core', 'premium', 'pro');

create or replace function public.ensure_text_token_policy_migration(
    p_user_id uuid,
    p_anonymous_key_hash text,
    p_feature text,
    p_plan_code text,
    p_token_limit integer,
    p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_policy_version constant text := 'standard-lite-tokens-v1';
    existing public.text_token_policy_migrations%rowtype;
    legacy_limit integer;
    legacy_used integer := 0;
    converted_used integer := 0;
    earliest_legacy_at timestamptz;
    migration_request_id text;
    identity_text text;
begin
    if p_feature not in ('premium_text', 'lite_text') then
        return jsonb_build_object('migrated', false, 'reason', 'not_token_feature');
    end if;
    if p_user_id is null and nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is null then
        return jsonb_build_object('migrated', false, 'reason', 'identity_unavailable');
    end if;

    identity_text := coalesce(p_user_id::text, 'anon:' || p_anonymous_key_hash);
    perform pg_advisory_xact_lock(hashtextextended('sentiq:token-migration:' || identity_text || ':' || p_feature, 0));

    select * into existing
    from public.text_token_policy_migrations
    where feature = p_feature
      and policy_version = v_policy_version
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      )
    limit 1;

    if existing.id is not null then
        return jsonb_build_object(
          'migrated', true,
          'idempotent', true,
          'window_identity', existing.id,
          'converted_used_tokens', existing.converted_used_tokens,
          'window_start', existing.window_start,
          'reset_at', existing.reset_at
        );
    end if;

    legacy_limit := case p_plan_code
      when 'free' then case when p_feature = 'premium_text' then 10 else 40 end
      when 'student_core' then case when p_feature = 'premium_text' then 50 else 160 end
      when 'premium' then case when p_feature = 'premium_text' then 75 else 260 end
      when 'pro' then case when p_feature = 'premium_text' then 100 else 400 end
      else 0
    end;

    select coalesce(sum(greatest(0, units)), 0), min(created_at)
    into legacy_used, earliest_legacy_at
    from public.usage_events
    where feature = p_feature
      and created_at >= now() - make_interval(secs => greatest(1, p_window_seconds))
      and coalesce(metadata ->> 'quota_policy_version', '') <> v_policy_version
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      );

    if legacy_limit > 0 then
      legacy_used := least(legacy_limit, greatest(0, legacy_used));
      converted_used := least(
        greatest(0, p_token_limit),
        ceil(greatest(0, p_token_limit)::numeric * legacy_used::numeric / legacy_limit::numeric)::integer
      );
    end if;

    insert into public.text_token_policy_migrations (
      user_id, anonymous_key_hash, feature, policy_version, plan_code,
      legacy_message_limit, token_limit, legacy_used_messages,
      converted_used_tokens, window_start, reset_at
    ) values (
      p_user_id, case when p_user_id is null then p_anonymous_key_hash else null end,
      p_feature, v_policy_version, p_plan_code, legacy_limit, p_token_limit,
      legacy_used, converted_used, earliest_legacy_at,
      case when earliest_legacy_at is null then null
        else earliest_legacy_at + make_interval(secs => greatest(1, p_window_seconds)) end
    ) returning * into existing;

    if converted_used > 0 and earliest_legacy_at is not null then
      migration_request_id := 'token-policy-migration:' || md5(identity_text || ':' || p_feature || ':' || v_policy_version);
      insert into public.usage_events (
        user_id, anonymous_key_hash, plan_code, feature, units, request_id,
        metadata, created_at
      ) values (
        p_user_id, case when p_user_id is null then p_anonymous_key_hash else null end,
        p_plan_code, p_feature, converted_used, migration_request_id,
        jsonb_build_object(
          'quota_policy_version', v_policy_version,
          'usage_source', 'legacy_message_ratio',
          'legacy_used_messages', legacy_used,
          'legacy_message_limit', legacy_limit,
          'migration_id', existing.id
        ),
        earliest_legacy_at
      ) on conflict (request_id) where request_id is not null do nothing;
    end if;

    return jsonb_build_object(
      'migrated', true,
      'idempotent', false,
      'window_identity', existing.id,
      'converted_used_tokens', converted_used,
      'window_start', existing.window_start,
      'reset_at', existing.reset_at
    );
end;
$$;

create or replace function public.reserve_usage(
    p_user_id uuid,
    p_anonymous_key_hash text,
    p_feature text,
    p_units integer,
    p_request_id text,
    p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    effective record;
    plan_row public.billing_plans%rowtype;
    quota jsonb;
    quota_limit integer;
    window_seconds integer;
    used_units integer;
    live_reserved_units integer;
    earliest_at timestamptz;
    reset_at timestamptz;
    existing public.quota_reservations%rowtype;
    lock_identity text;
    ttl_seconds integer := 600;
    available_units integer;
    reservation_units integer;
    minimum_units integer := 1;
    is_token_feature boolean;
    migration jsonb := '{}'::jsonb;
begin
    if p_units is null or p_units <= 0 then raise exception 'units must be positive'; end if;
    if nullif(trim(p_request_id), '') is null then raise exception 'request_id is required'; end if;
    if p_user_id is null and nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is null then
      raise exception 'user_id or anonymous_key_hash is required';
    end if;

    is_token_feature := p_feature in ('premium_text', 'lite_text');
    lock_identity := coalesce(p_user_id::text, 'anon:' || p_anonymous_key_hash) || ':' || p_feature;
    perform pg_advisory_xact_lock(hashtextextended('sentiq:quota:' || lock_identity, 0));

    select * into existing from public.quota_reservations where request_id = p_request_id;
    if existing.id is not null then
      return jsonb_build_object(
        'reserved', existing.status in ('reserved', 'committed'),
        'idempotent', true, 'reservation_id', existing.id,
        'status', existing.status, 'feature', existing.feature,
        'plan_code', existing.plan_code, 'reservation_units', existing.units,
        'window_identity', existing.metadata ->> 'window_identity'
      );
    end if;

    select * into effective from public.get_effective_plan(p_user_id) limit 1;
    select * into plan_row from public.billing_plans
      where code = coalesce(effective.plan_code, 'free') and is_active = true;
    if plan_row.id is null then select * into plan_row from public.billing_plans where code = 'free'; end if;

    quota := plan_row.entitlements -> 'quotas' -> p_feature;
    if quota is null then
      return jsonb_build_object('reserved', false, 'reason', 'feature_not_configured',
        'feature', p_feature, 'plan_code', plan_row.code, 'limit', 0, 'used', 0, 'remaining', 0);
    end if;
    quota_limit := greatest(0, coalesce((quota ->> 'limit')::integer, 0));
    window_seconds := greatest(1, coalesce((quota ->> 'window_seconds')::integer, 86400));

    if is_token_feature then
      migration := public.ensure_text_token_policy_migration(
        p_user_id, p_anonymous_key_hash, p_feature, plan_row.code,
        quota_limit, window_seconds
      );
      minimum_units := greatest(1, coalesce((p_metadata ->> 'minimum_tokens')::integer, 256));
    end if;

    select coalesce(sum(units), 0), min(created_at)
    into used_units, earliest_at
    from public.usage_events
    where feature = p_feature
      and created_at >= now() - make_interval(secs => window_seconds)
      and (not is_token_feature or metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1')
      and ((p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash));

    select coalesce(sum(units), 0),
      case when earliest_at is null then min(created_at)
        when min(created_at) is null then earliest_at else least(earliest_at, min(created_at)) end
    into live_reserved_units, earliest_at
    from public.quota_reservations
    where feature = p_feature and status = 'reserved'
      and reservation_expires_at > now()
      and created_at >= now() - make_interval(secs => window_seconds)
      and (not is_token_feature or metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1')
      and ((p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash));

    available_units := greatest(0, quota_limit - used_units - live_reserved_units);
    reservation_units := case when is_token_feature then least(p_units, available_units) else p_units end;
    if reservation_units < minimum_units or (not is_token_feature and p_units > available_units) then
      reset_at := coalesce(earliest_at + make_interval(secs => window_seconds), now() + make_interval(secs => window_seconds));
      return jsonb_build_object(
        'reserved', false, 'reason', 'quota_exceeded', 'feature', p_feature,
        'plan_code', plan_row.code, 'used', used_units,
        'reserved_units', live_reserved_units, 'limit', quota_limit,
        'remaining', available_units, 'reset_at', reset_at,
        'window_start', earliest_at, 'window_identity', migration ->> 'window_identity'
      );
    end if;

    if p_metadata ? 'ttl_seconds' then
      ttl_seconds := greatest(30, least(3600, (p_metadata ->> 'ttl_seconds')::integer));
    end if;

    insert into public.quota_reservations (
      user_id, anonymous_key_hash, plan_code, feature, units, request_id,
      metadata, reservation_expires_at
    ) values (
      p_user_id, case when p_user_id is null then p_anonymous_key_hash else null end,
      plan_row.code, p_feature, reservation_units, p_request_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'window_identity', migration ->> 'window_identity'
      ),
      now() + make_interval(secs => ttl_seconds)
    ) returning * into existing;

    return jsonb_build_object(
      'reserved', true, 'idempotent', false, 'reservation_id', existing.id,
      'feature', p_feature, 'plan_code', plan_row.code, 'used', used_units,
      'reserved_units', live_reserved_units + reservation_units,
      'reservation_units', reservation_units, 'limit', quota_limit,
      'remaining', greatest(0, available_units - reservation_units),
      'window_start', coalesce(earliest_at, existing.created_at),
      'reset_at', coalesce(earliest_at, existing.created_at) + make_interval(secs => window_seconds),
      'window_identity', migration ->> 'window_identity'
    );
end;
$$;

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
    if reservation.feature in ('premium_text', 'lite_text')
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

create or replace function public.release_usage_reservation(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    reservation public.quota_reservations%rowtype;
begin
    select * into reservation from public.quota_reservations
      where request_id = p_request_id for update;
    if reservation.id is null then
      return jsonb_build_object('released', false, 'idempotent', true, 'reason', 'reservation_not_found');
    end if;
    if reservation.status in ('released', 'committed') then
      return jsonb_build_object('released', reservation.status = 'released', 'idempotent', true,
        'reservation_id', reservation.id, 'status', reservation.status);
    end if;
    update public.quota_reservations set status = 'released', updated_at = now()
      where id = reservation.id;
    return jsonb_build_object('released', true, 'idempotent', false,
      'reservation_id', reservation.id, 'released_units', reservation.units);
end;
$$;

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

revoke all on function public.ensure_text_token_policy_migration(uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ensure_text_token_policy_migration(uuid, text, text, text, integer, integer) to service_role;
