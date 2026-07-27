# Pass 7 — Isolated canary and deployment readiness

## Scope

Pass 7 prepares the Nemotron Intuitive and unified Free text-token stack for a real flagged end-to-end canary without activating production traffic.

This pass does not apply database migrations, enable production flags, route production users to a canary, mark the draft pull request ready, deploy, or merge.

## Deployment stages

`SENTIQ_NEMOTRON_ROLLOUT_STAGE` has three valid values:

- `off` — every rollout flag must remain disabled;
- `canary` — all four rollout flags must be enabled together on an isolated canary revision;
- `full` — all four rollout flags must be enabled together and the explicit full-rollout acknowledgement must be present.

The tracked default remains `off` because an omitted stage resolves to `off`.

The four-flag bundle is:

- `SENTIQ_NVIDIA_PROVIDER_ENABLED`
- `SENTIQ_NEMOTRON_INTUITIVE_ENABLED`
- `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED`
- `SENTIQ_INTUITIVE_QUOTA_UI_ENABLED`

Partial canary or full activation is rejected. Independent flags still remain independently readable for tests and emergency inspection, but the deployment preflight prevents an incomplete enabled stack from starting.

## Startup preflight

`backend/verifyNemotronDeploymentReadiness.ts` evaluates a redacted readiness report.

Container startup now runs the compiled preflight before either the Node API or Python gateway starts. Direct `npm start` also runs it first.

With every rollout flag disabled, the preflight passes and current production behaviour is unchanged.

For an enabled canary or full deployment it verifies:

- the complete four-flag bundle;
- a valid deployment stage;
- a non-secret canary revision identifier for canary stage;
- an explicit acknowledgement for full stage;
- at least one server-side NVIDIA key slot;
- a credential-free HTTPS provider base URL;
- the approved primary model pin;
- the approved free Pollinations last-resort model pin;
- the 120-second maximum Intuitive timeout;
- the 8,000-token maximum generated-token ceiling;
- the stable anonymous-identity hash secret;
- control-database credentials needed by unified token RPCs;
- disabled legacy Python quota enforcement.

The report prints booleans, counts, policy limits, stage, and issue codes only. It never prints credentials, bearer tokens, identity hashes, provider responses, prompts, answer text, or hidden reasoning.

## Canary environment

`.env.nemotron-canary.example` is the deployment template for an isolated revision. It deliberately contains no credentials.

The canary must have:

- a separate revision or app label;
- a dedicated HTTPS hostname or internal test endpoint;
- zero production traffic;
- a stable test identity with enough fresh allowance for the suite;
- the three unified-token migrations applied before the flagged revision starts;
- the complete flag bundle enabled;
- `SENTIQ_NEMOTRON_ROLLOUT_STAGE=canary`;
- a unique `SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID`.

Do not enable the bundle on the current production traffic revision merely to run the verifier.

## Manual live workflow

`.github/workflows/nemotron-canary-live.yml` is manual-only and uses the protected `nemotron-canary` GitHub environment.

Required workflow inputs:

- isolated canary backend URL;
- non-secret canary label;
- whether WebSurf must be included;
- explicit `CANARY_ONLY` confirmation.

Optional environment secrets:

- `SENTIQ_NEMOTRON_CANARY_ACCESS_TOKEN` for a dedicated authenticated canary account;
- `SENTIQ_NEMOTRON_CANARY_ANONYMOUS_ID` for a stable guest canary identity.

The workflow uploads a seven-day redacted JSONL report.

## Live verification coverage

`scripts/verifyNemotronCanaryLive.mjs` refuses to run unless explicit canary confirmation is present and remote URLs use HTTPS.

It validates:

1. `/ready` reaches HTTP 200;
2. `/api/billing/usage` exposes the flagged unified quota UI;
3. policy version is `unified-text-tokens-v2`;
4. limit is 50,000 tokens;
5. protected Fast reserve is 10,000 tokens;
6. the test identity has sufficient Fast and Intuitive capacity;
7. an ordinary Fast stream completes;
8. an ordinary Intuitive stream completes;
9. an Intuitive file-context stream completes;
10. an Intuitive WebSurf stream emits source metadata when required;
11. cancellation occurs after visible output begins;
12. no provider/model branding or hidden-reasoning markers become public;
13. unified usage increases after successful calls;
14. remaining unified capacity decreases;
15. reservations settle back to zero.

The verifier never writes answer text or raw stream bodies to its report.

## Canary entry gate

Before creating the canary revision:

1. Confirm PR CI is green.
2. Confirm all six NVIDIA slots have already passed direct provider verification.
3. Apply the three additive unified-token migrations to the canary control database.
4. Populate the canary secret store from `.env.nemotron-canary.example`.
5. Deploy the feature-branch revision with zero production traffic.
6. Confirm the container startup readiness report is `ready`.
7. Trigger the manual live workflow against the isolated hostname.

A canary is acceptable only when the workflow reports zero failures and the canary logs show no unresolved quota, reservation, provider-pool, cancellation, or hidden-reasoning errors.

## Rollback

Rollback is configuration-first:

1. Set `SENTIQ_NEMOTRON_ROLLOUT_STAGE=off`.
2. Disable all four rollout flags together.
3. Redeploy or deactivate the canary revision.
4. Confirm Fast continues through the existing Groq → Gemini route.
5. Confirm Standard/Lite V1 presentation returns for flag-off clients.
6. Preserve the additive database migrations; do not destructively roll them back.

Pass 5.1 compatibility shadows preserve conservative V1 allowance continuity after V2 is disabled.

## Full rollout remains blocked

Full rollout requires a later explicit decision and:

- `SENTIQ_NEMOTRON_ROLLOUT_STAGE=full`;
- `SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK=ENABLE_FULL_NEMOTRON_ROLLOUT`;
- a successful isolated canary report;
- production migration verification;
- deployment and rollback approval.

No file in Pass 7 sets that acknowledgement or changes any tracked default to enabled.
