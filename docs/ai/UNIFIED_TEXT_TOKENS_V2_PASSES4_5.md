# Unified Free text tokens V2 — Passes 4–5

## 1. Before and after

Before this pass, text billing used the `standard-lite-tokens-v1` policy in the
shared `usage_events` and `quota_reservations` tables. Standard and Lite had
independent rolling limits, and ordinary text routing could downgrade from
Standard to Lite when the Standard reservation failed.

This pass adds a strictly separate Free-plan ledger:

- `unified_text_reservations_v2`
- `unified_text_usage_events_v2`
- `reserve_unified_text_tokens_v2`
- `commit_unified_text_tokens_v2`
- `release_unified_text_tokens_v2`
- `get_unified_text_usage_summary_v2`

The backend selects that ledger only when the resolved plan is `free` and
`SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=true`. It creates one database
reservation for the complete turn and attaches the reserved amount as the hard
ceiling of the existing request-local model-call ledger.

## 2. Free-only boundary

The V2 condition is:

```text
unified token flag enabled AND effective plan is Free
```

Free Fast and Free Intuitive use the same V2 balance. Essential
(`student_core`), Plus (`premium`), and Pro continue to use V1 even when the V2
flag is enabled. If the effective plan changes from Free to paid between
request-context resolution and transactional reservation, the V2 RPC rejects
the ineligible plan and the backend resumes the paid V1 path.

The quota-UI flag is not read by backend accounting. The billing flag does not
select providers or alter paid-plan routing.

## 3. Paid-plan V1 preservation

`TEXT_TOKEN_PLAN_POLICY` and `TEXT_TOKEN_POLICY_VERSION` remain authoritative
for all V1 plans. V1 reservation, partial settlement, Standard-to-Lite
downgrade, summaries, prices, limits, windows, and model-capability fallback
remain available. No paid unified allowance was introduced.

When the V2 flag is false, every plan, including Free, follows the exact V1
path. When the flag is true, paid Fast and paid Intuitive still follow V1.

## 4. Canonical product constants

Node/TypeScript owns product policy in `backend/billing/planCatalog.ts`:

```text
policy version                         unified-text-tokens-v2
Free total text limit                 50,000 tokens
rolling window                        18,000 seconds
protected Fast reserve                10,000 tokens
Fast desired reservation              12,000 tokens
Intuitive desired reservation         16,000 tokens
Fast minimum                          256 tokens
Intuitive ordinary minimum            1,500 tokens
Intuitive complex minimum             2,000 tokens
```

The SQL RPCs repeat only the transactional enforcement constants: policy
version, 50,000-token limit, 18,000-second window, and 10,000-token Fast
reserve. The duplicate-constant audit is covered by
`testUnifiedTextMigrationContract.ts`; changes to those values must update the
TypeScript policy, SQL enforcement, contract tests, and this document together.
Desired and minimum request sizes remain backend-owned inputs to the RPC.

## 5. True rolling-window calculation

V2 does not create buckets. Each snapshot sums:

- canonical V2 committed events whose `created_at` is within the preceding
  18,000 seconds;
- recent committed Free V1 `premium_text` and `lite_text` token events needed
  for transition continuity;
- active, unexpired canonical V2 reservations;
- active, unexpired Free V1 text reservations during transition.

Compatibility-shadow rows are explicitly excluded from V2 calculations.
Expired V2 reservations are marked `expired` and reclaimed while taking an
identity lock during reservation and summary calls. Expired V1 reservations
are disregarded by their expiry timestamp.

```text
remaining = max(0, 50,000 - committed - active reserved)
Fast available = remaining
Intuitive available = max(0, remaining - 10,000)
```

Canonical and rollback-shadow usage events receive their `created_at` value at
settlement, so time spent waiting on a provider does not shorten the charge's
five-hour rolling lifetime.

## 6. Dynamic recovery timestamps

`next_recovery_at` is the earliest of each counted committed event's
`created_at + 18,000 seconds` and each active reservation's exact expiry.
`full_reset_at` is the latest age-out time among currently counted committed
events and excludes active reservations. Both are null for a fresh identity.
The backend uses `next_recovery_at` as the compatibility `reset_at` alias in
quota errors.

## 7. Fast reserve semantics

Fast may reserve from the complete remaining balance. Intuitive may reserve
only from balance above the final 10,000 tokens.

