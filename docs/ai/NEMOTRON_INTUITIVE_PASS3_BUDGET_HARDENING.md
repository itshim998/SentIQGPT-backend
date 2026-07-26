# Nemotron Intuitive Pass 3: Budget Hardening

## Scope

Pass 3 closes the request-local budget lifecycle for the reversible Nemotron
Intuitive rollout. It does not enable the rollout, change public UI, introduce
unified-token billing V2, migrate persistence, or implement the five-hour
window and product reserves deferred to Passes 4–5.

Before Pass 3, Node selected a generated-output budget and recorded successful
usage, but composed input and generated completion limits still shared
ambiguous “total token” names. Model calls also committed usage only after
completion, so overlapping internal calls could observe the same unspent
request balance.

After Pass 3:

- Node is the canonical product-policy owner.
- Composed input ceilings and generated completion ceilings are separate.
- Every gateway call reserves estimated input plus selected generation before
  provider invocation.
- Successful calls commit reported or conservatively estimated usage and
  release unused capacity.
- Failed or cancelled calls without reliable usage release their pending
  allocation.
- Reliable usage returned with an abnormal completion is still recorded.
- A named future obligation protects an Intuitive final synthesis from
  selection, repair, continuation, routing, memory, title, and other
  model-backed calls in the same request context.

> **Pass 3.1 correction:** The original Pass 3 emergency fit path could trim
> the system prompt, and its final whole-prompt character guard was not
> section-aware. Pass 3.1 removes both behaviors. The complete system prompt
> and stable context-handling rules are now immutable. If those blocks, the
> minimum current message, and minimum required evidence cannot fit, composition
> fails with `context_budget_insufficient` before provider invocation. See
> `NEMOTRON_INTUITIVE_PASS3_1_PROTECTED_CONTEXT_SAFETY.md`.

## Canonical policy owner

`backend/orchestrator/contextBudgetManager.ts` owns product policy and
`backend/context/requestBudgetContext.ts` owns its request-local enforcement.
Node sends explicit generation and reasoning values to Python.

Python remains a defensive transport boundary:

- it may clamp a Node value downward for provider safety;
- it never increases a positive Node-selected value;
- its fallback constants apply only to legacy callers that omit an explicit
  value;
- it does not select a SentIQ plan, mode, or complexity policy.

## Input-context policy

The value below is the maximum composed model input. It is not added to or
substituted for the generation ceiling.

| Plan | Mode | Ordinary | Complex |
| --- | --- | ---: | ---: |
| Free | Fast | 3,200 | 4,000 |
| Free | Intuitive | 6,000 | 8,000 |
| student_core | Fast or Intuitive | 6,000 | 7,500 |
| premium | Fast or Intuitive | 9,500 | 12,000 |
| pro | Fast or Intuitive | 16,000 | 22,000 |

Paid-plan differentiation is unchanged. The composer retains immutable
system/policy and stable handling rules, then the current-message minimum and
required tool/source evidence ahead of files, optional evidence, memories,
summaries/capsules, and older optional history. Impossible protected floors
fail before provider invocation; system and stable rules are never trimmed.
The legacy
`tokenBudget` composer override remains compatibility-safe but is explicitly
documented as composed input only; new code uses
`inputContextCeilingTokens`.

The Free context defaults are exposed as non-secret, default-safe environment
settings:

```env
SENTIQ_FREE_FAST_ORDINARY_CONTEXT_TOKENS=3200
SENTIQ_FREE_FAST_COMPLEX_CONTEXT_TOKENS=4000
SENTIQ_FREE_INTUITIVE_ORDINARY_CONTEXT_TOKENS=6000
SENTIQ_FREE_INTUITIVE_COMPLEX_CONTEXT_TOKENS=8000
```

## Generation, reasoning, reserve, and timeout policy

Generated completion includes hidden reasoning and visible output. Reasoning
is never added on top of the generation ceiling.

| Mode | Complexity | Generation ceiling | Maximum reasoning | Protected visible answer | Timeout |
| --- | --- | ---: | ---: | ---: | ---: |
| Fast | Ordinary or complex | 2,500 | Low effort | Existing Fast behavior | Existing Fast behavior |
| Intuitive | Ordinary | 6,000 | 2,000 | 1,500 | 120 seconds |
| Intuitive | Complex | 8,000 | 3,500 | 2,000 | 120 seconds |

The 3,500 Intuitive value remains only as the legacy non-Nemotron generation
ceiling. It is not used for the flagged Nemotron final-answer lane.

## Affordability

