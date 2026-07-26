# Nemotron Intuitive / Unified Tokens V2 - Pass 0 Baseline

## Scope

This document records the local pre-Pass 1 baseline and rollback boundaries
before NVIDIA Nemotron is enabled for Intuitive final-answer generation.

- Working branch: `feat/nemotron-intuitive-unified-tokens-v2`
- Base branch: `master`
- Remote master base: `ed1849cd2c46db619f4767b1d057089d89e57efc`
- Pass 0 branch head tested: `52488d4cf39be076d0c634d088ff95639c8b1f7c`

## Independent rollout switches

All four switches were explicitly disabled for the baseline:

```env
SENTIQ_NVIDIA_PROVIDER_ENABLED=false
SENTIQ_NEMOTRON_INTUITIVE_ENABLED=false
SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=false
SENTIQ_INTUITIVE_QUOTA_UI_ENABLED=false
```

The canonical parser is `backend/nemotronRolloutFlags.ts`. An unset value is
also treated as `false`. Enabling one switch does not implicitly enable
another.

Rollback intent:

- Disable `SENTIQ_NVIDIA_PROVIDER_ENABLED` to make the NVIDIA transport dormant.
- Disable `SENTIQ_NEMOTRON_INTUITIVE_ENABLED` to retain the pre-Nemotron Intuitive route.
- Keep `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED` disabled to retain Standard/Lite V1 accounting.
- Keep `SENTIQ_INTUITIVE_QUOTA_UI_ENABLED` disabled because no new quota UI is part of this pass.

## Secret-handling baseline

The local development checkout used for this baseline had an ignored `.env`.
Its contents were not copied into this report, printed, staged, or committed.
`.gitignore` ignores `.env` and `.env.*` while explicitly allowing
`.env.example` and `.env.template`.

The tracked templates contain empty credential placeholders only, including
`NVIDIA_API_KEY_1` through `NVIDIA_API_KEY_6`.

## Existing provider and billing baseline

Before Pass 1:

- Fast and Intuitive text used the existing Groq/Gemini routing behavior.
- NVIDIA was not an executable provider.
- Adapter output caps were 2,500 for Fast and 3,500 for legacy Intuitive.
- Billing used separate `premium_text` and `lite_text` features under
  `standard-lite-tokens-v1`.
- `reserveTextRoute()` could fall from Standard to Lite when Standard was exhausted.
- `/api/billing/me` and `/api/billing/usage` exposed separate Standard/Lite
  quota entries; no unified text-token entry existed.

## Completed local baseline

| Command | Result |
| --- | --- |
| `npm run build` | Pass |
| `npm run test:nemotron-rollout-flags` | Pass |
| `npm run billing:test-token-allowances` | Pass; V1 policy confirmed |
| `npm run test:execution-profiles` | Pass |
| `npm run test:model-capability-routing` | Pass |
| `npm run test:model-tool-contract` | Pass |
| `npm run test:model-tool-transport` | Pass |
| `npm run test:context-budget` | Pass |
| `npm run test:pipeline` | Pass; 16/16 |
| `python backend/testAdapterRouting.py` | Pass |
| `python backend/testGeminiFallbackRouting.py` | Pass |
| `python backend/testGroqCapacity.py` | Pass |
| `python backend/testPollinationsSSEParser.py` | Pass |
| `python backend/testSafetyTimeoutPolicy.py` | Pass |
| `python backend/testModelToolProviderTransport.py` | Pass |
| `npm run verify:model-native-stack-startup-live` | Pass on isolated local ports |
| `npm run test:frontend` | Wrapper failed on Windows: `spawnSync npm.cmd EINVAL` |

The frontend wrapper failure was reproduced outside the sandbox and is a
pre-existing Windows process-spawn issue. Practical constituent checks were
run separately: frontend syntax, file generation, tool lifecycle, billing,
and all 51 UI-state files passed. The bootstrap wrapper reproduced the same
`spawnSync ts-node.cmd EINVAL` limitation.

## Completed pre-change live smoke baseline

The isolated local stack used all four rollout switches set to `false`.
No prompts, responses, credentials, tokens, cookies, or identity values are
recorded here.

| Scenario | Result |
| --- | --- |
| Fast ordinary chat | Guest SSE HTTP 200; token event, terminal done, no error |
| Intuitive ordinary chat | Guest SSE HTTP 200; token event, terminal done, no error |
| Tool request | Manual WebSurf HTTP 200; web-search route, sources, token event, terminal done |
| File-backed request | Synthetic text-file context HTTP 200; token event, terminal done, no error |
| Interrupted streaming | First token received, client aborted, no client-side restart observed |
| `/api/billing/me` | HTTP 200; redacted top-level shape: `identity`, `mode`, `summary` |
| `/api/billing/usage` | HTTP 200; redacted top-level shape: `mode`, `summary` |

The redacted billing summary retained separate `premium_text` and `lite_text`
objects alongside existing non-text features.

These were guest tests. No authenticated JWT was available, so authenticated
message persistence and an authenticated before/after usage delta were not
tested. This report does not claim they passed.

## Baseline conclusion

The local build, backend routing, tool, context, V1 billing, Python provider,
and isolated-stack baselines were healthy before Pass 1. The only failed
required command was the documented Windows frontend wrapper spawn issue.
With all four new switches disabled, the pre-Pass 1 behavior is the rollback
reference.
