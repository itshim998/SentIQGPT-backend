-- SentIQ Chat plan-tier image quota policy.
--
-- RUN ON: Auth/control database only (Database 1 / SUPABASE_URL_1).
-- DO NOT RUN ON: Data shards 2, 3, or 4. Those shards do not own
-- public.billing_plans or the public.reserve_usage billing ledger.
--
-- This migration is idempotent and preserves every non-image entitlement.

begin;

do $$
begin
    if to_regclass('public.billing_plans') is null then
        raise exception
            'plan-tier image policy requires public.billing_plans on the auth/control database';
    end if;
end
$$;

with desired(code, quota_limit, window_seconds) as (
    values
        ('free'::text, 2::integer, 86400::integer),
        ('student_core'::text, 4::integer, 43200::integer),
        ('premium'::text, 8::integer, 43200::integer),
        ('pro'::text, 16::integer, 43200::integer)
), prepared as (
    select
        bp.code,
        desired.quota_limit,
        desired.window_seconds,
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
    entitlements = jsonb_set(
        prepared.entitlements_with_quotas,
        '{quotas,image_generation}',
        jsonb_build_object(
            'limit', prepared.quota_limit,
            'window_seconds', prepared.window_seconds,
            'label', 'Images',
            'unit', 'count'
        ),
        true
    ),
    updated_at = now()
from prepared
where bp.code = prepared.code;

do $$
declare
    matching_plan_count integer;
begin
    select count(*)
    into matching_plan_count
    from public.billing_plans bp
    where
        (bp.code = 'free'
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 2
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 86400)
        or
        (bp.code = 'student_core'
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 4
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200)
        or
        (bp.code = 'premium'
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 8
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200)
        or
        (bp.code = 'pro'
            and (bp.entitlements #>> '{quotas,image_generation,limit}')::integer = 16
            and (bp.entitlements #>> '{quotas,image_generation,window_seconds}')::integer = 43200);

    if matching_plan_count <> 4 then
        raise exception
            'plan-tier image policy verification failed: expected 4 matching billing plans, found %',
            matching_plan_count;
    end if;
end
$$;

commit;
