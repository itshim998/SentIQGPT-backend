# Phase 3 — Hybrid memory retrieval and lifecycle

## Scope

Phase 3 improves durable-memory recall without adding embedding calls.

- PostgreSQL searches the full active memory collection lexically.
- Intuitive mode keeps its existing single query-embedding call, but compares it only against the compact PostgreSQL candidate set.
- Fast mode remains read-only, lexical-only, and single-RPC.
- Exact lexical, semantic, high-importance identity/project anchors, and active-chat memories are fused instead of choosing one retrieval family over another.
- Superseded memories are excluded at the database boundary.

The existing policy of storing only identity, preference, and project memories remains unchanged. Generic knowledge is still skipped.

## Shard migrations

Run on Database 2, 3, and 4 only, never on the control database:

```text
supabase/migrations/20260805150000_improve_memory_hybrid_retrieval.sql
supabase/migrations/20260805150025_infer_memory_project_scope.sql
supabase/migrations/20260805150050_guard_direct_memory_writes.sql
supabase/migrations/20260805150100_upgrade_fast_memory_snapshot.sql
```

The first migration adds lifecycle metadata, weighted FTS, full-collection lexical retrieval, deterministic conflict handling, and lifecycle-aware persistence. The second conservatively infers canonical named-project scope from existing summaries so the legacy automatic insertion path can supersede later states of the same project without another model call. The third guarantees that legacy or administrative direct writes receive required deterministic metadata. The fourth upgrades Fast mode's existing snapshot RPC to consume the same active-only lexical search without an additional database round trip.

## Candidate retrieval

`search_memories_lexical` searches every active memory belonging to the user and the current chat scope. It ranks candidates using:

- exact phrase matches;
- identity/project entity matches;
- weighted lexical rank;
- importance;
- global versus active-chat scope;
- confirmation recency;
- high-importance identity, preference, project-state, and commitment anchors.

The RPC intentionally admits high-importance anchors and active-chat memories even when they have no query-term hit. This allows the fusion stage to retain durable identity and current project state without letting those anchors crowd out exact results.

## Hybrid fusion

`backend/memory/hybridRetrieval.ts` performs reciprocal-rank fusion over five lists:

1. exact lexical matches;
2. broad lexical matches;
3. existing semantic matches in Intuitive mode;
4. high-importance identity/project anchors;
5. active-chat memories.

Exact matches receive the strongest weight and remain protected during diversity selection. Semantic results are unioned rather than replacing lexical results. Diversity limits repeated subjects and over-concentration in one fact type.

No function in the hybrid fusion or Supabase search layer generates an embedding. Intuitive mode still calls `semanticMemorySearch` once, using the same query embedding behavior as before, after PostgreSQL has reduced the candidate collection. Fast mode never calls semantic search. Memory-embedding backfill is not performed in either retrieval request path.

## Lifecycle and supersession

Each memory now carries deterministic metadata:

- `subject_key`;
- `source_conversation_id`;
- `source_message_id`;
- `created_at`;
- `last_confirmed_at`;
- `supersedes_memory_id`;
- `status` (`active` or `superseded`);
- `confidence`;
- `temporal_scope`;
- `project_scope`;
- `fact_type`.

Fact types are:

- `stable_identity`;
- `stable_preference`;
- `active_project_state`;
- `unresolved_commitment`;
- `temporary_condition`.

A repeated identical memory confirms the existing row by refreshing `last_confirmed_at`, increasing confidence when appropriate, and avoiding duplicate storage. A conflicting memory with the same deterministic subject key marks the old row `superseded` and links the new active row through `supersedes_memory_id`.

For example, an active `preference:response_length` memory stating that the user prefers detailed answers supersedes an older active memory stating that the user prefers concise answers. Named project summaries such as “Project Aster uses…” and “Project Aster now uses…” both deterministically resolve to `project:aster`, so the newer project state supersedes the older one even when the legacy caller does not explicitly provide `project_scope`.

## Verification

The Context Awareness workflow runs:

- TypeScript reciprocal-rank-fusion and wiring tests;
- PostgreSQL 16 migration replay for Phase 3;
- reconfirmation and preference-conflict supersession tests;
- deterministic named-project scope and project-state supersession tests;
- full-collection recall beyond the old recent-20 boundary;
- stable identity and active-chat anchor coverage;
- Fast snapshot active-only retrieval;
- direct-write metadata normalization;
- all earlier context-awareness regressions.

`backend/verifyPhase5MigrationState.sql` is a separate read-only verifier for Phase 5. It checks actual installed objects and runtime behavior, not only migration-history rows, so it is suitable after manual Supabase SQL-editor deployment. It validates the generated FTS column, GIN index, search RPC execution, transition-only trigger, bounded diagnostics, sentence helpers, and retrieval-mode smoke behavior.

Passing CI proves that the complete migration sequences install and operate correctly on PostgreSQL 16. It does not by itself prove that a particular live Supabase shard has been updated; run the read-only verifier against each live data shard to confirm that shard's installed state.
