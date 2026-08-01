# Plan-Tier Image Policy Rollout

## Scope

- Application branch: `fix/plan-tier-image-routing-pass1`
- Database migration: `supabase/migrations/20260801091500_plan_tier_image_policy.sql`
- Database target: auth/control database only (`Database 1`, `SUPABASE_URL_1`)
- Data shards 2–4: no migration required and the image quota migration must not be applied there

The auth/control database owns `public.billing_plans`, `public.usage_events`, `public.quota_reservations`, `public.get_effective_plan`, and `public.reserve_usage`. User data shards own conversation, memory, and user workspace records instead.

## Policy

| Plan | Primary | Immediate fallback | Image quota |
|---|---|---|---|
| Free | `dreamshaper` | `flux` | 2 / 24 hours |
| Essential | `zimage` | `klein` | 4 / 12 hours |
| Plus | `zimage` | `klein` | 8 / 12 hours |
| Pro | `gpt-image-2` | `kontext` | 16 / 12 hours |

Prompt wording does not alter the plan-entitled primary model.

## Pre-apply check — auth/control database

```sql
select
  code,
  entitlements #>> '{quotas,image_generation,limit}' as image_limit,
  entitlements #>> '{quotas,image_generation,window_seconds}' as image_window_seconds
from public.billing_plans
where code in ('free', 'student_core', 'premium', 'pro')
order by sort_order;
```

Expected before migration: all four plans exist. Pro may still show `12` for the image limit.

## Apply

Run the complete contents of:

```text
supabase/migrations/20260801091500_plan_tier_image_policy.sql
```

against `SUPABASE_URL_1` only.

Do not run it against `SUPABASE_URL_2`, `SUPABASE_URL_3`, or `SUPABASE_URL_4`.

## Post-apply verification — auth/control database

```sql
select
  code,
  (entitlements #>> '{quotas,image_generation,limit}')::integer as image_limit,
  (entitlements #>> '{quotas,image_generation,window_seconds}')::integer as image_window_seconds,
  entitlements #>> '{quotas,image_generation,label}' as image_label,
  entitlements #>> '{quotas,image_generation,unit}' as image_unit
from public.billing_plans
where code in ('free', 'student_core', 'premium', 'pro')
order by case code
  when 'free' then 1
  when 'student_core' then 2
  when 'premium' then 3
  when 'pro' then 4
end;
```

Expected rows:

```text
free         | 2  | 86400 | Images | count
student_core | 4  | 43200 | Images | count
premium      | 8  | 43200 | Images | count
pro          | 16 | 43200 | Images | count
```

## Deployment order

1. Merge the application PR after all checks pass.
2. Apply the auth/control database migration.
3. Deploy the backend revision containing the typed plan-tier router.
4. Confirm `/api/billing/plans` exposes the new Pro quota.
5. Generate one image with a test account from each plan and confirm provider lifecycle logs show the expected primary model without prompt or credential material.
6. Confirm failed provider attempts proceed to the requested immediate fallback.

## Rollback

Application rollback: redeploy the previous backend revision.

Database rollback for the Pro quota only:

```sql
update public.billing_plans
set
  entitlements = jsonb_set(
    entitlements,
    '{quotas,image_generation}',
    jsonb_build_object(
      'limit', 12,
      'window_seconds', 43200,
      'label', 'Images',
      'unit', 'count'
    ),
    true
  ),
  updated_at = now()
where code = 'pro';
```

Free, Essential, and Plus retain their pre-existing image quota values.
