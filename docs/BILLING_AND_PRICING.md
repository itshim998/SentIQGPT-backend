# SentIQ Chat Billing And Pricing

SentIQ Chat billing is server-owned. The frontend only displays quota state and sends an opaque anonymous id header for guest quota identity.

## Plans

Default plans are seeded into the control Supabase database:

- Free: starter Standard, Lite, image, and no default advanced reasoning quota.
- Student Core: affordable Standard usage and small image/advanced reasoning limits.
- Premium: higher Standard, Lite, image, and advanced reasoning limits.
- Pro: highest included limits.

Plan prices and advanced reasoning limits can be overridden with environment variables in `.env.example`.

## Billable Features

- `premium_text`: Standard text route.
- `lite_text`: fallback text route after Standard quota is exhausted.
- `image_generation`: image generation route.
- `advanced_reasoning`: math and deeper reasoning route.
- `file_analysis`, `web_search`, and `generated_file`: tracked in the catalog for future enforcement.

## Routing

Model aliases are configured by environment:

- `SENTIQ_MODEL_PREMIUM_TEXT=groq:gpt-oss-120b`
- `SENTIQ_MODEL_LITE_TEXT=pollinations:llama-scout`
- `SENTIQ_MODEL_ADVANCED_REASONING=pollinations:openai-large`
- `SENTIQ_IMAGE_MODEL_NORMAL=pollinations:zimage`
- `SENTIQ_IMAGE_MODEL_TEXT_CORE=pollinations:gptimage`
- `SENTIQ_IMAGE_MODEL_TEXT_PREMIUM=pollinations:gptimage-large`

The server reserves quota before provider calls, commits successful generations, and releases failed reservations.

## Frontend Contract

Frontend billing state is display/cache only:

- `GET /api/billing/plans`
- `GET /api/billing/me`
- `GET /api/billing/usage`
- `GET /api/images/quota`

Quota errors use safe fields: `code`, `type`, `feature`, `plan_code`, `reset_at`, `remaining`, `limit`, and `upgrade_cta`.
