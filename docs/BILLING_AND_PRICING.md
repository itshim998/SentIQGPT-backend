# SentIQ Chat Billing And Pricing

SentIQ Chat billing is server-owned. The frontend only displays quota state and sends an opaque anonymous id header for guest quota identity.

## Plans

Default plans are stored in the auth/control Supabase database (Database 1):

- Free: starter Standard and Lite access, 2 images per 24 hours.
- Essential (`student_core`): 4 images per 12 hours.
- Plus (`premium`): 8 images per 12 hours.
- Pro: 16 images per 12 hours.

Plan prices and advanced reasoning limits can be overridden with the documented billing environment variables. Image quota windows are plan policy, not prompt-category environment configuration.

## Billable Features

- `premium_text`: Standard text route.
- `lite_text`: fallback text route after Standard quota is exhausted.
- `image_generation`: plan-tier image generation route.
- `advanced_reasoning`: math and deeper reasoning route.
- `file_analysis`, `web_search`, and `generated_file`: tracked in the catalog for future enforcement.

## Text-model tool calling

SentIQ Chat keeps image generation server-owned while allowing the active texting model to select the validated `image_gen` tool:

- Fast mode: Groq, Gemini, and the Pollinations fallback support the SentIQ tool contract.
- Intuitive mode: Nvidia Nemotron supports the same tool contract when the Intuitive rollout flags are enabled.
- The model returns structured tool arguments; Node validates and authorizes them before any image provider is called.
- `image_gen.requires_text_rendering` is a required Boolean. It means that readable words, letters, numbers, captions, labels, signage, titles, slogans, logos, interface copy, or similar text must appear inside the generated pixels.

Provider support does not grant model-side authority over billing, quotas, plan identity, storage, or fallback execution. Those remain server-owned.

## Image routing

Free retains its existing route regardless of the text-rendering decision:

| Public plan | Internal code | Text rendering required | Primary model | Immediate fallback |
|---|---|---:|---|---|
| Free | `free` | Either | `dreamshaper` | `flux` |
| Essential | `student_core` | No | `zimage` | `klein` |
| Essential | `student_core` | Yes | `gpt-image-2` | `kontext` |
| Plus | `premium` | No | `zimage` | `klein` |
| Plus | `premium` | Yes | `gpt-image-2` | `kontext` |
| Pro | `pro` | No | `zimage` | `klein` |
| Pro | `pro` | Yes | `gpt-image-2` | `kontext` |

Essential, Plus, and Pro therefore have identical model access. Their image-generation difference is quota only.

For automatic `image_gen` calls, the active texting model supplies the validated text-rendering decision. The direct image endpoint requests the same structured decision from the active text lane after quota reservation. A deterministic classifier is used only when that classification call is unavailable; it does not override a valid model decision.

Additional emergency providers remain after the immediate fallback so a temporary provider failure does not unnecessarily make image generation unavailable.

The retired prompt-category variables `SENTIQ_IMAGE_MODEL_NORMAL`, `SENTIQ_IMAGE_MODEL_TEXT_CORE`, and `SENTIQ_IMAGE_MODEL_TEXT_PREMIUM` are no longer read.

The server reserves quota before provider calls, commits successful generations, and releases failed reservations.

## Database rollout

`supabase/migrations/20260801091500_plan_tier_image_policy.sql` updates the authoritative image quota records in `billing_plans`.

Apply it only to the auth/control database (`SUPABASE_URL_1`). Do not apply it to data shards 2–4; those shards do not own billing plans or the `reserve_usage` ledger.

The model-decided text-rendering route does not require an additional database migration. It changes runtime model selection while preserving the existing quota records and windows.

## Frontend contract

Frontend billing state is display/cache only:

- `GET /api/billing/plans`
- `GET /api/billing/me`
- `GET /api/billing/usage`
- `GET /api/images/quota`

Quota errors use safe fields: `code`, `type`, `feature`, `plan_code`, `reset_at`, `remaining`, `limit`, and `upgrade_cta`.
