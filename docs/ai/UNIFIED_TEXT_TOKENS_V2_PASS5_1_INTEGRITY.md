# Unified Text Tokens V2 — Pass 5.1 Integrity

## Purpose

Pass 5.1 closes two integrity gaps discovered after the Passes 4–5 audit:

1. A V2-to-V1 rollback could exhaust Standard while leaving the full Lite allowance available.
2. Reliable provider usage could be lost if a database reservation expired and was reclaimed before settlement.

The work remains behind `SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED`, which is still `false` by default. No frontend behaviour, provider routing, paid-plan policy, or production activation is changed.

## Rollback continuity

### Previous behaviour

Each V2 commit wrote one `premium_text` rollback shadow containing the actual V2 usage. Under V1, text routing tries Standard first and then Lite. Once Standard was exhausted, Lite could still expose its untouched allowance.

### Final behaviour

Each committed V2 identity now has:

- one identity-scoped Standard gate equal to the Free Standard limit;
- one Lite usage shadow per canonical V2 usage event containing the actual settled V2 tokens.

The Standard gate is refreshed to the latest canonical V2 event time. It uses a deterministic request ID derived from a one-way identity fingerprint; raw user IDs and guest hashes are not returned or logged.

The Lite shadow uses a deterministic reservation-scoped request ID. Repeated settlement remains idempotent.

With Standard gated, V1 rollback capacity comes only from Lite:

```text
rollback Lite remaining = 50,000 - recent V2 usage
```

This prevents Standard-to-Lite fallback from creating a second allowance.

Both shadow classes carry:

```text
unified_text_v2_rollback_shadow = true
```

V2 snapshots exclude them, so flag reactivation does not double count canonical usage. While V2 is active, backend usage summaries subtract both shadow classes from the legacy Standard/Lite cards and expose the canonical unified allowance separately.

## Backward repair

The integrity migration removes the original single-shadow row when a committed reservation is re-synchronised, then creates the Standard gate and Lite usage shadow.

An additive backfill runs for any V2 reservations already committed before the migration. The operation is idempotent.

## Late reliable settlement

### Previous behaviour

After a reservation TTL elapsed, a summary or later reservation could mark the row `expired`. The commit RPC then rejected settlement even when the provider had returned reliable token usage.

### Final behaviour

The commit RPC allows settlement when the reservation is:

- still `reserved` but its TTL elapsed; or
- already marked `expired` by reclamation.

The original identity, mode, plan, policy, request ID, and reserved-token amount remain immutable. Explicitly released reservations remain terminal and non-committable.

Late settlement records:

- `late_settlement`;
- `pre_settlement_remaining_tokens`;
- `late_capacity_overrun_tokens`;
- `usage_overrun_tokens`;
- `fast_reserve_breach_tokens`.

If reclaimed capacity has already been consumed, full observed usage is still recorded. Public remaining capacity is floored at zero. The debt is explicit rather than silently dropping provider usage.

For late Intuitive settlement, reserve breach is calculated against the current protected 10,000-token Fast reserve.

Repeated late commits return the existing usage event and remain idempotent.

## Concurrency and lock order

The existing identity-scoped PostgreSQL advisory lock remains authoritative. Settlement obtains the identity lock before the row lock, matching reserve and release ordering.

Late settlement is serialised against new reservations and summaries for the same identity. Separate identities do not share a lock.

## Security

The integrity helper and settlement RPCs are `security definer` functions with a fixed `public, pg_temp` search path.

Direct access remains revoked from `public`, `anon`, and `authenticated`. Only the existing service-role settlement and summary entry points are executable by `service_role`.

No prompts, responses, hidden reasoning, provider diagnostics, raw identity values, or guest hashes are written to public payloads or lifecycle logs.

## Migrations

- `20260727180000_unified_text_tokens_v2_integrity.sql`
  - adds rollback-shadow synchronisation;
  - redefines commit for late reliable settlement;
  - extends the V2 summary with Standard and Lite shadow totals;
  - backfills already committed V2 rows.
- `20260727183000_unified_text_tokens_v2_schema_compat.sql`
  - preserves the established startup schema-version contract during the reversible rollout.

Both migrations are additive. The V1 migration and original V2 migration are unchanged.

## Test coverage

The disposable PostgreSQL Pass 5.1 suite verifies:

- 50,000 V2 tokens block both V1 Standard and Lite;
- partial V2 usage leaves only the correct conservative Lite capacity;
- repeated settlement does not duplicate shadows;
- multiple V2 commits retain one Standard gate and one Lite shadow per canonical event;
- V2 summaries exclude rollback shadows;
- expired Intuitive usage settles and records a Fast-reserve breach;
- reclaimed-capacity debt is recorded instead of discarded;
- repeated late settlement is idempotent;
- explicitly released reservations remain non-committable;
- integrity migrations can be applied repeatedly to a disposable database.

The usage-summary service test verifies that both Standard and Lite rollback shadows are hidden while V2 is active.

## Deferred work

Still deferred:

- frontend quota card and countdown;
- automatic visible Intuitive-to-Fast mode switching;
- composer blocking at zero allowance;
- production migration and flag activation;
- paid-plan unified-token policy;
- guest-to-account usage merging.
