# Contextual Awareness Phase 1 — Query-Aware Allocation

## Purpose

Phase 1 replaces the single fixed optional-context order with deterministic policies selected from the current request and available context. The implementation remains provider-neutral and adds no model calls.

The current user message remains last in the prompt. System instructions, context-handling rules, required route evidence, and required recall evidence retain their protected status.

## Deterministic policies

| Policy | Detection | Admission priority after protected system/current-message requirements |
| --- | --- | --- |
| Direct continuation | Short or continuation-style request with recent chat | Protected recent exchange → conversation capsule → older recent turns → workspace/summary context → memories and optional evidence |
| Personal recall | Explicit memory, prior-chat, decision, or preference request | Protected recent exchange → exact/relevant memories → prior recall evidence → workspace and conversation capsules |
| File question | One or more attached sources without summary/comparison intent | Protected recent exchange → relevant file excerpts → conversation capsule → relevant memories → optional evidence |
| Whole-document summary | File request using full-document or section-summary language | Protected recent exchange → document map → section-diverse excerpts → conversation capsule and optional context |
| Multi-file comparison | Multiple files plus comparison/contrast language | Protected recent exchange → round-robin per-document evidence → conversation capsule → optional context |
| Tool result | Required route/tool evidence or route evidence without files | Required tool evidence → protected recent exchange → optional tool/recall evidence → optional personal context |
| General | No stronger deterministic signal | Protected recent exchange → relevant source/evidence/memory context → capsules and older turns |

Required evidence is assembled before optional-policy admission and can be reduced only to its protected minimum representation. It is never silently removed.

## Adaptive recent-turn candidates

The compressor now submits up to the latest 20 messages rather than six. Conversations longer than the candidate window still use the existing older-history compression path.

The composer identifies and reserves compact representations of:

- the latest assistant response;
- the user message immediately preceding it;
- the message immediately before that exchange when available.

These protected recent messages are admitted before optional context. Older candidate turns are then selected within the remaining token budget.

## Structured current-message retention

When the full current message does not fit, the composer extracts deterministic sections before reducing it:

- primary request;
- constraints;
- required deliverables;
- exclusions;
- quoted or source material;
- ending context.

Request constraints and deliverables are allocated independently, preventing an explicit middle-list requirement from being lost solely because head-tail trimming retained only the beginning and end.

The Phase 1 regression places these requirements between large head and tail regions and verifies both survive:

- `CONSTRAINT: DO NOT CHANGE ANY AI MODEL PROVIDER SETTINGS.`
- `REQUIRED DELIVERABLE: return a complete implementation and regression tests.`

The original Phase 0 synthetic marker embedded inside one uninterrupted artificial token stream remains an observational non-blocking case; it does not represent a normally delimited instruction or list item. Target enforcement therefore remains disabled in Phase 1.

## Elastic context blocks

Optional blocks are no longer only admitted whole or dropped. When a block partially fits, the composer reduces it to the available allocation and inserts an internal truncation marker.

Elastic reduction applies to:

- retrieved file excerpts;
- optional route and recall evidence;
- memories;
- workspace and conversation capsules;
- rolling summaries;
- older recent turns.

A minimum useful content threshold prevents empty labels or unusably small fragments from being admitted.

## Cross-section deduplication

The composer creates normalized sentence fingerprints and removes repeated facts from dedupe-eligible sections after the first selected occurrence.

Deduplication covers:

- memories;
- workspace capsules;
- conversation capsules;
- rolling summaries and stable context;
- non-protected recent messages.

Required evidence and protected recent turns are not deduplicated away. Telemetry records the number of removed segments.

## Diversity-aware selection

Memories, optional evidence, and file candidates use deterministic lexical maximal marginal relevance. Candidate scoring balances relevance against similarity to already ordered candidates.

Multi-file comparison additionally uses:

- a per-document candidate limit;
- bounded comparison excerpts;
- round-robin document admission.

This prevents the first document or a cluster of near-identical passages from consuming the comparison budget before other documents contribute evidence.

Whole-document summaries add a deterministic document map and force beginning, ending, and regularly spaced section candidates into the selection pool before relevance ordering.

## Telemetry

Context-composition telemetry now includes:

- `queryPolicy`;
- `elasticBlocksReduced`;
- `deduplicatedSegments`;
- `diversitySkipped`;
- `protectedRecentTurnsSelected`;
- selected and dropped counts for document maps, evidence, files, memories, capsules, summaries, and recent turns.

Prompt bodies are not added to telemetry.

## Measured result

The successful Phase 1 CI run produced this Phase 0 comparison report:

| Metric | Phase 0 baseline | Phase 1 result |
| --- | ---: | ---: |
| Durable constraint retention | 75% | 100% |
| Unrelated-memory false recall | 0% | 0% |
| Persisted synthetic PDF-page retrieval | 100% | 100% |
| Average composed input | 2,620.67 estimated tokens | 1,967.33 estimated tokens |
| Average deterministic composition time | 18.652 ms | 7.260 ms |
| Additional model calls | 0 | 0 |

The 100-turn raw-history anchor now survives. The result is achieved through a larger candidate set plus deterministic deduplication and allocation, not a larger model context or provider change.

The PDF score remains retrieval-layer-only. Phase 1 does not address the separate production ingestion findings from Phase 0: canonical 50,000-character truncation, missing page provenance, the 10 MB upload limit, and unwired semantic source retrieval.

## Validation

The contextual-awareness workflow executes:

1. TypeScript backend build;
2. canonical context-budget regressions;
3. protected-context safety regressions;
4. Phase 0 evaluator;
5. Phase 1 query-policy regressions;
6. privacy-safe evaluation report upload.

Phase 1 regressions cover every policy, the 20-message candidate window, protected recent exchanges, explicit middle constraints, elastic source reduction, deduplication, whole-document diversity, multi-file quotas, required tool evidence, and lexical MMR.

## Configuration impact

Phase 1 changes none of the following:

- provider order;
- provider keys or endpoints;
- model selection;
- generation-token ceilings;
- reasoning budgets;
- plan quotas;
- Azure scaling or `minReplicas`;
- ordinary request model-call count.
