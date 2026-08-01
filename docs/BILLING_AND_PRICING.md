# SentIQ Chat Billing And Pricing

SentIQ Chat billing is server-owned. The frontend only displays quota state and sends an opaque anonymous id header for guest quota identity.

## Plans

Default plans are stored in the auth/control Supabase database (Database 1):

- Free: starter Standard and Lite access, 2 images per 24 hours.
- Essential (`student_core`): 4 images per 12 hours.
- Plus (`premium`): 8 images per 12 hours.
- Pro: 16 images per 12 hours.

Plan prices and advanced reasoning limits can be overridden with the documented billing environment variables. Image model entitlement and image quota windows are plan policy, not prompt-category environment configuration.

## Billable Features

- `premium_text`: Standard text route.
- `lite_text`: fallback text route after Standard quota is exhausted.
- `image_generation`: plan-tier image generation route.
- `advanced_reasoning`: math and deeper reasoning route.
- `file_analysis`, `web_search`, and `generated_file`: tracked in the catalog for future enforcement.

## Routing

Text model aliases are configured by environment:

- `SENTIQ_MODEL_PREMIUM_TEXT=groq:gpt-oss-120b`
- `SENTIQ_MODEL_LITE_TEXT=gemini:gemini-lite`
- `SENTIQ_MODEL_ADVANCED_REASONING=groq:gpt-oss-120b`

Image routing is fixed by the resolved billing plan and does not change for text-heavy prompts:

| Public plan | Internal code | Primary model | Immediate fallback |
|---|---|---|---|
| Free | `free` | `dreamshaper` | `flux` |
| Essential | `student_core` | `zimage` | `klein` |
| Plus | `premium` | `zimage` | `klein` |
| Pro | `pro` | `gpt-image-2` | `kontext` |

Additional emergency providers remain after the immediate fallback so a temporary provider failure does not unnecessarily make image generation unavailable.

The retired prompt-category variables `SENTIQ_IMAGE_MODEL_NORMAL`, `SENTIQ_IMAGE_MODEL_TEXT_CORE`, and `SENTIQ_IMAGE_MODEL_TEXT_PREMIUM` are no longer read.

The server reserves quota before provider calls, commits successful generations, and releases failed reservations.

## Database Rollout

`supabase/migrations/20260801091500_plan_tier_image_policy.sql` updates the authoritative `billing_plans` rows.

Apply it only to the auth/control database (`SUPABASE_URL_1`). Do not apply it to data shards 2–4; those shards do not own billing plans or the `reserve_usage` ledger.

## Frontend Contract

Frontend billing state is display/cache only:

- `GET /api/billing/plans`
- `GET /api/billing/me`
- `GET /api/billing/usage`
- `GET /api/images/quota`

Quota errors use safe fields: `code`, `type`, `feature`, `plan_code`, `reset_at`, `remaining`, `limit`, and `upgrade_cta`.
