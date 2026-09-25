-- SentIQ Chat Billing, subscription, and rolling-usage source of truth.
--
-- RUN ON: Control database (Database 1).
-- Billing tables are intended for backend/service-role access. Public frontend
-- responses must go through backend billing routes.

create extension if not exists pgcrypto;

create table if not exists public.billing_plans (
    id uuid primary key default gen_random_uuid(),
    code text not null unique check (code in ('free', 'student_core', 'premium', 'pro')),
    name text not null,
    description text not null default '',
    currency text not null default 'INR',
    price_paise integer not null default 0 check (price_paise >= 0),
    interval text not null default 'month' check (interval = 'month'),
    sort_order integer not null default 0,
    is_public boolean not null default true,
    is_active boolean not null default true,
    provider_plan_ids jsonb not null default '{}'::jsonb,
    entitlements jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.user_billing_profiles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null unique,
    email text,
    display_name text,
    current_plan_code text not null default 'free' references public.billing_plans(code),
    effective_status text not null default 'free',
    current_subscription_id uuid,
    trial_ends_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.user_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    plan_code text not null references public.billing_plans(code),
    status text not null check (status in ('free', 'trialing', 'active', 'pending', 'past_due', 'canceled', 'canceling', 'expired', 'halted', 'manual')),
    gateway text not null check (gateway in ('manual', 'razorpay')),
    gateway_customer_id text,
    gateway_subscription_id text,
    gateway_plan_id text,
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    canceled_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists user_subscriptions_gateway_subscription_id_idx
on public.user_subscriptions(gateway_subscription_id)
where gateway_subscription_id is not null;

alter table public.user_subscriptions
drop constraint if exists user_subscriptions_status_check;

alter table public.user_subscriptions
add constraint user_subscriptions_status_check
check (status in ('free', 'trialing', 'active', 'pending', 'past_due', 'canceled', 'canceling', 'expired', 'halted', 'manual'));

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'user_subscriptions_gateway_subscription_unique'
          and conrelid = 'public.user_subscriptions'::regclass
    ) then
        alter table public.user_subscriptions
        add constraint user_subscriptions_gateway_subscription_unique
        unique (gateway, gateway_subscription_id);
    end if;
end $$;

alter table public.user_billing_profiles
drop constraint if exists user_billing_profiles_current_subscription_fk;

alter table public.user_billing_profiles
add constraint user_billing_profiles_current_subscription_fk
foreign key (current_subscription_id) references public.user_subscriptions(id)
deferrable initially deferred;

create table if not exists public.billing_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    subscription_id uuid references public.user_subscriptions(id),
    gateway text not null,
    event_type text not null,
    gateway_event_id text,
    gateway_entity_id text,
    raw jsonb not null default '{}'::jsonb,
    processed_at timestamptz,
    created_at timestamptz not null default now()
);

create unique index if not exists billing_events_gateway_event_id_unique_idx
on public.billing_events(gateway, gateway_event_id)
where gateway_event_id is not null;

create table if not exists public.payment_transactions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    subscription_id uuid references public.user_subscriptions(id),
    gateway text not null,
    gateway_payment_id text unique,
    amount_paise integer not null default 0 check (amount_paise >= 0),
    currency text not null default 'INR',
    status text not null,
    invoice_id text,
    raw jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.usage_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    anonymous_key_hash text,
    plan_code text not null default 'free',
    feature text not null check (feature in (
        'premium_text',
        'lite_text',
        'image_generation',
        'advanced_reasoning',
        'file_analysis',
        'web_search',
        'generated_file'
    )),
    units integer not null default 1 check (units > 0),
    provider text,
    model text,
    safe_model_label text,
    route text,
    conversation_id text,
    client_request_id text,
    request_id text,
    estimated_input_chars integer,
    estimated_output_chars integer,
    estimated_cost_paise numeric,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    check (user_id is not null or anonymous_key_hash is not null)
);

create unique index if not exists usage_events_request_id_unique_idx
on public.usage_events(request_id)
where request_id is not null;

create table if not exists public.quota_reservations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid,
    anonymous_key_hash text,
    plan_code text not null default 'free',
    feature text not null check (feature in (
        'premium_text',
        'lite_text',
        'image_generation',
        'advanced_reasoning',
        'file_analysis',
        'web_search',
        'generated_file'
    )),
    units integer not null check (units > 0),
    request_id text not null unique,
    status text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
    metadata jsonb not null default '{}'::jsonb,
    reservation_expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (user_id is not null or anonymous_key_hash is not null)
);

