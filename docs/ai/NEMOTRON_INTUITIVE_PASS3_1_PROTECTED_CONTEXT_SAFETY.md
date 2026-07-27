# Nemotron Intuitive Pass 3.1: Protected Context Safety

## 1. Discovered risk

Pass 3 separated input and generation budgets, but its final emergency fitting
path made the system prompt mutable. If all other reductions were insufficient,
the composer passed the system text through `trimTextToTokenBudget`. A second
whole-prompt character guard could also shorten a completed prompt without
respecting section boundaries.

That behavior could remove or split policy instructions to make an otherwise
impossible request fit. Pass 3.1 removes both paths. The application-owned
system prompt is now preserved byte-for-byte, and the stable context-handling
rules are a separate immutable block immediately after it.

## 2. Protected-context hierarchy

Retention priority is:

1. complete system and policy instructions;
2. complete stable context-handling rules;
3. the minimum safe current user message;
4. the minimum safe required route or tool evidence;
5. the minimum safe required source or recall evidence;
6. relevant file chunks;
7. optional route or recall evidence;
8. relevant memories and stable user context;
9. workspace/conversation capsules and summaries;
10. older conversation turns.

The current user message remains the final labelled section in the assembled
prompt. Its placement does not lower its retention priority.

## 3. Immutable and reducible context

The system prompt and `STABLE_CONTEXT_HANDLING_RULES` are immutable. The
composer never trims, summarizes, reorders, or merges untrusted data into
either block. It validates the final prompt prefix against the original system
bytes and the complete stable rules.

The current user message is reducible only to the existing 64-token
head/tail minimum. Required evidence is reducible to a labelled 64-token
head/tail representation. Files, optional evidence, memories, capsules,
summaries, and older turns are optional and are admitted only when the
protected context already fits.

If a required evidence block or the current message must be reduced for the
ceiling, no lower-priority optional content is subsequently admitted into
space created by that reduction.

## 4. Required evidence bounding

Required route/tool and source/recall evidence:

- keeps a separate required label;
- is ordered deterministically by relevance and original order;
- retains head and tail content where truncation is needed;
- includes the marker `full source not retained`;
- is initially capped per item and can be reduced to its minimum safe
  representation only after optional content has been exhausted;
- is never merged with system instructions.

When pressure remains, lower-relevance source/recall evidence is reduced before
higher-priority route/tool evidence. Every required item keeps its minimum
representation. If all minimum representations cannot fit, composition fails;
the composer does not silently delete an item.

Evidence normalization strips control/binary data, data-URI and long base64
payloads, credential-like fields, hidden reasoning, provider/model diagnostics,
raw request/response payload fields, tool transport payloads, and embeddings.
JSON evidence is recursively reduced to safe fields. The Intuitive tool
synthesis builder continues to use explicit per-tool allowlists before evidence
reaches the composer.

## 5. Failure before provider invocation

The composer estimates these floors before optional context:

1. system plus stable rules;
2. system, stable rules, and the minimum current message;
3. all immutable blocks plus every minimum required evidence representation.

An over-limit floor, a system prompt over the application hard character
maximum, a failed final immutability assertion, or a final input estimate over
the selected ceiling throws `context_budget_insufficient`. The error contains
only safe telemetry and a generic message. No system, user, evidence, provider,
or model content is attached.

Prompt composition remains before `prepareBudgetedCall`, so a failed protected
floor cannot create a model-call reservation or invoke a provider.

## 6. Request-reservation cleanup

`handleChat` now releases a named future obligation when final prompt
composition fails before the obligation can be consumed. The release operation
is idempotent.

The adapter readiness boundary also releases a named future obligation if the
internal gateway cannot become ready before reservation. Existing fetch,
abnormal completion, cancellation, and stream cleanup paths continue to
release or commit pending reservations according to whether reliable usage
exists.

The signed-in general streaming route now composes its prompt before SSE
headers are flushed. If composition fails after the database V1 reservation,
the established `releaseBillingReservation` path runs and the error remains a
generic pre-stream failure.

## 7. Tool synthesis failure lifecycle

The lifecycle remains:

```text
selection-only supporting call
  -> tool execution
  -> bounded trusted evidence
  -> final context composition
  -> final generation-budget resolution
  -> final model-call reservation
  -> synthesis
```

If final composition fails, the future synthesis obligation is released, no
final pending call exists, and the final provider is not invoked. A completed
selection-only call remains committed exactly once. Selection text never
becomes a public answer, and no Fast or hidden provider fallback substitutes
for the unavailable Intuitive synthesis.

## 8. Continuation and repair safety

Ordinary and math continuation calls already use `buildChatPrompt`, so they now
inherit the immutable system/rules floor. The original question, prior answer,
malformed prior output, and repair diagnostics are dynamic context. They can be
head/tail bounded and cannot displace protected instructions.

Context failure occurs before continuation or repair reservation. Existing
callers preserve meaningful prior output and do not start a duplicate answer
after a failed continuation. The shared pending-reservation lifecycle remains
responsible for provider-time cancellation and abnormal completion.

## 9. Telemetry

Successful and failed composition telemetry contains only:

- selected input-context ceiling;
- raw and final estimated input;
- selected section names and safe counts;
- optional drop counts;
- required evidence items reduced and removed;
- whether the current message was trimmed;
- whether the protected floor failed.

Required evidence removal remains zero because this pass fails rather than
delete a required minimum representation. Telemetry never contains prompt,
memory, evidence, response, key, credential, provider/model, or hidden-reasoning
content. There is no `system_prompt_trimmed` event because that operation no
longer exists.

## 10. Tests

`backend/testProtectedContextSafety.ts` covers:

- optional-context overflow;
- single and multiple required-evidence overflow;
- deterministic relevance-aware reduction;
- system hard-maximum and context-ceiling failure;
- system plus rules and system plus minimum-message floors;
- current-message minimum retention and old-turn removal;
- tool synthesis failure cleanup with committed supporting usage;
- idempotent cancellation cleanup;
- continuation and repair overflow;
- evidence credential/base64 redaction;
- safe failure messages and telemetry.

The existing context matrix, request-budget affordability/concurrency tests,
provider tests, and rollout-flag tests remain in their original focused suites.
The rollout workflow runs the new `test:protected-context-safety` command.

## 11. Remaining limitations

Token estimates remain conservative and tokenizer-independent. Evidence
relevance is caller supplied or derived from existing retrieval scores; Pass
3.1 does not introduce a new semantic reranker. Required evidence is bounded
textual context, not a substitute for durable source storage. The hard system
character maximum is an application safety boundary, and an oversized
application prompt now fails rather than attempting recovery by mutation.

## 12. Passes 4-5 integration

Pass 3.1 itself did not implement billing policy. The later Passes 4-5 work on
this branch now attaches a Free-only unified V2 reservation as the hard ceiling
of the same request-local ledger. Protected-context failure still occurs
before provider invocation and releases that reservation; completed,
reliably-reported supporting usage is committed rather than discarded.

The rolling five-hour 50,000-token allowance, protected final 10,000-token Fast
reserve, database concurrency, transition/rollback accounting, and public
summary/error contracts are documented in
`docs/ai/UNIFIED_TEXT_TOKENS_V2_PASSES4_5.md`. Standard/Lite V1 remains
available for flag-off operation and paid plans. All four tracked rollout flags
remain false, and quota UI/settings work remains deferred to Pass 6.
