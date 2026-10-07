# SentIQ Chat Billing And Pricing

SentIQ Chat billing is server-owned. The frontend displays quota state and sends an opaque anonymous id header for guest quota identity.

## Plans and Pricing

Authoritative plans are stored in the auth/control Supabase database (Database 1):

- **Free**: Starter Standard and Lite access. 2 image credits per 24 hours (86,400s). Price: ₹0 (0 paise).
- **Essential** (`student_core`): 12 image credits per 12 hours (43,200s). Price: ₹129/month (12,900 paise).
- **Plus** (`premium`): 20 image credits per 12 hours (43,200s). Price: ₹299/month (29,900 paise).
- **Pro** (`pro`): 32 image credits per 12 hours (43,200s). Price: ₹699/month (69,900 paise).

Razorpay plan IDs are preserved without modification across plan updates.

## Weighted Image Credit Costs

Different image models consume differing numbers of credits based on computational intensity:

| Model | Credit Cost | Description |
|---|---|---|
| `@cf/black-forest-labs/flux-1-schnell` | 1 credit | Fast, high-throughput base generation |
| `dreamshaper` / `dreamshaper-xl-lightning` | 1 credit | Immediate fallback for Free tier |
| `@cf/black-forest-labs/flux-2-klein-4b` | 2 credits | High-detail paid model |
| `gpt-image-2` (Pollinations) | 8 credits | Pro Intuitive tier primary model |
| `mai-image-2.6` (Pollinations) | 8 credits | Pro Intuitive tier secondary fallback |
| `flux-pro` (FLUX 1.1 Pro) | 8 credits | Pro Intuitive tier tertiary fallback |

*Note*: The Pro Intuitive 8-credit cost is an explicit SentIQ product safety policy. Klein 9B has been completely retired from active preference and routing.

## Final Image Routing Matrix

| Public Plan | Internal Code | Mode | Primary Model | Fallback Chain | Max Reservation |
|---|---|---|---|---|---|
| Free | `free` | Fast | Schnell (`flux-1-schnell`) | DreamShaper (`dreamshaper-xl-lightning`) | 1 credit |
| Free | `free` | Intuitive | Schnell (`flux-1-schnell`) | DreamShaper (`dreamshaper-xl-lightning`) | 1 credit |
| Essential | `student_core` | Fast | Schnell (`flux-1-schnell`) | Klein 4B (`flux-2-klein-4b`) | 2 credits |
| Essential | `student_core` | Intuitive | Klein 4B (`flux-2-klein-4b`) | Schnell (`flux-1-schnell`) | 2 credits |
| Plus | `premium` | Fast | Schnell (`flux-1-schnell`) | Klein 4B (`flux-2-klein-4b`) | 2 credits |
| Plus | `premium` | Intuitive | Klein 4B (`flux-2-klein-4b`) | Schnell (`flux-1-schnell`) | 2 credits |
| Pro | `pro` | Fast | Schnell (`flux-1-schnell`) | Klein 4B (`flux-2-klein-4b`) | 2 credits |
| Pro | `pro` | Intuitive | GPT-Image-2 (`gpt-image-2`) | MAI-Image-2.6 → FLUX 1.1 Pro (`flux-pro`) | 8 credits |

## Reservation & Settlement Lifecycle

1. **Pre-flight Reservation**: Before invoking an image provider, the server resolves the user's plan and execution mode, reserving the maximum possible credits for the fallback chain (e.g. 2 credits for Essential Fast, 8 credits for Pro Intuitive).
2. **Actual Settlement**: Upon successful generation, `actual_image_credits` is calculated from the model that actually succeeded (e.g. if Pro Fast uses Schnell, 1 credit is settled; unused reserved credits are automatically released).
3. **Failure Release**: If image generation fails, the entire reservation is released with 0 credits charged.
4. **Burst Cooldown**: A 5-second burst cooldown per user prevents abusive rapid-fire generation without arbitrary daily ceilings.

## Database Rollout

Migration `supabase/migrations/20261007180000_weighted_image_credits_and_revised_tiers.sql` applies to Database 1 (auth/control) only:
- Updates prices and image credit quotas in `public.billing_plans`.
- Updates `public.commit_usage_reservation` to settle `actual_image_credits` and release unused units.
- Updates `public.get_usage_summary` to include quota `unit`.