create index if not exists usage_events_user_feature_created_idx
on public.usage_events(user_id, feature, created_at desc);

create index if not exists usage_events_anonymous_feature_created_idx
on public.usage_events(anonymous_key_hash, feature, created_at desc);

create index if not exists user_subscriptions_user_status_idx
on public.user_subscriptions(user_id, status);

create index if not exists billing_events_gateway_event_idx
on public.billing_events(gateway, gateway_event_id);

create index if not exists quota_reservations_request_id_idx
on public.quota_reservations(request_id);

create index if not exists quota_reservations_user_feature_created_idx
on public.quota_reservations(user_id, feature, created_at);

create index if not exists quota_reservations_anonymous_feature_created_idx
on public.quota_reservations(anonymous_key_hash, feature, created_at);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists billing_plans_updated_at on public.billing_plans;
create trigger billing_plans_updated_at
before update on public.billing_plans
for each row execute function public.set_updated_at();

drop trigger if exists user_billing_profiles_updated_at on public.user_billing_profiles;
create trigger user_billing_profiles_updated_at
before update on public.user_billing_profiles
for each row execute function public.set_updated_at();

drop trigger if exists user_subscriptions_updated_at on public.user_subscriptions;
create trigger user_subscriptions_updated_at
before update on public.user_subscriptions
for each row execute function public.set_updated_at();

drop trigger if exists payment_transactions_updated_at on public.payment_transactions;
create trigger payment_transactions_updated_at
before update on public.payment_transactions
for each row execute function public.set_updated_at();

drop trigger if exists quota_reservations_updated_at on public.quota_reservations;
create trigger quota_reservations_updated_at
before update on public.quota_reservations
for each row execute function public.set_updated_at();

insert into public.billing_plans (
    code,
    name,
    description,
    currency,
    price_paise,
    interval,
    sort_order,
    provider_plan_ids,
    entitlements
) values
(
    'free',
    'Free',
    'Starter access with transparent rolling limits.',
    'INR',
    0,
    'month',
    10,
    '{}'::jsonb,
    '{
      "quotas": {
        "premium_text": {"limit": 10, "window_seconds": 28800, "label": "Standard messages"},
        "lite_text": {"limit": 40, "window_seconds": 86400, "label": "Lite messages"},
        "image_generation": {"limit": 2, "window_seconds": 86400, "label": "Images"},
        "advanced_reasoning": {"limit": 0, "window_seconds": 86400, "label": "Advanced reasoning"}
      },
      "safe_labels": {"premium_text": "Standard", "lite_text": "Lite", "image_generation": "Image", "text_image_generation": "Precision Image"}
    }'::jsonb
),
(
    'student_core',
    'Student Core',
    'Affordable Standard access for students.',
    'INR',
    9900,
    'month',
    20,
    '{}'::jsonb,
    '{
      "quotas": {
        "premium_text": {"limit": 50, "window_seconds": 28800, "label": "Standard messages"},
        "lite_text": {"limit": 160, "window_seconds": 86400, "label": "Lite messages"},
        "image_generation": {"limit": 4, "window_seconds": 43200, "label": "Images"},
        "advanced_reasoning": {"limit": 3, "window_seconds": 86400, "label": "Advanced reasoning"}
      },
      "safe_labels": {"premium_text": "Standard", "lite_text": "Lite", "image_generation": "Image", "text_image_generation": "Precision Image"}
    }'::jsonb
),
(
    'premium',
    'Premium',
    'Best value for heavier student workflows.',
    'INR',
    24900,
    'month',
    30,
    '{}'::jsonb,
    '{
      "quotas": {
        "premium_text": {"limit": 75, "window_seconds": 28800, "label": "Standard messages"},
        "lite_text": {"limit": 260, "window_seconds": 86400, "label": "Lite messages"},
        "image_generation": {"limit": 8, "window_seconds": 43200, "label": "Images"},
        "advanced_reasoning": {"limit": 8, "window_seconds": 86400, "label": "Advanced reasoning"}
      },
      "safe_labels": {"premium_text": "Standard", "lite_text": "Lite", "image_generation": "Image", "text_image_generation": "Precision Image"}
    }'::jsonb
),
(
    'pro',
    'Pro',
    'Highest SentIQ Chat limits for regular power use.',
    'INR',
    54900,
    'month',
    40,
    '{}'::jsonb,
    '{
      "quotas": {
        "premium_text": {"limit": 100, "window_seconds": 21600, "label": "Standard messages"},
        "lite_text": {"limit": 400, "window_seconds": 86400, "label": "Lite messages"},
        "image_generation": {"limit": 12, "window_seconds": 43200, "label": "Images"},
        "advanced_reasoning": {"limit": 20, "window_seconds": 86400, "label": "Advanced reasoning"}
      },
      "safe_labels": {"premium_text": "Standard", "lite_text": "Lite", "image_generation": "Image", "text_image_generation": "Precision Image"}
    }'::jsonb
)
on conflict (code) do update set
    name = excluded.name,
    description = excluded.description,
    currency = excluded.currency,
    price_paise = excluded.price_paise,
    interval = excluded.interval,
    sort_order = excluded.sort_order,
    entitlements = excluded.entitlements,
    updated_at = now();