For a new call, the request ledger first computes:

```text
available request tokens =
  request reservation
  - committed input and output
  - pending model-call reservations
  - active future obligations not consumed by this call
```

The generation resolver then computes:

```text
affordable generation = available request tokens - estimated current input

selected generation = min(
  mode generation ceiling,
  requested generation,
  provider maximum,
  affordable generation
)

selected reasoning = min(
  maximum reasoning,
  selected generation - protected visible answer
)
```

If the protected answer cannot fit, Node throws `GenerationBudgetError` before
provider invocation. Reasoning reaches zero before the protected answer floor
is threatened.

### Exact worked example

For an ordinary Intuitive final answer:

```text
remaining reservation = 7,000
estimated synthesis input = 2,200
generation ceiling = 6,000
maximum reasoning = 2,000
protected visible answer = 1,500

affordable generation = 7,000 - 2,200 = 4,800
selected generation = min(6,000, 4,800) = 4,800
selected reasoning = min(2,000, 4,800 - 1,500) = 2,000
input + generation = 2,200 + 4,800 = 7,000
```

The 4,800 completion allocation already includes the 2,000 reasoning budget.

Boundary tests also prove:

- 3,700 remaining with 2,200 input permits exactly 1,500 generation and zero
  reasoning;
- 3,699 fails before provider invocation;
- a provider maximum of 1,499 fails;
- a provider maximum of 1,500 permits exactly the protected answer floor.

## Future final-synthesis obligation

The Intuitive selection-only path creates the named
`intuitive-final-synthesis` obligation before its supporting model call. The
obligation protects:

- a conservative estimate of known final input, including bounded current
  context and framing/evidence overhead, capped by the canonical context
  ceiling; and
- the policy’s protected visible-answer floor.

All supporting calls see that obligation as unavailable capacity. A supporting
call is capped when it would encroach on the final synthesis and rejected when
even its minimum safe output cannot fit.

The final call names the obligation it consumes. The ledger removes the future
reservation atomically before creating the final call’s pending reservation,
so it is neither lost nor double-counted. Cancellation, selection failure,
pre-provider failure, and tool outcomes that do not require synthesis release
the obligation. Buffered and streaming tool paths use the same lifecycle.

## Pending reservation lifecycle

The request-local ledger uses synchronous atomic mutations around an
`AsyncLocalStorage` context:

1. Estimate the composed provider input.
2. Resolve generation against committed, pending, and future-reserved tokens.
3. Add a pending reservation for estimated input plus selected generation.
4. Invoke the provider.
5. On success, commit reliable provider usage when present; otherwise commit a
   conservative estimate.
6. Release unused pending capacity.
7. On failure or cancellation without reliable usage, release the full pending
   allocation.
8. On abnormal completion with reliable usage, commit that usage and release
   the balance.
9. Close the ledger when the V1 reservation settles; late background work
   cannot start another provider call against an already-settled reservation.

Repeated release or commit attempts return safely without changing totals.
Pending plus committed allocations are clamped to the request reservation, and
remaining capacity never becomes negative. Observed provider usage and any
overrun are retained separately so defensive settlement clamping is not
silent.

A deterministic `Promise.all` test schedules two calls against one 4,000-token
reservation. The first reserves 2,500 tokens; the second is capped to the
remaining 1,500-token total allocation. Their combined pending allocation is
exactly 4,000, never more.

## Tool synthesis

The tool-backed lifecycle is:

```text
existing provider selection-only call
  -> tool execution
  -> bounded trusted evidence
  -> actual composed-input estimate
  -> final budget resolution and pending reservation
  -> Nemotron, or pre-visible Pollinations fallback, with only the selected budget
```

Selection text is suppressed from public output. Web evidence is bounded by
source/result counts and per-result text limits. Image binary/base64, provider
metadata, chart code, file URLs, embeddings, and other raw provider fields are
excluded from synthesis evidence. Once meaningful visible output starts, no
new provider or fallback answer may begin.

## Continuation and repair

Continuation and repair calls use the same request context and therefore see
all committed calls, active pending calls, and future obligations. Ordinary
continuation now always requests at most 1,800 generated tokens and declares a
128-token minimum safe output instead of inheriting the original full
generation ceiling. Intuitive continuations additionally remain subject to the
protected-answer rule. Math continuation and model-backed repair/file paths
also pass through the same gateway reservation boundary.

Insufficient continuation/repair capacity stops cleanly. Already emitted
visible output is preserved, and recovery cannot start a duplicate provider
answer after meaningful output.

## Provider usage rules

