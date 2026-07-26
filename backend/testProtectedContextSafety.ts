import assert from "node:assert/strict";
import { handleChat } from "./ai/ChatHandler";
import {
  attachTokenAllowanceAccounting,
  getTokenAllowanceAccounting,
  recordSuccessfulModelUsage,
  releaseFutureTokenObligation,
  reserveFutureTokenObligation,
  reserveModelCall,
  runWithRequestBudgetContext,
} from "./context/requestBudgetContext";
import {
  ContextBudgetInsufficientError,
  MIN_RETAINED_CURRENT_USER_TOKENS,
  STABLE_CONTEXT_HANDLING_RULES,
  composeContextDetailed,
} from "./orchestrator/contextComposer";
import {
  estimateInputTokens,
  estimateTextTokens,
  trimTextToTokenBudget,
} from "./orchestrator/contextBudgetManager";

function repeated(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${label}-${index}`).join(" ");
}

function expectContextFailure(run: () => unknown): ContextBudgetInsufficientError {
  try {
    run();
  } catch (error) {
    assert(error instanceof ContextBudgetInsufficientError);
    assert.equal(error.code, "context_budget_insufficient");
    assert.equal(error.telemetry.protectedFloorFailed, true);
    return error;
  }
  assert.fail("expected context_budget_insufficient");
}

async function expectAsyncContextFailure(
  run: () => Promise<unknown>,
): Promise<ContextBudgetInsufficientError> {
  try {
    await run();
  } catch (error) {
    assert(error instanceof ContextBudgetInsufficientError);
    assert.equal(error.code, "context_budget_insufficient");
    return error;
  }
  assert.fail("expected context_budget_insufficient");
}

function immutablePrefix(systemPrompt: string): string {
  return `${systemPrompt}\n\n${STABLE_CONTEXT_HANDLING_RULES}`;
}

function currentMessageFrom(prompt: string): string {
  const marker = "CURRENT USER MESSAGE:\n";
  const index = prompt.lastIndexOf(marker);
  assert(index >= 0);
  return prompt.slice(index + marker.length);
}

function findSystemForFloor(
  predicate: (systemPrompt: string) => boolean,
): string {
  for (let length = 1; length <= 4_000; length += 1) {
    const candidate = `SYSTEM-${"x".repeat(length)}`;
    if (predicate(candidate)) return candidate;
  }
  assert.fail("could not construct requested protected-floor boundary");
}

async function main(): Promise<void> {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    const exactSystem = "  SYSTEM POLICY: immutable bytes.\nDo not weaken this policy.  ";
    const optionalOverflow = composeContextDetailed({
      systemPrompt: exactSystem,
      userMessage: "Give me the safest concise answer.",
      stableContext: repeated("PROFILE", 1_000),
      workspaceCapsule: repeated("WORKSPACE", 1_000),
      conversationCapsule: repeated("CAPSULE", 1_000),
      conversationSummary: repeated("SUMMARY", 1_000),
      memories: Array.from({ length: 20 }, (_, index) => ({
        type: "preference",
        summary: repeated(`MEMORY-${index}`, 120),
        relevance: 1 - index / 100,
      })),
      fileReferences: [{
        filename: "large.txt",
        extractedText: repeated("FILE-CONTEXT", 5_000),
      }],
      routeEvidence: [{
        label: "optional route",
        content: repeated("OPTIONAL-EVIDENCE", 2_000),
        relevance: 0.2,
      }],
      conversation: Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: repeated(`OLD-TURN-${index}`, 80),
      })),
      tokenBudget: 900,
    });
    assert.equal(optionalOverflow.prompt.slice(0, exactSystem.length), exactSystem);
    assert(optionalOverflow.prompt.startsWith(immutablePrefix(exactSystem)));
    assert(optionalOverflow.prompt.includes(STABLE_CONTEXT_HANDLING_RULES));
    assert(optionalOverflow.telemetry.finalEstimatedInputTokens <= 900);
    assert.equal(optionalOverflow.telemetry.protectedFloorFailed, false);
    assert.equal(optionalOverflow.telemetry.currentMessageTrimmed, false);
    assert(
      optionalOverflow.telemetry.droppedCounts.optional_evidence
        + optionalOverflow.telemetry.droppedCounts.memories
        + optionalOverflow.telemetry.droppedCounts.summaries
        + optionalOverflow.telemetry.droppedCounts.recent_turns
        + optionalOverflow.telemetry.droppedCounts.file_chunks > 0,
      "optional context must be dropped before protected content changes",
    );

    const base64 = `data:image/png;base64,${"A".repeat(400)}`;
    const requiredOverflow = composeContextDetailed({
      systemPrompt: exactSystem,
      userMessage: "Summarize the required result.",
      routeEvidence: [{
        label: "trusted result",
        required: true,
        relevance: 1,
        content: [
          "REQUIRED-BEGIN",
          "authorization: Bearer-secret-value",
          base64,
          repeated("required-middle", 2_000),
          "REQUIRED-END",
        ].join("\n"),
      }],
      tokenBudget: 500,
    });
    assert(requiredOverflow.prompt.startsWith(immutablePrefix(exactSystem)));
    assert(requiredOverflow.prompt.includes("[required: trusted result]"));
    assert(requiredOverflow.prompt.includes("REQUIRED-BEGIN"));
    assert(requiredOverflow.prompt.includes("REQUIRED-END"));
    assert(requiredOverflow.prompt.includes("full source not retained"));
    assert(!requiredOverflow.prompt.includes("Bearer-secret-value"));
    assert(!requiredOverflow.prompt.includes(base64));
    assert(requiredOverflow.telemetry.requiredEvidenceItemsReduced >= 1);
    assert.equal(requiredOverflow.telemetry.requiredEvidenceItemsRemoved, 0);
    assert(requiredOverflow.telemetry.finalEstimatedInputTokens <= 500);

    const multipleRequired = composeContextDetailed({
      systemPrompt: "SYSTEM MULTI-EVIDENCE POLICY",
      userMessage: "Compare the supplied evidence.",
      routeEvidence: [
        {
          label: "low",
          required: true,
          relevance: 0.1,
          content: `LOW-BEGIN ${repeated("LOW", 220)} LOW-END`,
        },
        {
          label: "high",
          required: true,
          relevance: 1,
          content: `HIGH-BEGIN ${repeated("HIGH", 220)} HIGH-END`,
        },
        {
          label: "medium",
          required: true,
          relevance: 0.5,
          content: `MEDIUM-BEGIN ${repeated("MEDIUM", 220)} MEDIUM-END`,
        },
      ],
      tokenBudget: 900,
    });
    assert(
      multipleRequired.prompt.indexOf("[required: high]")
        < multipleRequired.prompt.indexOf("[required: medium]"),
    );
    assert(
      multipleRequired.prompt.indexOf("[required: medium]")
        < multipleRequired.prompt.indexOf("[required: low]"),
    );
    const highRetained = multipleRequired.prompt.match(/\bHIGH-\d+\b/g)?.length ?? 0;
    const lowRetained = multipleRequired.prompt.match(/\bLOW-\d+\b/g)?.length ?? 0;
    assert(highRetained > lowRetained, "higher-relevance evidence retains more content");
    assert(multipleRequired.telemetry.requiredEvidenceItemsReduced >= 1);
    assert.equal(
      multipleRequired.telemetry.droppedCounts.required_evidence,
      multipleRequired.telemetry.requiredEvidenceItemsReduced,
    );
    assert.equal(multipleRequired.telemetry.requiredEvidenceItemsRemoved, 0);
    assert(multipleRequired.telemetry.finalEstimatedInputTokens <= 900);

    await runWithRequestBudgetContext(
      { planCode: "free", executionMode: "intuitive", resolution: "billing" },
      async () => {
        attachTokenAllowanceAccounting({
          feature: "premium_text",
          requestId: "system-floor",
          planCode: "free",
          reservedTokens: 20_000,
        });
        const secretSystem = `SECRET-SYSTEM-POLICY ${"x".repeat(7_000)}`;
        const failure = expectContextFailure(() => composeContextDetailed({
          systemPrompt: secretSystem,
          userMessage: "small user message",
          tokenBudget: 256,
        }));
        assert(!failure.message.includes("SECRET-SYSTEM-POLICY"));
        assert(!JSON.stringify(failure.telemetry).includes("SECRET-SYSTEM-POLICY"));
        const accounting = getTokenAllowanceAccounting("system-floor");
        assert(accounting);
        assert.equal(accounting.pendingCalls, 0);
        assert.equal(accounting.successfulCalls, 0);
      },
    );

    const hardMaximumFailure = expectContextFailure(() => composeContextDetailed({
      systemPrompt: `HARD-MAX-SECRET ${"x".repeat(60_000)}`,
      userMessage: "small user message",
      inputContextCeilingTokens: 22_000,
    }));
    assert(!hardMaximumFailure.message.includes("HARD-MAX-SECRET"));

    const minimumCurrent = trimTextToTokenBudget(
      repeated("CURRENT-FLOOR", 100),
      MIN_RETAINED_CURRENT_USER_TOKENS,
      "head_tail",
    );
    const systemPlusCurrentBoundary = findSystemForFloor((systemPrompt) => {
      const immutable = estimateInputTokens(immutablePrefix(systemPrompt), 1).tokens;
      const withCurrent = estimateInputTokens(
        `${immutablePrefix(systemPrompt)}\n\nCURRENT USER MESSAGE:\n${minimumCurrent}`,
        1,
      ).tokens;
      return immutable <= 256 && withCurrent > 256;
    });
    expectContextFailure(() => composeContextDetailed({
      systemPrompt: systemPlusCurrentBoundary,
      userMessage: repeated("CURRENT-FLOOR", 100),
      tokenBudget: 256,
    }));
    const boundarySystemOnly = composeContextDetailed({
      systemPrompt: systemPlusCurrentBoundary,
      userMessage: "x",
      tokenBudget: 256,
    });
    assert.equal(
      boundarySystemOnly.prompt.slice(0, systemPlusCurrentBoundary.length),
      systemPlusCurrentBoundary,
    );

    const systemPlusRulesBoundary = findSystemForFloor((systemPrompt) => {
      const systemOnly = estimateInputTokens(systemPrompt, 1).tokens;
      const immutable = estimateInputTokens(immutablePrefix(systemPrompt), 1).tokens;
      return systemOnly <= 256 && immutable > 256;
    });
    expectContextFailure(() => composeContextDetailed({
      systemPrompt: systemPlusRulesBoundary,
      userMessage: "x",
      tokenBudget: 256,
    }));

    const trimmedCurrent = composeContextDetailed({
      systemPrompt: "SYSTEM CURRENT-MESSAGE POLICY",
      userMessage: `CURRENT-BEGIN ${repeated("CURRENT-MIDDLE", 2_000)} CURRENT-END`,
      conversation: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: repeated(`OLD-${index}`, 100),
      })),
      memories: [{ type: "preference", summary: repeated("OPTIONAL-MEMORY", 500) }],
      tokenBudget: 350,
    });
    assert(trimmedCurrent.prompt.startsWith(immutablePrefix("SYSTEM CURRENT-MESSAGE POLICY")));
    assert(trimmedCurrent.telemetry.droppedCounts.recent_turns > 0);
    assert(trimmedCurrent.telemetry.currentMessageTrimmed);
    const retainedCurrent = currentMessageFrom(trimmedCurrent.prompt);
    assert(retainedCurrent.includes("CURRENT-BEGIN"));
    assert(retainedCurrent.includes("CURRENT-END"));
    assert(
      estimateTextTokens(retainedCurrent) >= MIN_RETAINED_CURRENT_USER_TOKENS - 1,
      "the retained current message stays at the documented minimum",
    );

    await runWithRequestBudgetContext(
      { planCode: "free", executionMode: "intuitive", resolution: "billing" },
      async () => {
        attachTokenAllowanceAccounting({
          feature: "premium_text",
          requestId: "tool-synthesis-floor",
          planCode: "free",
          reservedTokens: 100_000,
        });
        reserveFutureTokenObligation({
          id: "intuitive-final-synthesis",
          protectedInputTokens: 2_000,
          protectedOutputTokens: 1_500,
        });
        const supporting = reserveModelCall({
          estimatedInputTokens: 100,
          requestedOutputTokens: 200,
        });
        assert(supporting);
        recordSuccessfulModelUsage({
          reservationId: supporting.id,
          prompt: "selection only",
          output: "selected tool",
          reportedInputTokens: 100,
          reportedOutputTokens: 20,
        });
        const impossibleEvidence = Array.from({ length: 160 }, (_, index) => ({
          label: `required-${index}`,
          required: true,
          relevance: 1 - index / 1_000,
          content: repeated(`EVIDENCE-${index}`, 100),
        }));
        const failure = await expectAsyncContextFailure(() => handleChat({
          userMessage: "Synthesize the trusted tool evidence.",
          routeEvidence: impossibleEvidence,
          modelOverride: "gpt-oss-120b",
          executionMode: "intuitive",
          allowedModelTools: [],
          requiredCapabilities: [],
          consumeFutureObligationId: "intuitive-final-synthesis",
        }));
        assert(!failure.message.includes("EVIDENCE-"));
        const accounting = getTokenAllowanceAccounting("tool-synthesis-floor");
        assert(accounting);
        assert.equal(accounting.pendingCalls, 0);
        assert.equal(accounting.pendingTokens, 0);
        assert.equal(accounting.futureObligations, 0);
        assert.equal(accounting.futureReservedTokens, 0);
        assert.equal(accounting.successfulCalls, 1);
        assert.equal(accounting.inputTokens, 100);
        assert.equal(accounting.outputTokens, 20);
        assert.equal(
          releaseFutureTokenObligation("intuitive-final-synthesis"),
          false,
          "repeated cleanup is idempotent",
        );
      },
    );

    await runWithRequestBudgetContext(
      { planCode: "free", executionMode: "intuitive", resolution: "billing" },
      async () => {
        attachTokenAllowanceAccounting({
          feature: "premium_text",
          requestId: "cancel-during-composition",
          planCode: "free",
          reservedTokens: 10_000,
        });
        reserveFutureTokenObligation({
          id: "cancelled-final",
          protectedInputTokens: 1_000,
          protectedOutputTokens: 1_500,
        });
        assert.equal(releaseFutureTokenObligation("cancelled-final"), true);
        assert.equal(releaseFutureTokenObligation("cancelled-final"), false);
        const accounting = getTokenAllowanceAccounting("cancel-during-composition");
        assert(accounting);
        assert.equal(accounting.pendingCalls, 0);
        assert.equal(accounting.futureObligations, 0);
        assert.equal(accounting.successfulCalls, 0);
      },
    );

    const continuationOverflow = composeContextDetailed({
      systemPrompt: "SYSTEM CONTINUATION POLICY",
      userMessage: [
        "CONTINUATION ORIGINAL QUESTION",
        repeated("PRIOR-ANSWER", 2_000),
        "CONTINUATION PRIOR-ANSWER END",
      ].join("\n"),
      conversation: Array.from({ length: 10 }, (_, index) => ({
        role: "assistant",
        content: repeated(`OLDER-CONTINUATION-${index}`, 100),
      })),
      tokenBudget: 350,
    });
    assert(continuationOverflow.prompt.startsWith(immutablePrefix("SYSTEM CONTINUATION POLICY")));
    assert(continuationOverflow.telemetry.currentMessageTrimmed);
    assert(continuationOverflow.prompt.includes("CONTINUATION ORIGINAL QUESTION"));
    assert(continuationOverflow.prompt.includes("CONTINUATION PRIOR-ANSWER END"));
    assert(continuationOverflow.telemetry.droppedCounts.recent_turns > 0);

    const repairOverflow = composeContextDetailed({
      systemPrompt: "SYSTEM REPAIR POLICY",
      userMessage: [
        "REPAIR ORIGINAL REQUEST",
        repeated("MALFORMED-PRIOR-OUTPUT", 2_000),
        "REPAIR MALFORMED OUTPUT END",
      ].join("\n"),
      routeEvidence: [{
        label: "optional repair diagnostics",
        content: repeated("RAW-DIAGNOSTIC", 1_000),
        relevance: 0,
      }],
      tokenBudget: 350,
    });
    assert(repairOverflow.prompt.startsWith(immutablePrefix("SYSTEM REPAIR POLICY")));
    assert(repairOverflow.telemetry.currentMessageTrimmed);
    assert(repairOverflow.prompt.includes("REPAIR ORIGINAL REQUEST"));
    assert(repairOverflow.prompt.includes("REPAIR MALFORMED OUTPUT END"));
    assert(repairOverflow.telemetry.droppedCounts.optional_evidence > 0);
    assert(repairOverflow.telemetry.finalEstimatedInputTokens <= 350);

    console.log("Protected context safety tests passed.");
  } finally {
    console.info = originalInfo;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
