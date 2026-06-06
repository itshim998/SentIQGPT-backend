# Billing Runbook

## Deploy

1. Apply `supabase/migrations/20260604120000_billing_plans_usage_and_subscriptions.sql` to the control Supabase database.
2. Set `SENTIQ_BILLING_MODE=disabled` or `manual` first.
3. Run `npm run billing:seed-plans`.
4. Deploy backend and frontend.
5. Verify:
   - `GET /api/billing/plans`
   - `GET /api/billing/me`
   - `GET /api/images/quota`

## Manual Grants

Set `SENTIQ_BILLING_ADMIN_EMAILS` to comma-separated verified account emails.

Then call `POST /api/admin/billing/grant-plan` with:

```json
{
  "user_id": "supabase-user-id",
  "plan_code": "student_core",
  "expires_at": "2026-07-05T00:00:00.000Z",
  "reason": "manual grant"
}
```

Paid manual grants require an expiry by default. Set `SENTIQ_BILLING_ALLOW_PERMANENT_MANUAL_GRANTS=true` only when a permanent manual grant is an intentional operational decision.

## Checks

- `npm run billing:test-quota`
- `npm run billing:verify-razorpay-config`
- `npm run build`
- `npm run test:frontend-bootstrap`
- `npm run test:conversation-sync`
- `npm run test:phase0`

## Failure Handling

- Keep `SENTIQ_BILLING_MODE=disabled` to make checkout unavailable while keeping plans and quota display bootable.
- Use `manual` to accept admin grants without Razorpay.
- Leave `SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT=false` so Python does not double-count signed-in LLM usage.

## Rollback

Set `SENTIQ_BILLING_MODE=disabled` and redeploy. Existing billing tables can remain in the control database; routes will keep returning plan/usage display where available.