- **NVIDIA:** provider completion usage includes visible output and hidden
  reasoning. `reasoning_content` is discarded. If reported completion usage is
  below locally observed visible plus hidden usage, the hidden-reasoning floor
  replaces it; hidden reasoning is not added twice.
- **Pollinations:** valid reported usage is used. Missing or malformed usage is
  conservatively estimated. Its configured Intuitive model remains
  `vendouple/nemotron-3-ultra:free`.
- **Groq and Gemini:** existing valid reported usage is preserved; otherwise
  the shared conservative estimator is used.
- **All providers:** selection, synthesis, continuation, repair, title,
  routing, memory, and other model-backed calls that execute in the request
  context enter the same ledger. Tool execution itself consumes no model
  tokens unless that tool invokes a model.

## Duplicate-constant audit

| Value(s) | Location | Classification |
| --- | --- | --- |
| 3,200 / 4,000 / 6,000 / 8,000 context | `PLAN_MODE_INPUT_CONTEXT_POLICIES` | Canonical Node product policy |
| 2,500 Fast generation | `EXECUTION_MODE_GENERATION_POLICIES.fast` | Canonical Node product policy |
| 3,500 legacy Intuitive generation | `EXECUTION_MODE_GENERATION_POLICIES.intuitive` | Canonical legacy non-Nemotron policy |
| 6,000 / 8,000 generation; 2,000 / 3,500 reasoning; 1,500 / 2,000 answer | `INTUITIVE_GENERATION_POLICIES` | Canonical Node product policy |
| Same context/generation/reasoning/reserve values | `.env.example`, `.env.template` | Environment defaults consumed by Node |
| 8,000 | `SENTIQ_NVIDIA_MAX_GENERATED_TOKENS` in Node and Python | Provider hard safety ceiling; only clamps product policy downward |
| 2,500 / 3,500 | `llm_adapter.py` execution-mode cap | Defensive Python compatibility ceiling for legacy non-Nemotron callers; only clamps explicit Node values downward |
| 6,000 in NVIDIA `max_tokens` fallback | `llm_adapter.py` | Legacy direct-caller transport fallback when Node omits a value |
| 2,000 GPT-OSS default | `llm_adapter.py` | Provider adapter default, not SentIQ mode policy |
| Boundary values in focused tests | `testContextBudgetManager.ts`, `testRequestBudgetLifecycle.ts`, provider tests | Test fixtures |
| Policy tables and worked example | Pass 1 and Pass 3 documentation | Documentation only |

## Verification coverage

Deterministic suites cover the policy matrix, exact affordability and reserve
boundaries, provider-cap boundaries, reasoning reduction, Free context
separation, supporting-call protection, pending commit/release, overlapping
calls, synthesis trust boundaries, continuation/repair affordability, reported
and estimated usage, hidden-reasoning accounting, cancellation cleanup,
no-fallback-after-visible-output, default-off flags, Pollinations configuration,
and public-branding exclusions.

The Nemotron pull-request workflow runs the dedicated
`test:request-budget-lifecycle` suite in addition to the existing context,
provider, routing, and billing checks.

## Redacted slot-1 result

The single Pass 3 run of `python backend/verifyNvidiaSlot1Live.py` passed:

- slot: `nvidia-slot-1`;
- status: pass;
- HTTP status: 200;
- visible reasoning marker: false.

The historical 403 was caused by a stale process-level
`NVIDIA_API_KEY_1` overriding the repaired `.env` value. No persistent Windows
environment variable was modified by this pass, and no response text,
credential material, prompt, or raw header was persisted.

## Pollinations and flags

Both environment templates contain:

```env
POLLINATIONS_INTUITIVE_MODEL=vendouple/nemotron-3-ultra:free
```

The adapter reads that variable, deterministic configuration tests validate
it, and public responses do not expose provider branding.

These independent flags remain false by default:

```env
SENTIQ_NVIDIA_PROVIDER_ENABLED=false
SENTIQ_NEMOTRON_INTUITIVE_ENABLED=false
SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=false
SENTIQ_INTUITIVE_QUOTA_UI_ENABLED=false
```

Provider-only and lane-only combinations still fail closed. Billing V2 and the
quota UI do not affect routing.

## Deferred work

Passes 4–5 remain responsible for database-level unified text-token billing
V2, the rolling five-hour 50K window, the protected final 10K Fast product
reserve, database concurrency, quota-driven mode switching, quota/settings UI,
and production rollout. Pass 3 introduces no database locking or migration and
does not alter Standard/Lite V1 persistence semantics.
