# Nemotron Intuitive Pass 1

## Scope

Pass 1 adds an independently testable NVIDIA NIM text provider, an explicitly
flagged Intuitive final-answer lane, and centralized generation/reasoning
budgets. It does not implement unified-token billing V2 or quota UI changes.

The route is active only when both of these are true:

```env
SENTIQ_NVIDIA_PROVIDER_ENABLED=true
SENTIQ_NEMOTRON_INTUITIVE_ENABLED=true
```

`SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED` and
`SENTIQ_INTUITIVE_QUOTA_UI_ENABLED` do not participate in backend routing.

## Provider boundary

`backend/nvidia_nemotron.py` owns:

- arbitrary `NVIDIA_API_KEY_1..N` discovery;
- blank-value removal and exact-value deduplication;
- stable safe identifiers such as `nvidia-slot-1`;
- health-aware, least-in-flight round-robin selection;
- transient, 429/`Retry-After`, and authentication cooldowns;
- OpenAI-compatible NVIDIA NIM SSE parsing;
- first-chunk, idle, and total timeouts;
- cancellation and response closure;
- hidden-reasoning discard and aggregate token accounting.

Provider diagnostics expose only safe slot state. They do not expose key
values, key prefixes/suffixes, environment names, hidden reasoning, prompts,
or raw responses.

The NVIDIA request uses:

- base URL `https://integrate.api.nvidia.com/v1`;
- model `nvidia/nemotron-3-ultra-550b-a55b`;
- streaming with usage metadata;
- `chat_template_kwargs.enable_thinking=true`;
- the centralized per-request `reasoning_budget`.

An enabled provider with no usable indexed keys produces a clear internal
configuration error. When the provider flag is false, key discovery remains
dormant and normal startup does not depend on NVIDIA configuration.

## Routing lifecycle

Fast remains on its existing route:

```text
Groq GPT-OSS pool -> Gemini pool
```

The flagged Intuitive final-answer route is:

```text
composed Intuitive context -> healthy NVIDIA slot -> visible SentIQ answer
```

Automatic tool-backed requests do not give Nemotron tool-selection
responsibility:

```text
existing tool-capable route, selection-only turn
  -> existing tool executor
  -> bounded trusted result/evidence
  -> Nemotron final synthesis
```

The selection-only prompt cannot produce a user-facing full answer. When it
returns no tool call, the original composed call is sent once to the
Intuitive final-answer lane. WebSurf V2, image, chart, and generated-file
results, plus successful memory writes, receive one final synthesis pass.
Nemotron is not used for
image-input calls in this pass.

New text-provider and model identifiers are not included in public response
metadata. Provider failures use a generic Intuitive availability error.

## Hidden reasoning and streaming

`reasoning_content` is measured and discarded inside the NVIDIA provider.
Only visible content crosses the provider boundary. The internal stream may
carry an aggregate usage event to Node; `llm_service.py` removes that event
from the public token stream and `PromptBuilders.ts` uses it for the existing
request allowance accounting.

Reported provider usage is preferred. A conservative visible-plus-hidden
floor is applied if an OpenAI-compatible endpoint reports less completion
usage than the locally observed stream requires. When reported usage is
absent, the existing conservative estimators are used. Failed calls are not
recorded as successful usage.

A failed slot may be replaced only before meaningful visible content starts.
Reasoning-only chunks do not start visible output. After visible output
starts, the stream fails in place and cannot restart on another slot or
provider.

## Central budgets

`backend/orchestrator/contextBudgetManager.ts` is the single output-budget
decision point.

| Route | Total generation ceiling | Maximum reasoning | Protected visible answer | Timeout |
| --- | ---: | ---: | ---: | ---: |
| Fast | 2,500 | Low effort | Existing behavior | Existing behavior |
| Intuitive ordinary | 6,000 | 2,000 | 1,500 | 120 seconds |
| Intuitive complex | 8,000 | 3,500 | 2,000 | 120 seconds |

The existing deterministic complexity signal marks file/evidence-backed
generation as complex. The resolver applies provider limits and the remaining
current V1 request reservation. It reduces reasoning first as affordability
tightens and rejects a call when the protected visible-answer capacity cannot
fit.

These non-secret settings are documented in `.env.example` and
`.env.template`:

```env
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_NEMOTRON_MODEL=nvidia/nemotron-3-ultra-550b-a55b
POLLINATIONS_INTUITIVE_MODEL=vendouple/nemotron-3-ultra:free
SENTIQ_INTUITIVE_ORDINARY_MAX_GENERATED_TOKENS=6000
SENTIQ_INTUITIVE_ORDINARY_REASONING_BUDGET=2000
SENTIQ_INTUITIVE_ORDINARY_MIN_FINAL_ANSWER_TOKENS=1500
SENTIQ_INTUITIVE_COMPLEX_MAX_GENERATED_TOKENS=8000
SENTIQ_INTUITIVE_COMPLEX_REASONING_BUDGET=3500
SENTIQ_INTUITIVE_COMPLEX_MIN_FINAL_ANSWER_TOKENS=2000
SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS=120000
SENTIQ_NVIDIA_FIRST_CHUNK_TIMEOUT_MS=30000
SENTIQ_NVIDIA_STREAM_IDLE_TIMEOUT_MS=45000
SENTIQ_NVIDIA_KEY_COOLDOWN_MS=60000
SENTIQ_NVIDIA_429_COOLDOWN_MS=180000
SENTIQ_NVIDIA_AUTH_FAILURE_COOLDOWN_MS=3600000
```

## Pollinations last resort

The configured Pollinations community-model identifier for the Intuitive
last-resort route is:

```text
vendouple/nemotron-3-ultra:free
```

It is present in `.env.example` and `.env.template`, and the existing adapter
reads it through `POLLINATIONS_INTUITIVE_MODEL`. Local and deployed runtime
environments must also set that non-secret variable; tracked templates do not
modify an existing untracked `.env` or cloud environment automatically.

The lane uses Pollinations only after the NVIDIA pool fails before visible
answer output begins. It does not fall back to Fast when the Intuitive
providers are unavailable.

## Verification

Focused deterministic verification:

```bash
npm run test:nemotron-provider
npm run test:context-budget
npm run test:nemotron-rollout-flags
```

The provider suite simulates 429, `Retry-After`, invalid credentials, 5xx,
network timeout, empty/malformed streams, cooldown recovery, concurrent
selection, cancellation, pre-visible fallback, and the no-fallback-after-
visible invariant. Live smoke outcomes are reported separately in the draft
pull request and final implementation handoff; secrets and raw provider
responses must not be recorded.

## Redacted live smoke result

The low-cost live verifier discovered six safe local slots without printing
key material:

| Slot | Independent minimal request |
| --- | --- |
| `nvidia-slot-1` | Failed with HTTP 403 in the original Pass 1 run; correctly disabled as an authentication failure |
| `nvidia-slot-2` | Passed |
| `nvidia-slot-3` | Passed |
| `nvidia-slot-4` | Initial transient failure; recovered and passed in the pooled run |
| `nvidia-slot-5` | Passed |
| `nvidia-slot-6` | Passed |

The `NVIDIA_API_KEY_1` credential was replaced after the original run. Its
current status must be established by a new redacted `nvidia-slot-1` live
request; the historical 403 result above is retained until that rerun passes.

The pooled run covered every enabled working slot. One intermittent empty
stream was skipped safely before visible output and the pool continued on a
different healthy slot. A test-harness transient cooldown on
`nvidia-slot-4` caused the next request to use `nvidia-slot-5`. Direct
provider cancellation after visible output left zero slots in flight.

An isolated stack with both route flags enabled then passed:

- Fast ordinary streaming; internal route remained Groq.
- Intuitive ordinary streaming; internal route used NVIDIA.
- Intuitive synthetic file-context generation.
- Intuitive manual WebSurf evidence followed by NVIDIA final synthesis.
- Client cancellation after the first visible token.
- No `reasoning_content`, think tags, NVIDIA name, or Nemotron model branding
  in any client-visible stream.

The controlled guest `/api/billing/usage` comparison remained on
`standard-lite-tokens-v1`. Standard usage changed from 0 to 5,283 tokens,
the final reserved amount returned to 0 after cancellation cleanup, and Lite
usage remained 0. Billing mode was disabled, and no authenticated JWT was
available, so this is not an authenticated persistence or allowance test.

The Pollinations fallback was not exercised during the original Pass 1 live
run because the model identifier had not yet been supplied. It is now
configured for a later low-cost fallback smoke test.
