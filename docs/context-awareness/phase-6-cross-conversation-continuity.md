# Phase 6 — Cross-conversation continuity

Phase 6 replaces recent-window prior-chat scanning with full-collection lexical continuity retrieval on data shards 2, 3, and 4.

## Retrieval sources

The query-time RPC searches:

- conversation titles;
- individual conversation capsules;
- user messages;
- bounded assistant decision and outcome excerpts;
- deterministic project and entity keys;
- active stable identity and preference memories;
- active unresolved-work memories.

The search does not generate an embedding and does not call an AI provider.

## Ordinary project continuation

Queries such as:

- `continue the SentIQ latency work`;
- `where were we with the PDF system`;
- `what is the next StudentOS recovery step`;

can select one to three relevant project capsules without requiring an explicit `do you remember?` phrase.

The former scan over at most 24 recent conversations and 200 user messages remains only as a degraded fallback for explicit recall when the new RPC is unavailable or returns no source evidence.

## Workspace structure

The previous single workspace capsule is replaced at query time by a structured selection:

1. a compact stable-user capsule derived from active stable identity and preference memories;
2. one to three relevant project capsules derived from stored conversation capsules;
3. unresolved-work records derived from active lifecycle-aware memories;
4. bounded source-message evidence when exact prior claims are needed.

The existing LLM-generated conversation-capsule refresh remains unchanged. Phase 6 changes storage metadata and retrieval only.

## Provenance contract

- **Memory** supports a saved fact and wording such as `I have this saved`.
- **Capsule** supports broad continuity and a high-level project state.
- **Source message** supports a claim that the user or assistant said something earlier.
- An exact past decision, recommendation, quotation, or date must not be claimed unless a returned source-message excerpt contains that evidence.

Assistant messages are eligible only when they contain deterministic decision or outcome cues, and returned excerpts are bounded.

## Fast mode

Fast remains a single read-only snapshot RPC.

The internal Phase 6 snapshot obtains structured continuity inside the existing database call. A compatibility adapter preserves the current application-facing snapshot schema version and projects the selected continuity through the workspace-capsule slot with explicit provenance labels. This prevents a database-first rollout from making the current runtime reject the snapshot.

## Continuity vector

PostgreSQL does not permit `array_to_string(text[], text)` inside a generated-column expression because the function is not marked immutable. Phase 6 therefore uses an ordinary `tsvector` column maintained by the same deterministic metadata trigger that derives project and entity keys. The post-migration backfills all existing capsules and updates the GIN index without any provider call.

## Data-shard migrations

Apply in order to Database 2, Database 3, and Database 4 only:

1. `20260805215950_prepare_continuity_search_vector.sql`
2. `20260805220000_add_cross_conversation_continuity.sql`
3. `20260805220050_maintain_continuity_search_vector.sql`
4. `20260805220100_upgrade_fast_cross_conversation_snapshot.sql`
5. `20260805220150_preserve_fast_snapshot_contract.sql`

Never apply these migrations to the control database.

The pre- and post-migrations are idempotent. If the main continuity migration previously stopped at `generation expression is not immutable`, apply the pre-migration and rerun the sequence from step 2; the already-created columns and functions are retained safely.

## Verification

`backend/verifyPhase3MigrationState.sql` is a read-only Phase 3 verifier. It checks functional SHA-256 subject generation, memory FTS, lifecycle metadata, trigger installation, and schema markers.

`backend/verifyPhase6MigrationState.sql` is a read-only Phase 6 verifier. It checks continuity columns, the trigger-maintained FTS vector, indexes, metadata trigger, RPCs, deterministic project/entity extraction, Fast internal continuity, compatibility adaptation, and schema markers.

The PostgreSQL integration suite additionally verifies:

- retrieval beyond the former 24-conversation boundary;
- bounded one-to-three project capsule selection;
- user-message evidence;
- bounded assistant decision excerpts;
- exclusion of ordinary assistant chatter;
- stable-user and unresolved-work selection;
- Fast single-RPC compatibility.

## Preserved constraints

- no additional model call;
- no additional embedding call;
- no provider or model-order change;
- no quota, token-budget, or billing change;
- no Azure scaling change;
- owner-scoped security-invoker retrieval;
- no automatic retrieval of historical file bodies.
