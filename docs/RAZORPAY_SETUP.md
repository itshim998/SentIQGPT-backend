# Razorpay Setup

## Environment

Use `SENTIQ_BILLING_MODE=razorpay_test` for test mode and `razorpay_live` for production.

Required values:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `RAZORPAY_PLAN_STUDENT_CORE`
- `RAZORPAY_PLAN_PREMIUM`
- `RAZORPAY_PLAN_PRO`

Run:

```bash
npm run billing:verify-razorpay-config
```

## Plans

Create Razorpay subscription plans matching SentIQ Chat paid plans:

- Student Core
- Premium
- Pro

Put the Razorpay plan ids into the matching env vars above, then run:

```bash
npm run billing:seed-plans
```

## Webhook

Configure Razorpay webhook URL:

```text
https://<backend-host>/api/billing/webhook/razorpay
```

The backend captures the raw JSON body only for this webhook route and validates `x-razorpay-signature` with `RAZORPAY_WEBHOOK_SECRET`.

## Activation

1. Keep mode `manual` or `disabled` until migration and plan seed are verified.
2. Switch to `razorpay_test`.
3. Complete a test checkout.
4. Confirm `billing_events`, `user_subscriptions`, and `user_billing_profiles` update as expected.
5. Switch to `razorpay_live` only after dashboard plan ids and webhook secret are production values.
