# Contextual Awareness Phase 0 — Baseline Results

## Run identity

- Workflow: `Context Awareness Phase 0`
- Initial successful run: `30926893273`
- Evaluated head: `7c39c59947b5ac9e14c1cd19b9b86d4e52e4b212`
- Report schema: `1`
- Provider/model calls performed by the evaluator: `0`
- Target enforcement: disabled for baseline collection

## Baseline scorecard

| Metric | Baseline | Target | Status |
| --- | ---: | ---: | --- |
| Durable constraint retention | 75% | at least 95% | Below target |
| False unrelated-memory recall | 0% | at most 2% | Meets target |
| Persisted synthetic answer-page retrieval | 100% | at least 95% | Meets retrieval-layer target only |
| Average composed input | 2,620.67 estimated tokens | comparison baseline | Recorded |
| Deterministic composition p95 | 18.652 ms | comparison baseline | Recorded |
| Additional model calls | 0 | 0 | Meets target |

The answer-page score is not an end-to-end long-PDF score. It starts with a fully persisted synthetic document. The production PDF extraction path currently truncates canonical text before persistence, so later pages of a real long PDF may never reach this retrieval layer.

## Conversation continuity findings

### Ten-turn raw history

- Anchor retained.
- 20 recent messages selected.
- No messages dropped.
- Final composed input: 861 estimated tokens.

### Thirty-turn raw history

- Anchor retained.
- 60 recent messages selected.
- No messages dropped.
- Final composed input: 2,241 estimated tokens.

### One-hundred-turn raw history

- Anchor lost.
- 168 messages selected.
- 32 messages dropped.
- Final composed input: 5,986 of the 6,000-token test ceiling.

This proves that raw recent-history admission alone does not reliably preserve an early durable constraint once the thread exceeds the available budget.

### Capsule-assisted one-hundred-turn history

- Capsule anchor retained.
- Conversation capsule selected.
- 167 recent messages selected.
- 33 recent messages dropped.
- Final composed input: 5,972 estimated tokens.

The capsule successfully preserves the durable constraint when raw history no longer can. This validates capsules as the correct continuity mechanism, while also reinforcing the Fast-mode cold-cache risk identified in the roadmap.

## Current-message retention finding

The evaluator placed `MIDDLE-CONSTRAINT-NO-PROVIDER-CHANGES` between large head and tail sections of the current user message under a 420-token ceiling.

Result:

- the current message was trimmed;
- the middle constraint was lost;
- the protected prompt floor still fit safely;
- final composed input was 412 estimated tokens.

This confirms that character-level head–tail trimming can preserve syntax while losing a central user requirement. A later phase should structurally extract and protect the request, constraints, exclusions, and deliverables before trimming.

## Memory findings

- Unrelated memory selections for a photosynthesis query: `0`.
- Project memory selections for the synonym query “chat assistant rollout”: `1`.
- Conflicting preference memories selected for a preference query: `2`.

The current memory selector avoids the tested unrelated recall and handles the chatbot/chat-assistant synonym expansion. It does not resolve superseded or contradictory preferences; both conflicting memories remain eligible.

## Persisted long-document retrieval findings

A synthetic 120-page persisted document was queried at:

- page 1;
- page 60;
- page 120.

All three unique answer markers were retrieved through the lexical source-retrieval path. Each query selected six child excerpts after retrieval grouping.

The canonical source chunker also preserved a marker at the end of a long textual source, demonstrating that the chunker can retain late content when it actually receives the complete source.

## Confirmed static production gaps

### Critical — canonical PDF text truncation

`FileIngestionHandler.ts` truncates cleaned PDF text to 50,000 characters before source persistence. Content after that boundary cannot be retrieved because it is never indexed.

### High — page provenance is not supplied to chunking

`sourceRetrievalService.persistUploadedSource()` passes a combined extracted string to `chunkSourceText()` without page boundaries. The database has a `page_number` column, but this ingestion path cannot populate it accurately.

### High — semantic source retrieval is not wired in production

The production singleton is constructed as `new SourceRetrievalService()` without a semantic-search dependency. Persisted document retrieval therefore uses the lexical path unless another runtime wiring layer exists outside the inspected repository.

### Medium — upload size ceiling

The file upload path currently rejects files above 10 MB. This should not be raised until extraction and persistence become incremental and memory-bounded.

## Phase 0 conclusion

The baseline harness is functioning and the initial metrics are now reproducible. The first implementation decision is supported by evidence:

1. preserve complete PDF text and page boundaries before attempting retrieval improvements;
2. then protect structured current-message constraints and make capsule continuity durable in Fast mode;
3. keep the existing provider and model configuration unchanged.

Target enforcement should remain disabled until the corresponding implementation phases raise the measured retention metrics without increasing ordinary model-call count.