At exactly 10,000 remaining, Intuitive receives
`intuitive_fast_required`; Fast may still reserve. At 10,001 remaining,
Intuitive headroom is one token, so the supplied 1,500- or 2,000-token minimum
cannot fit and the result is `unified_text_insufficient_for_request`, not total
exhaustion. The backend never silently changes execution mode.

## 8. Reservation transaction

`reserve_unified_text_tokens_v2` validates identity XOR, request ID, execution
mode, positive requested/minimum units, and effective Free-plan eligibility.
It then acquires an identity-and-policy advisory transaction lock and a
request-ID advisory lock, reclaims stale reservations, checks duplicate IDs,
calculates the rolling snapshot, and inserts a bounded reservation. TTL
defaults to 600 seconds and is clamped to 60–1,800 seconds.

Duplicate IDs are idempotent for the same identity, policy, and mode.
Cross-identity, cross-mode, and cross-policy collisions fail without returning
another identity's reservation. The backend blocks duplicate in-progress or
already-committed application requests before provider invocation.

Partial reservation is allowed when the result reaches the supplied minimum.
The transaction never inserts zero or negative units.

## 9. Commit transaction

`commit_unified_text_tokens_v2` reads the immutable reservation identity,
acquires the same identity-and-policy advisory lock, and then locks and re-reads
the reservation row. It rejects released/expired reservations, returns the
existing event on repeat, records full observed actual usage, marks the
reservation committed, releases unused capacity, and creates one idempotent V1
rollback-continuity shadow.

The request-local ledger must have no pending calls before settlement. Its
aggregate includes supporting calls, selection, synthesis, repair,
continuation, input, visible output, and provider-reported output that already
includes hidden reasoning.

## 10. Release transaction

`release_unified_text_tokens_v2` uses the same identity-lock-then-row-lock
ordering. Active reservations become `released`; already released and missing
reservations return explicit idempotent results; committed reservations are
never released.

Cancellation, context failure, and pre-provider failure release capacity. If a
model call already returned reliable usage before abnormal termination, the
backend commits that observed usage instead of discarding it.

## 11. Database concurrency model

Capacity serialization is enforced in PostgreSQL. Requests for the same
identity and policy use one advisory transaction lock; duplicate request IDs
also use a request-specific lock. Different identities use different locks.
Commit and release serialize through a row lock and the identity lock.

The isolated PostgreSQL suite covers Fast/Fast, Intuitive/Intuitive,
Fast/Intuitive, duplicate reserve, cross-identity collision, commit/release,
expiry reclamation, and identity isolation. Except for an explicitly recorded
provider overrun, committed plus active reserved capacity cannot
transactionally oversubscribe the policy.

## 12. Request-local accounting integration

`requestBudgetContext.ts` now uses the neutral allowance class
`standard | lite | unified_text`; it no longer requires every token ledger to
pretend to be a Standard or Lite feature. V1 compatibility fields remain.

For Free V2, the database amount is the hard request ceiling; every model call
shares one ledger; pending-call reservations prevent parallel overspend;
future synthesis obligations remain protected; reported usage is preferred;
hidden reasoning remains counted and private; and the ledger closes after
commit or release.

Provider failure within a mode does not create another allowance, and
Intuitive failure does not become Fast.

## 13. Structured public errors

Free V2 errors do not expose internal feature, provider, or model names:

```text
intuitive_fast_required
  HTTP 429, type mode_switch_required, required_mode fast

unified_text_quota_exhausted
  HTTP 429, type quota_exceeded, required_mode null

unified_text_insufficient_for_request
  HTTP 429, type insufficient_allowance

unified_text_quota_unavailable
  HTTP 503, type service_unavailable
```

Available fields include plan/policy, total/used/reserved/remaining tokens,
Fast reserve, mode availability, `next_recovery_at`, and `reset_at`.
Unavailable values are omitted. A missing V2 migration or RPC fails closed for
Free V2 and does not fall back to V1 or another execution mode.

REST responses expose the classification in `type`. Existing SSE consumers
retain the transport envelope `type: "error"` and receive the same
classification additively as `quota_type`.

## 14. Public usage-summary contract

V1 response fields are preserved. Eligible Free V2 summaries add:

```json
{
  "text_allowance": {
    "policy_version": "unified-text-tokens-v2",
    "plan_code": "free",
    "limit_tokens": 50000,
    "window_seconds": 18000,
    "used_tokens": 0,
    "reserved_tokens": 0,
    "remaining_tokens": 50000,
    "fast_reserve_tokens": 10000,
    "fast_available_tokens": 50000,
    "intuitive_available_tokens": 40000,
    "intuitive_allowed": true,
    "required_mode": null,
    "exhausted": false,
    "next_recovery_at": null,
    "full_reset_at": null
  }
}
```

