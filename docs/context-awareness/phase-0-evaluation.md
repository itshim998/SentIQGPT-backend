# Contextual Awareness Phase 0 — Evaluation Baseline

## Purpose

Phase 0 establishes a repeatable, zero-provider-cost baseline before changing SentIQ Chat's context-selection behaviour. It measures what the existing system retains, retrieves, drops, or cannot index while preserving the current provider order, models, plan budgets, and execution-mode policies.

This phase is observational. It does not change prompt composition, memory selection, source retrieval, provider routing, or PDF limits.

## Evaluation command

```bash
mkdir -p artifacts
SENTIQ_CONTEXT_EVAL_REPORT=artifacts/context-awareness-phase-0.json \
  npx ts-node --project tsconfig.backend.json backend/testContextAwarenessPhase0.ts
```

To convert the target metrics into blocking regression gates after the baseline is accepted:

```bash
SENTIQ_CONTEXT_EVAL_ENFORCE_TARGETS=1 \
SENTIQ_CONTEXT_EVAL_REPORT=artifacts/context-awareness-phase-0.json \
  npx ts-node --project tsconfig.backend.json backend/testContextAwarenessPhase0.ts
```

Target enforcement is deliberately disabled in the initial CI baseline. Structural safety assertions still fail immediately.

## What the evaluator measures

### Conversation continuity

- A durable constraint introduced 10, 30, and 100 turns earlier.
- The same long-thread constraint preserved through a conversation capsule.
- Retention of a constraint placed in the middle of a very long current user message.
- Protection of retrieved file evidence under token pressure.

### Memory relevance

- An unrelated memory must not be selected for an ordinary factual query.
- Chat-assistant and chatbot wording should resolve to the same project memory.
- Conflicting preference memories are counted to expose the lack of supersession semantics without failing the baseline.

### Long-document retrieval

- Beginning, middle, and final pages of a synthetic 120-page persisted document.
- Parent/child chunking of a long canonical textual source.
- Preservation of a marker located at the end of the canonical source.

### Static ingestion and retrieval risks

The report identifies, without changing them:

- canonical PDF text truncation at 50,000 characters;
- the 10 MB upload limit;
- missing page-aware chunk ingestion;
- the source-retrieval singleton being constructed without semantic retrieval.

## Privacy-safe report format

The generated JSON report contains:

- SHA-256 hashes of composed prompts, never prompt bodies;
- marker-presence checks;
- selected and dropped section counts;
- raw and final token estimates;
- deterministic composition timings;
- memory-selection counts;
- PDF-page retrieval outcomes;
- static code findings.

It does not persist user messages, memories, source text, model output, credentials, provider metadata, or embeddings.

## Initial target gates

| Metric | Target |
| --- | ---: |
| Durable constraint retention | at least 95% |
| False cross-context recall | at most 2% |
| Correct answer-page retrieval | at least 95% |
| Additional model calls | 0 |
| Provider/model configuration changes | 0 |

The deterministic composition timing in this phase is not a substitute for production time-to-first-token measurement. It provides a stable local comparison point for later context-selection changes. Fast-mode production latency must continue to be evaluated through the existing Fast latency instrumentation.

## Structural assertions that always block

- Context composition must not exceed the resolved input-context ceiling.
- The protected prompt floor must not fail.
- Unrelated memories must not enter the selected set.
- Beginning, middle, and final synthetic PDF pages must remain retrievable.
- The canonical source chunker must preserve content at the end of a long source.

## Interpretation

A failed target in baseline mode is a measured product gap, not a broken test. Later phases should improve the metric and then enable target enforcement once the repository demonstrates stable compliance.

A failed structural assertion represents a regression or an invalid evaluator and blocks the workflow immediately.
