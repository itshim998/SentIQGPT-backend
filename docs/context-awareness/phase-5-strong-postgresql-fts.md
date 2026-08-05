# Phase 5 — Strong long-document retrieval with PostgreSQL FTS

## Objective

Strengthen production retrieval for persisted PDFs and other long documents without adding paid embeddings, OCR services, or any additional model call.

The production `SourceRetrievalService` still has no semantic-search dependency. Phase 5 therefore upgrades the PostgreSQL lexical path that the singleton already calls.

## Deployment architecture

Phase 5 replaces `public.search_source_chunks(uuid, uuid[], text, integer)` in place. No backend endpoint or AI configuration changes are required. Existing application code continues calling the same RPC.

Apply these migrations in filename order to data shards 2, 3, and 4 only:

```text
supabase/migrations/20260805095900_defer_phase5_document_map_backfill.sql
supabase/migrations/20260805100000_strengthen_source_fts_retrieval.sql
supabase/migrations/20260805100100_harden_phase5_document_maps.sql
supabase/migrations/20260805100200_fix_phase5_ready_trigger.sql
supabase/migrations/20260805100300_fix_phase5_map_ambiguity.sql
supabase/migrations/20260805100400_fix_phase5_search_rpc_ambiguity.sql
```

The first file safely defers legacy map backfill. The second installs weighted FTS and retrieval modes. The third installs guarded map generation and performs an independently fault-tolerant backfill. The fourth replaces the ready-state row trigger with a PostgreSQL-safe statement trigger so map metadata is persisted only after the original status update completes. The fifth fully qualifies every map-builder CTE reference, removes SQLSTATE `42702` ambiguity in document-map generation, and safely retries failed ready-document maps. The sixth fully qualifies every CTE reference inside the `RETURNS TABLE` search RPC and replaces `USING` joins with explicit qualified `ON` clauses, removing the remaining SQLSTATE `42702` execution blocker. Until all six are applied, Phase 5 is only partially installed.

## Weighted field-aware FTS

`source_chunks.fts_weighted` is a generated `tsvector` with:

- heading: weight A;
- path and context prefix: weight B;
- content: weight D.

A GIN index supports the weighted vector. Ranking combines:

- the original `websearch_to_tsquery` result;
- deterministic expanded terms;
- document-title rank;
- exact quoted-phrase boosts;
- number, date, percentage, acronym and identifier boosts.

## Deterministic query expansion

Expansion is bounded and no-model-cost. It normalizes:

- singular and plural variants;
- hyphenated, spaced and joined forms;
- percentage forms such as `10%`, `10 percent` and `0.10` in both directions;
- acronyms and expansions discovered in the document map.

The original query carries the dominant rank. Expanded terms improve recall but cannot replace the original ranking signal.

## Neighbour expansion

Each selected anchor can bring in its immediately preceding and following child chunks within the same parent. The parent excerpt remains available through the existing RPC response.

Neighbours receive a lower score than anchors so they add local interpretation without crowding out independently relevant sections.

## Retrieval modes

The RPC infers one deterministic mode from the query:

- `pinpoint`: strongest excerpts, bounded per parent and page, plus neighbours;
- `section`: heading/path matches are preferred, with lexical fallback only when no section label matches;
- `summary`: representative anchors spread across page/section buckets;
- `comparison`: independent quota per document before neighbour expansion;
- `timeline`: date-bearing chunks returned in chronological order;
- `exhaustive`: representative bounded extraction with an explicit coverage warning.

Summary and exhaustive modes explicitly state that the model did not inspect every page simultaneously.

## Deterministic ingestion-time document map

When a `source_documents` update marks one or more rows `ready`, an after-statement trigger builds compact maps and stores them in `metadata.document_map`. Using a transition-table statement trigger prevents same-row self-modification errors while supporting multi-document updates.

The map contains:

- detected table-of-contents status and entries;
- heading hierarchy;
- section page ranges;
- total page and parent-chunk counts;
- repeated key terms;
- repeated capitalized entities;
- acronym/expansion pairs found in the document;
- table and appendix page indicators;
- representative first and last sentences for each mapped section.

Legacy metadata numbers are guarded before integer conversion. Existing ready documents are backfilled one at a time; a malformed document is marked failed without rolling back maps already created for other documents. All CTE and aggregate references in the final builder are explicitly qualified to avoid PL/pgSQL or SQL namespace ambiguity.

For non-pinpoint modes, the first retrieved parent includes the compact map before query-relevant excerpts. The complete document is never placed directly into the model prompt.

## Search-RPC namespace safety

Because `search_source_chunks` is a PL/pgSQL `RETURNS TABLE` function, names such as `document_id`, `parent_chunk_id`, `chunk_index`, `heading`, and `content` also exist as output variables. PostgreSQL can treat an unqualified CTE reference to any of those names as ambiguous.

The final replacement RPC therefore:

- assigns explicit aliases to base-table fields;
- qualifies every CTE field used in filters, windows, grouping, ordering and projections;
- uses explicit `ON` predicates instead of `USING (document_id)`;
- qualifies final output and ordering fields.

This correction changes no ranking weights, retrieval quotas, RPC parameters, result columns or application wiring.

## Safety and cost constraints

- No embeddings are generated.
- No external AI call is made.
- No model order, key pool, quota, token allowance or Azure scale setting changes.
- Row-level owner scoping and the existing RPC signature remain intact.
- Helper functions and the search RPC are not executable by `public` or `anon`.

## Validation

`backend/testStrongSourceRetrieval.ts` verifies the static migration, namespace-safety and production-wiring contracts.

The Context Awareness workflow constructs the final PostgreSQL fixture from `backend/testStrongSourceRetrievalV3.sql`, inserts the sixth corrective migration immediately after the fifth, and installs the complete sequence on PostgreSQL 16 before any source data is seeded. It then verifies:

- ready-state document-map generation for multiple documents;
- guarded malformed metadata;
- weighted FTS and percentage normalization;
- preceding and following neighbour expansion;
- heading-filtered section retrieval;
- summary section diversity, document-map injection and coverage disclosure;
- independent comparison coverage per document;
- chronological timeline ordering;
- exhaustive-extraction coverage disclosure.
