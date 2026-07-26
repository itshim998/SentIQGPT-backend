# Nemotron Intuitive / Unified Tokens V2 — Pass 0 Baseline

## Scope

This document records the repository baseline and rollback boundaries before NVIDIA Nemotron, the Intuitive provider lane, unified text-token billing, or quota UI are implemented.

- Working branch: `feat/nemotron-intuitive-unified-tokens-v2`
- Base branch: `master`
- Base commit: `ed1849cd2c46db619f4767b1d057089d89e57efc`
- Base commit message: `chore(ui): publish unboxed activity revision`

## Independent rollout switches

All new switches default to disabled and are intentionally independent:

```env
SENTIQ_NVIDIA_PROVIDER_ENABLED=false
SENTIQ_NEMOTRON_INTUITIVE_ENABLED=false
SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=false
SENTIQ_INTUITIVE_QUOTA_UI_ENABLED=false
```

The canonical parser is `backend/nemotronRolloutFlags.ts`. An unset value is treated as `false`. Enabling one switch must not implicitly enable another.

Rollback intent:

- Disable `SENTIQ_NVIDIA_PROVIDER_ENABLED` to remove the NVIDIA provider without changing billing or frontend quota UI.
- Disable `SENTIQ_NEMOTRON_INTUITIVE_ENABLED` to return Intuitive execution to the pre-Nemotron route while leaving the provider code dormant.
- Disable `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED` to retain Standard/Lite V1 accounting independently of provider routing.
- Disable `SENTIQ_INTUITIVE_QUOTA_UI_ENABLED` to hide the new composer/settings quota UX without changing backend enforcement.

Pass 0 does not wire these switches into request routing, billing, or frontend behaviour. With all switches disabled, runtime behaviour must remain identical to `master`.

## Secret-handling baseline

The following credential files were not present at the branch baseline:

- `.env`
- `.env.local`
- `.env.production`

`.gitignore` now ignores `.env` and every `.env.*` variant while explicitly allowing `.env.example` and `.env.template`. Real API keys must remain only in an untracked local `.env` or a deployment secret store.

The tracked templates contain empty placeholders only, including `NVIDIA_API_KEY_1` through `NVIDIA_API_KEY_6`.

## Existing provider and billing baseline

Before later passes:

- Fast/standard text routing is configured around Groq with Gemini fallback paths.
- Pollinations remains the existing final fallback/provider for relevant paths.
- NVIDIA is not yet an executable provider.
- Execution modes are `fast` and `intuitive`, but the current adapter output caps are still the legacy values.
- Billing uses separate `premium_text` and `lite_text` token features under policy `standard-lite-tokens-v1`.
- `reserveTextRoute()` can fall from Standard to Lite when the Standard allowance is exhausted.
- Public usage endpoints are:
  - `GET /api/billing/me`
  - `GET /api/billing/usage`
- The current public summary exposes separate Standard/Lite quota entries. No unified `text_tokens` entry exists yet.

## Required local baseline commands

The GitHub connector cannot execute the repository, access the local `.env`, call live providers, or simulate browser streaming. Run these commands locally or through Codex before Pass 1 implementation:

```bash
npm install
npm run build
npm run billing:test-token-allowances
npm run test:execution-profiles
npm run test:model-capability-routing
npm run test:model-tool-contract
npm run test:model-tool-transport
npm run test:model-tool-execution
npm run test:context-budget
npm run test:pipeline
npm run test:file-generation
npm run test:frontend
npm run test:nemotron-rollout-flags
```

Also run any broader repository test batch normally used before production deployment. The repository currently has many individually named test scripts rather than one authoritative `test` command.

## Required live smoke baseline

Capture results before enabling any new switch:

| Scenario | Required evidence | Pass 0 status |
| --- | --- | --- |
| Fast ordinary chat | provider route, first-token latency, completion status, persisted message | Pending local/live run |
| Intuitive ordinary chat | route, context behaviour, completion status, persisted message | Pending local/live run |
| Tool request | selected tool, tool success, final synthesis, persistence | Pending local/live run |
| File-backed request | upload/extraction status, context use, final response | Pending local/live run |
| Interrupted streaming | partial text, cancellation, no duplicate continuation, preserved draft | Pending local/browser run |
| Billing summary | redacted JSON shape from `/api/billing/me` and `/api/billing/usage` | Pending authenticated local/live run |

Do not commit access tokens, cookies, user identifiers, private file content, full prompts, or raw provider responses into the baseline record.

## Baseline CI observation

No combined commit statuses or pull-request workflow runs were attached to the base commit when Pass 0 was created. A green local build/test run is therefore required before Pass 1; repository history alone is not sufficient evidence.

## Pass 0 gate

Pass 0 is ready for hand-off only when:

1. The branch exists from the recorded base commit.
2. All four switches resolve to `false` when unset.
3. The independence test passes.
4. Real environment files remain untracked.
5. The local baseline commands pass.
6. The live smoke matrix is recorded outside source control or in a redacted report.
7. Behaviour with all switches disabled matches `master`.
