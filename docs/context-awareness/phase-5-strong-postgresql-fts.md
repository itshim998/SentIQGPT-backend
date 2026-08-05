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
```

The first file safely defers legacy map backfill, the second installs weighted FTS and retrieval modes, and the third installs guarded map generation and performs an independently fault-tolerant backfill. Until all three are applied, the existing lexical RPC remains active or Phase 5 is only partially installed.

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

When a `source_documents` row changes to `ready`, a database trigger builds a compact map and stores it in `metadata.document_map`.

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

Legacy metadata numbers are guarded before integer conversion. Existing ready documents are backfilled one at a time; a malformed document is marked failed without rolling back maps already created for other documents.

For non-pinpoint modes, the first retrieved parent includes the compact map before query-relevant excerpts. The complete document is never placed directly into the model prompt.

## Safety and cost constraints

- No embeddings are generated.
- No external AI call is made.
- No model order, key pool, quota, token allowance or Azure scale setting changes.
- Row-level owner scoping and the existing RPC signature remain intact.
- Helper functions and the search RPC are not executable by `public` or `anon`.

## Validation

`backend/testStrongSourceRetrieval.ts` verifies:

- weighted FTS and GIN indexing;
- field-aware boosts;
- deterministic expansion contracts;
- neighbour expansion;
- per-parent, per-page and per-document quotas;
- all six retrieval modes;
- timeline ordering and coverage disclosure;
- ingestion-time map fields and trigger;
- guarded, failure-isolated map backfill;
- backward-compatible RPC wiring;
- absence of embeddings and AI-specific retrieval logic.