create or replace function public.get_effective_plan(p_user_id uuid)
returns table (
    plan_code text,
    status text,
    subscription_id uuid,
    current_period_end timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    profile public.user_billing_profiles%rowtype;
    subscription public.user_subscriptions%rowtype;
begin
    if p_user_id is null then
        plan_code := 'free';
        status := 'free';
        subscription_id := null;
        current_period_end := null;
        return next;
        return;
    end if;

    select *
    into profile
    from public.user_billing_profiles
    where user_id = p_user_id;

    if profile.current_subscription_id is not null then
        select *
        into subscription
        from public.user_subscriptions
        where id = profile.current_subscription_id
          and user_id = p_user_id;
    end if;

    if subscription.id is not null
       and (
           (
               subscription.status in ('active', 'trialing', 'manual')
               and (subscription.current_period_end is null or subscription.current_period_end > now())
           )
           or (
               subscription.status = 'canceling'
               and subscription.current_period_end is not null
               and subscription.current_period_end > now()
           )
       ) then
        plan_code := subscription.plan_code;
        status := subscription.status;
        subscription_id := subscription.id;
        current_period_end := subscription.current_period_end;
        return next;
        return;
    end if;

    if profile.id is not null
       and profile.current_plan_code <> 'free'
       and profile.effective_status = 'manual'
       and profile.current_subscription_id is null then
        plan_code := profile.current_plan_code;
        status := profile.effective_status;
        subscription_id := null;
        current_period_end := null;
        return next;
        return;
    end if;

    plan_code := 'free';
    status := coalesce(profile.effective_status, 'free');
    subscription_id := null;
    current_period_end := null;
    return next;
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
begin
    if p_units is null or p_units <= 0 then
        raise exception 'units must be positive';
    end if;
    if nullif(trim(p_request_id), '') is null then
        raise exception 'request_id is required';
    end if;
    if p_user_id is null and nullif(trim(coalesce(p_anonymous_key_hash, '')), '') is null then
        raise exception 'user_id or anonymous_key_hash is required';
    end if;

    lock_identity := coalesce(p_user_id::text, 'anon:' || p_anonymous_key_hash) || ':' || p_feature;
    perform pg_advisory_xact_lock(hashtextextended('sentiq:quota:' || lock_identity, 0));

    select *
    into existing
    from public.quota_reservations
    where request_id = p_request_id;

    if existing.id is not null then
        return jsonb_build_object(
            'reserved', existing.status in ('reserved', 'committed'),
            'idempotent', true,
            'reservation_id', existing.id,
            'status', existing.status,
            'feature', existing.feature,
            'plan_code', existing.plan_code
        );
    end if;

    select *
    into effective
    from public.get_effective_plan(p_user_id)
    limit 1;

    select *
    into plan_row
    from public.billing_plans
    where code = coalesce(effective.plan_code, 'free')
      and is_active = true;

    if plan_row.id is null then
        select * into plan_row from public.billing_plans where code = 'free';
    end if;

    quota := plan_row.entitlements -> 'quotas' -> p_feature;
    if quota is null then
        return jsonb_build_object(
            'reserved', false,
            'reason', 'feature_not_configured',
            'feature', p_feature,
            'plan_code', plan_row.code,
            'limit', 0,
            'used', 0,
            'remaining', 0
        );
    end if;

    quota_limit := greatest(0, coalesce((quota ->> 'limit')::integer, 0));
    window_seconds := greatest(1, coalesce((quota ->> 'window_seconds')::integer, 86400));

    select coalesce(sum(units), 0), min(created_at)
    into used_units, earliest_at
    from public.usage_events
    where feature = p_feature
      and created_at >= now() - make_interval(secs => window_seconds)
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      );

    select
        coalesce(sum(units), 0),
        case
            when earliest_at is null then min(created_at)
            when min(created_at) is null then earliest_at
            else least(earliest_at, min(created_at))
        end
    into live_reserved_units, earliest_at
    from public.quota_reservations
    where feature = p_feature
      and status = 'reserved'
      and reservation_expires_at > now()
      and created_at >= now() - make_interval(secs => window_seconds)
      and (
        (p_user_id is not null and user_id = p_user_id)
        or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
      );

    if used_units + live_reserved_units + p_units > quota_limit then
        reset_at := coalesce(earliest_at + make_interval(secs => window_seconds), now() + make_interval(secs => window_seconds));
        return jsonb_build_object(
            'reserved', false,
            'reason', 'quota_exceeded',
            'feature', p_feature,
            'plan_code', plan_row.code,
            'used', used_units,
            'reserved_units', live_reserved_units,
            'limit', quota_limit,
            'remaining', greatest(0, quota_limit - used_units - live_reserved_units),
            'reset_at', reset_at
        );
    end if;

    if p_metadata ? 'ttl_seconds' then
        ttl_seconds := greatest(30, least(3600, (p_metadata ->> 'ttl_seconds')::integer));
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
        p_user_id,
        p_anonymous_key_hash,
        plan_row.code,
        p_feature,
        p_units,
        p_request_id,
        coalesce(p_metadata, '{}'::jsonb),
        now() + make_interval(secs => ttl_seconds)
    )
    returning * into existing;

    return jsonb_build_object(
        'reserved', true,
        'idempotent', false,
        'reservation_id', existing.id,
        'feature', p_feature,
        'plan_code', plan_row.code,
        'used', used_units,
        'reserved_units', live_reserved_units + p_units,
        'limit', quota_limit,
        'remaining', greatest(0, quota_limit - used_units - live_reserved_units - p_units),
        'reset_at', null
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
    event_id uuid;
    merged_metadata jsonb;
begin
    select *
    into reservation
    from public.quota_reservations
    where request_id = p_request_id
    for update;

    if reservation.id is null then
        return jsonb_build_object('committed', false, 'reason', 'reservation_not_found');
    end if;

    if reservation.status = 'released' then
        return jsonb_build_object('committed', false, 'reason', 'reservation_released');
    end if;

    if reservation.status = 'committed' then
        select id into event_id from public.usage_events where request_id = p_request_id limit 1;
        return jsonb_build_object('committed', true, 'idempotent', true, 'usage_event_id', event_id);
    end if;

    merged_metadata := coalesce(reservation.metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb);

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
        reservation.user_id,
        reservation.anonymous_key_hash,
        reservation.plan_code,
        reservation.feature,
        reservation.units,
        p_provider,
        p_model,
        coalesce(merged_metadata ->> 'safe_model_label', null),
        p_route,
        coalesce(merged_metadata ->> 'conversation_id', null),
        coalesce(merged_metadata ->> 'client_request_id', null),
        reservation.request_id,
        merged_metadata
    )
    on conflict (request_id) where request_id is not null do update set
        metadata = public.usage_events.metadata || excluded.metadata
    returning id into event_id;

    update public.quota_reservations
    set status = 'committed',
        metadata = merged_metadata,
        updated_at = now()
    where id = reservation.id;

    return jsonb_build_object('committed', true, 'idempotent', false, 'usage_event_id', event_id);