Paid and flag-disabled summaries do not fabricate this object.

## 15. V1 to V2 transition

Free users do not receive a fresh balance at activation. V2 dynamically counts
recent successful V1 token events across `premium_text` and `lite_text`,
restricted to Free `standard-lite-tokens-v1` rows. Active V1 reservations are
also counted until commit, release, or expiry.

Committed and active V1 rows are read in one PostgreSQL snapshot, so a settling
reservation is counted as active before settlement or committed afterward,
not both. Message-count history is not converted.

## 16. V2 to V1 rollback continuity

Each V2 commit writes one idempotent `premium_text` compatibility shadow with
the V1 policy version and source request/reservation traceability. V1 therefore
conservatively accounts for V2 usage when the flag is disabled.

V2 queries exclude `unified_text_v2_rollback_shadow` rows, preventing double
counting. While V2 is active, the backend also subtracts the internal shadow
aggregate from the preserved V1 Standard summary fields so public usage does
not display the same V2 charge twice. No V2 data is deleted or converted
during rollback.

## 17. Signed-in and guest identities

Signed-in reservations use the authenticated UUID. Guest reservations use only
the existing server-derived anonymous hash. Constraints require exactly one
identity, and reservations stay attached to their original identity.

The anonymous hash is never returned or logged. Guest usage is not merged into
a later signed-in account in this pass.

## 18. Overrun and reserve-breach policy

Reliable provider reporting may rarely exceed a reservation. V2 records the
complete observed amount and explicit `usage_overrun_tokens`; public remaining
is always floored at zero.

An Intuitive overrun beyond its reservation also records
`fast_reserve_breach_tokens`. Future Intuitive reservations remain blocked by
the full committed event. Safe aggregate diagnostics are emitted; usage is
never hidden by lowering settlement.

## 19. Security and observability

V2 tables have RLS enabled and no public, anonymous, or authenticated table
access. RPCs are `security definer` with fixed
`search_path = public, pg_temp`; execution is granted only to `service_role`.
The advisory lock stores only a hash-derived integer key.

Lifecycle logs contain policy, plan, execution mode, aggregate counts, safe
reason codes, and idempotency. They exclude user IDs, anonymous hashes, emails,
request IDs, prompts, responses, evidence, credentials, provider diagnostics,
models, and hidden reasoning.

## 20. Tests and environments

Deterministic commands:

- `billing:test-unified-text-v2`
- `test:unified-text-routing`
- `billing:test-unified-text-v2-sql`
- existing V1, provider, context, request-lifecycle, protected-context,
  capability, tool, pipeline, migration, and frontend suites.

The SQL command always runs the migration contract audit. Its PostgreSQL
portion requires an explicitly disposable URL and
`SENTIQ_BILLING_TEST_DATABASE_ALLOW_DESTRUCTIVE=true`; it refuses non-local
hosts and database names without `test`. Local execution skips safely without
that signal. The focused PR workflow supplies an isolated PostgreSQL 16
service and runs the real reservation/concurrency cases.

No test reads a production database or assumes `.env` is disposable.

## 21. Limitations and deferred frontend Pass 6

Guest usage is not merged after sign-in. Recovery timestamps describe current
events and reservations; future usage changes them. A mixed-version deployment
must enable the flag only after the migration and backend are present.

No frontend quota cards, banners, countdowns, settings changes, or automatic
mode switching are included. Those remain Pass 6 work.

## 22. Rollout and rollback

Rollout:

1. Apply `20260727120000_unified_text_tokens_v2.sql` to the control database.
2. Deploy the backend with all four rollout flags still false.
3. Run migration verification and the isolated SQL suite.
4. Enable `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED` for the intended rollout.
5. Manage provider/lane flags independently through their existing procedure.

Rollback:

1. Set `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=false`.
2. Leave V2 tables and functions intact.
3. V1 resumes and counts V2 compatibility shadows.
4. Investigate with aggregate diagnostics; do not delete or rewrite ledgers.

Tracked defaults remain:

```text
SENTIQ_NVIDIA_PROVIDER_ENABLED=false
SENTIQ_NEMOTRON_INTUITIVE_ENABLED=false
SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED=false
SENTIQ_INTUITIVE_QUOTA_UI_ENABLED=false
```
