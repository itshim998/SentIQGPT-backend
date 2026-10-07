# Plan-Tier Image Policy Rollout & Weighted Credits

## Scope

- Database migration: `supabase/migrations/20261007180000_weighted_image_credits_and_revised_tiers.sql`
- Target database: Auth/control database only (`Database 1`, `SUPABASE_URL_1`)
- Data shards 2–4: No billing migration required (shards do not own `public.billing_plans` or the `reserve_usage` ledger)

## Policy & Pricing Summary

### Plans and Quotas

| Plan | Price | Image Quota | Window | Label | Unit |
|---|---|---|---|---|---|
| Free | ₹0 | 2 credits | 24 hours | Image credits | credits |
| Essential (`student_core`) | ₹129/mo (12,900 paise) | 12 credits | 12 hours | Image credits | credits |
| Plus (`premium`) | ₹299/mo (29,900 paise) | 20 credits | 12 hours | Image credits | credits |
| Pro (`pro`) | ₹699/mo (69,900 paise) | 32 credits | 12 hours | Image credits | credits |

### Credit Costs by Model

- Schnell (`@cf/black-forest-labs/flux-1-schnell`): 1 credit
- DreamShaper (`dreamshaper-xl-lightning`): 1 credit
- Klein 4B (`@cf/black-forest-labs/flux-2-klein-4b`): 2 credits
- Pro Intuitive Pollinations chain (`gpt-image-2`, `mai-image-2.6`, `flux-pro`): 8 credits
- Klein 9B: Retired completely

### Final 8-Cell Routing Matrix

| Plan | Fast Route | Intuitive Route |
|---|---|---|
| Free | Schnell → DreamShaper (reserve 1) | Schnell → DreamShaper (reserve 1) |
| Essential | Schnell → Klein 4B (reserve 2) | Klein 4B → Schnell (reserve 2) |
| Plus | Schnell → Klein 4B (reserve 2) | Klein 4B → Schnell (reserve 2) |
| Pro | Schnell → Klein 4B (reserve 2) | GPT-Image-2 → MAI-Image-2.6 → FLUX 1.1 Pro (reserve 8) |

## Verification Check — Auth/Control Database (DB1)

```sql
select
  code,
  price_paise,
  (entitlements #>> '{quotas,image_generation,limit}')::integer as image_limit,
  (entitlements #>> '{quotas,image_generation,window_seconds}')::integer as image_window_seconds,
  entitlements #>> '{quotas,image_generation,label}' as image_label,
  entitlements #>> '{quotas,image_generation,unit}' as image_unit
from public.billing_plans
order by sort_order;
```

Expected output:
```text
free         | 0     | 2  | 86400 | Image credits | credits
student_core | 12900 | 12 | 43200 | Image credits | credits
premium      | 29900 | 20 | 43200 | Image credits | credits
pro          | 69900 | 32 | 43200 | Image credits | credits
```