end;
$$;

create or replace function public.release_usage_reservation(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    updated_id uuid;
begin
    update public.quota_reservations
    set status = case when status = 'committed' then status else 'released' end,
        updated_at = now()
    where request_id = p_request_id
    returning id into updated_id;

    return jsonb_build_object('released', updated_id is not null, 'reservation_id', updated_id);
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
    summary jsonb := '{}'::jsonb;
begin
    select * into effective from public.get_effective_plan(p_user_id) limit 1;
    select * into plan_row from public.billing_plans where code = coalesce(effective.plan_code, 'free');
    if plan_row.id is null then
        select * into plan_row from public.billing_plans where code = 'free';
    end if;

    for feature_key, quota in
        select key, value from jsonb_each(plan_row.entitlements -> 'quotas')
    loop
        quota_limit := greatest(0, coalesce((quota ->> 'limit')::integer, 0));
        window_seconds := greatest(1, coalesce((quota ->> 'window_seconds')::integer, 86400));

        select coalesce(sum(units), 0), min(created_at)
        into used_units, earliest_at
        from public.usage_events
        where feature = feature_key
          and created_at >= now() - make_interval(secs => window_seconds)
          and (
            (p_user_id is not null and user_id = p_user_id)
            or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
          );

        select
            coalesce(sum(units), 0),
            case
                when earliest_at is null then min(created_at)
                when min(created_at) is null then earliest_at
                else least(earliest_at, min(created_at))
            end
        into live_reserved_units, earliest_at
        from public.quota_reservations
        where feature = feature_key
          and status = 'reserved'
          and reservation_expires_at > now()
          and created_at >= now() - make_interval(secs => window_seconds)
          and (
            (p_user_id is not null and user_id = p_user_id)
            or (p_user_id is null and anonymous_key_hash = p_anonymous_key_hash)
          );

        reset_at := case
            when used_units + live_reserved_units >= quota_limit
            then coalesce(earliest_at + make_interval(secs => window_seconds), now() + make_interval(secs => window_seconds))
            else null
        end;

        summary := summary || jsonb_build_object(
            feature_key,
            jsonb_build_object(
                'label', quota ->> 'label',
                'used', used_units,
                'reserved', live_reserved_units,
                'limit', quota_limit,
                'remaining', greatest(0, quota_limit - used_units - live_reserved_units),
                'window_seconds', window_seconds,
                'reset_at', reset_at
            )
        );
    end loop;

    return jsonb_build_object(
        'plan_code', plan_row.code,
        'status', coalesce(effective.status, 'free'),
        'subscription_id', effective.subscription_id,
        'current_period_end', effective.current_period_end,
        'quotas', summary
    );
end;
$$;

create or replace function public.admin_grant_plan(
    p_user_id uuid,
    p_plan_code text,
    p_expires_at timestamptz,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    subscription_id uuid;
begin
    if p_user_id is null then
        raise exception 'user_id is required';
    end if;
    if not exists (select 1 from public.billing_plans where code = p_plan_code and is_active = true) then
        raise exception 'unknown plan_code %', p_plan_code;
    end if;

    insert into public.user_subscriptions (
        user_id,
        plan_code,
        status,
        gateway,
        current_period_start,
        current_period_end,
        metadata
    ) values (
        p_user_id,
        p_plan_code,
        'manual',
        'manual',
        now(),
        p_expires_at,
        jsonb_build_object('reason', coalesce(p_reason, 'manual grant'))
    )
    returning id into subscription_id;

    insert into public.user_billing_profiles (
        user_id,
        current_plan_code,
        effective_status,
        current_subscription_id
    ) values (
        p_user_id,
        p_plan_code,
        'manual',
        subscription_id
    )
    on conflict (user_id) do update set
        current_plan_code = excluded.current_plan_code,
        effective_status = excluded.effective_status,
        current_subscription_id = excluded.current_subscription_id,
        updated_at = now();

    return jsonb_build_object('success', true, 'subscription_id', subscription_id, 'plan_code', p_plan_code);
end;
$$;

alter table public.billing_plans enable row level security;
alter table public.user_billing_profiles enable row level security;
alter table public.user_subscriptions enable row level security;
alter table public.billing_events enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.usage_events enable row level security;
alter table public.quota_reservations enable row level security;

drop policy if exists "billing_plans_public_select" on public.billing_plans;
create policy "billing_plans_public_select"
on public.billing_plans
for select
using (is_public = true and is_active = true);

revoke all on function public.get_effective_plan(uuid) from public, anon, authenticated;
revoke all on function public.reserve_usage(uuid, text, text, integer, text, jsonb) from public, anon, authenticated;
revoke all on function public.commit_usage_reservation(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_usage_reservation(text) from public, anon, authenticated;
revoke all on function public.get_usage_summary(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_grant_plan(uuid, text, timestamptz, text) from public, anon, authenticated;

grant execute on function public.get_effective_plan(uuid) to service_role;
grant execute on function public.reserve_usage(uuid, text, text, integer, text, jsonb) to service_role;
grant execute on function public.commit_usage_reservation(text, text, text, text, jsonb) to service_role;
grant execute on function public.release_usage_reservation(text) to service_role;
grant execute on function public.get_usage_summary(uuid, text) to service_role;
grant execute on function public.admin_grant_plan(uuid, text, timestamptz, text) to service_role;
