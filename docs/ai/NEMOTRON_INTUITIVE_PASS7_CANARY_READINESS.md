# Pass 7 — Isolated canary and deployment readiness

## Scope

Pass 7 prepares the Nemotron Intuitive and unified Free text-token stack for a real flagged end-to-end canary without activating production traffic.

This pass does not apply database migrations, enable production flags, route production users to a canary, mark the draft pull request ready, deploy, or merge.

## Deployment stages

`SENTIQ_NEMOTRON_ROLLOUT_STAGE` has three valid values:

- `off` — every rollout flag must remain disabled;
- `canary` — one or more dependency-safe rollout capabilities may run on an isolated canary revision;
- `full` — production-stage configuration requires the explicit full-rollout acknowledgement.

The tracked default remains `off` because an omitted stage resolves to `off`.

The four independent kill switches are:

- `SENTIQ_NVIDIA_PROVIDER_ENABLED`
- `SENTIQ_NEMOTRON_INTUITIVE_ENABLED`
- `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED`
- `SENTIQ_INTUITIVE_QUOTA_UI_ENABLED`

The deployment preflight preserves their independence. Disabling a capability is always restart-safe, which allows staged canarying and emergency rollback. Unsafe dependency inversions remain blocked:

- Intuitive cannot run without its NVIDIA provider;
- Intuitive cannot run without unified text-token V2;
- the Intuitive quota UI cannot run without unified text-token V2.

A dependency-safe partial bundle is reported as a warning so it cannot be mistaken for the complete end-to-end rollout. The dedicated activation preflight supports `--require-complete-bundle` when all four capabilities are required.

## Startup preflight

`backend/verifyNemotronDeploymentReadiness.ts` evaluates a redacted readiness report.

Container startup now runs the compiled preflight before either the Node API or Python gateway starts. Direct `npm start` also runs it first.

With every rollout flag disabled, the preflight passes and current production behaviour is unchanged.

Depending on which capabilities are enabled, it verifies:

- dependency-safe flag relationships;
- a valid deployment stage;
- a non-secret canary revision identifier for canary stage;
- an explicit acknowledgement for full stage;
- at least one server-side NVIDIA key slot when the provider is enabled;
- a credential-free HTTPS provider base URL;
- the approved primary model pin;
- the approved free Pollinations last-resort model pin;
- the 120-second maximum Intuitive timeout;
- the 8,000-token maximum generated-token ceiling;
- the stable anonymous-identity hash secret when unified V2 is enabled;
- control-database credentials needed by unified token RPCs;
- disabled legacy Python quota enforcement when unified V2 is enabled.

The report prints booleans, counts, policy limits, stage, issue codes, and warnings only. It never prints credentials, bearer tokens, identity hashes, provider responses, prompts, answer text, or hidden reasoning.

## Canary environment

`.env.nemotron-canary.example` is the deployment template for the complete isolated end-to-end revision. It deliberately contains no credentials.

The full end-to-end canary must have:

- a separate revision or app label;
- a dedicated HTTPS hostname or internal test endpoint;
- zero production traffic;
- a stable test identity with enough fresh allowance for the suite;
- the three unified-token migrations applied before unified V2 starts;
- the complete four-flag bundle enabled;
- `SENTIQ_NEMOTRON_ROLLOUT_STAGE=canary`;
- a unique `SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID`.

Provider-only or unified-ledger-only canary stages are allowed before this complete state, provided dependencies remain valid. The live end-to-end workflow itself requires the complete bundle because it verifies the provider, Intuitive lane, unified ledger, and frontend quota contract together.

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

Before creating the complete canary revision:

1. Confirm PR CI is green.
2. Confirm all six NVIDIA slots have already passed direct provider verification.
3. Apply the three additive unified-token migrations to the canary control database.
4. Populate the canary secret store from `.env.nemotron-canary.example`.
5. Run `npm run verify:nemotron-deployment-readiness -- --require-enabled --require-complete-bundle --expect-stage=canary` against the canary environment.
6. Deploy the feature-branch revision with zero production traffic.
7. Confirm the container startup readiness report is `ready`.
8. Trigger the manual live workflow against the isolated hostname.

A canary is acceptable only when the workflow reports zero failures and the canary logs show no unresolved quota, reservation, provider-pool, cancellation, or hidden-reasoning errors.

## Rollback

Rollback is configuration-first and may use the independent kill switches:

1. Disable the affected capability first; dependent capabilities must also be disabled when their prerequisite is removed.
2. For complete rollback, disable all four flags and set `SENTIQ_NEMOTRON_ROLLOUT_STAGE=off`.
3. Redeploy or deactivate the canary revision.
4. Confirm Fast continues through the existing Groq → Gemini route.
5. Confirm Standard/Lite V1 presentation returns after unified V2 and its quota UI are disabled.
6. Preserve the additive database migrations; do not destructively roll them back.

Pass 5.1 compatibility shadows preserve conservative V1 allowance continuity after V2 is disabled.

## Full rollout remains blocked

Full rollout requires a later explicit decision and:

- `SENTIQ_NEMOTRON_ROLLOUT_STAGE=full`;
- `SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK=ENABLE_FULL_NEMOTRON_ROLLOUT`;
- a successful complete isolated canary report;
- production migration verification;
- a complete-bundle activation preflight;
- deployment and rollback approval.

No file in Pass 7 sets that acknowledgement or changes any tracked default to enabled.
