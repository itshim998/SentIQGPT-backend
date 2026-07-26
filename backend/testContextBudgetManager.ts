import assert from "assert";
import {
  attachTokenAllowanceAccounting,
  getRequestBudgetContext,
  getTokenAllowanceAccounting,
  recordSuccessfulModelUsage,
  runWithRequestBudgetContext,
} from "./context/requestBudgetContext";
import {
  AUXILIARY_OUTPUT_CAPS,
  ARTIFACT_OUTPUT_POLICY,
  EXECUTION_MODE_OUTPUT_POLICIES,
  GenerationBudgetError,
  INTUITIVE_GENERATION_POLICIES,
  TIER_TOKEN_POLICIES,
  estimateInputTokens,
  resolveOutputBudget,
  type GroqCapacitySnapshot,
} from "./orchestrator/contextBudgetManager";

function capacity(remainingTokens: number, limitTokens = 10_000): GroqCapacitySnapshot {
  return { limitTokens, remainingTokens, observedAtMs: Date.now() };
}

async function main(): Promise<void> {
  assert.deepStrictEqual(TIER_TOKEN_POLICIES, {
    free: { normalMinTotalTokens: 2_500, normalMaxTotalTokens: 3_200, heavyMaxTotalTokens: 4_000 },
    student_core: { normalMinTotalTokens: 4_500, normalMaxTotalTokens: 6_000, heavyMaxTotalTokens: 7_500 },
    premium: { normalMinTotalTokens: 7_000, normalMaxTotalTokens: 9_500, heavyMaxTotalTokens: 12_000 },
    pro: { normalMinTotalTokens: 10_000, normalMaxTotalTokens: 16_000, heavyMaxTotalTokens: 22_000 },
  });
  assert.deepStrictEqual(EXECUTION_MODE_OUTPUT_POLICIES, {
    fast: { defaultOutputTokens: 2_500, hardOutputTokens: 2_500, reasoningEffort: "low" },
    intuitive: { defaultOutputTokens: 3_500, hardOutputTokens: 3_500, reasoningEffort: "medium" },
  });
  assert.deepStrictEqual(AUXILIARY_OUTPUT_CAPS, {
    title: 80,
    routing: 200,
    memory: 400,
  });
  assert.strictEqual(ARTIFACT_OUTPUT_POLICY.hardOutputTokens, 6_500);
  assert.deepStrictEqual(INTUITIVE_GENERATION_POLICIES, {
    normal: {
      totalGenerationTokens: 6_000,
      maximumReasoningTokens: 2_000,
      protectedVisibleAnswerTokens: 1_500,
      timeoutMs: 120_000,
    },
    heavy: {
      totalGenerationTokens: 8_000,
      maximumReasoningTokens: 3_500,
      protectedVisibleAnswerTokens: 2_000,
      timeoutMs: 120_000,
    },
  });

  const ascii = estimateInputTokens("one two three", 2);
  const unicode = estimateInputTokens("你好世界你好世界", 2);
  assert(ascii.tokens >= ascii.wordCount + 16, "message framing overhead is included");
  assert(unicode.utf8Bytes > "你好世界你好世界".length, "UTF-8 byte size is measured");
  assert(unicode.tokens > 1, "non-ASCII input receives a conservative estimate");

  for (const planCode of Object.keys(TIER_TOKEN_POLICIES)) {
    const fast = resolveOutputBudget({
      planCode,
      executionMode: "fast",
      budgetClass: "interactive",
      requestedOutputTokens: 6_000,
      estimatedInputTokens: 500,
    });
    const intuitive = resolveOutputBudget({
      planCode,
      executionMode: "intuitive",
      budgetClass: "interactive",
      requestedOutputTokens: 6_000,
      estimatedInputTokens: 500,
    });
    assert.strictEqual(fast.selectedOutputTokens, 2_500);
    assert.strictEqual(fast.reasoningEffort, "low");
    assert.strictEqual(intuitive.selectedOutputTokens, 3_500);
    assert.strictEqual(intuitive.reasoningEffort, "medium");
  }

  const proDefault = resolveOutputBudget({ planCode: "pro", executionMode: "fast", budgetClass: "interactive", estimatedInputTokens: 500 });
  assert.strictEqual(proDefault.selectedOutputTokens, 2_500);
  assert.strictEqual(proDefault.totalTokenBudget, 16_000);

  const guarded = resolveOutputBudget({
    planCode: "free",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(3_000),
  });
  assert.strictEqual(guarded.capacityBand, "guarded");
  assert.strictEqual(guarded.selectedOutputTokens, 2_125);
  assert.strictEqual(guarded.allowHeavyExpansion, false);

  const constrained = resolveOutputBudget({
    planCode: "premium",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(2_000),
  });
  assert.strictEqual(constrained.capacityBand, "constrained");
  assert.strictEqual(constrained.selectedOutputTokens, 2_100);
  assert.strictEqual(constrained.totalTokenBudget, TIER_TOKEN_POLICIES.premium.normalMinTotalTokens);

  const critical = resolveOutputBudget({
    planCode: "pro",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(900),
  });
  assert.strictEqual(critical.selectedOutputTokens, 256);
  assert.strictEqual(critical.forceFallback, true);

  const insufficient = resolveOutputBudget({
    planCode: "premium",
    budgetClass: "interactive",
    estimatedInputTokens: 1_900,
    capacity: capacity(2_100),
  });
  assert.strictEqual(insufficient.forceFallback, true);

  for (const [kind, expected] of Object.entries(AUXILIARY_OUTPUT_CAPS)) {
    const decision = resolveOutputBudget({
      planCode: "pro",
      budgetClass: "auxiliary",
      auxiliaryKind: kind as keyof typeof AUXILIARY_OUTPUT_CAPS,
      requestedOutputTokens: 9_000,
      estimatedInputTokens: 100,
    });
    assert.strictEqual(decision.selectedOutputTokens, expected);
  }

  const artifact = resolveOutputBudget({
    planCode: "free",
    budgetClass: "artifact",
    requestedOutputTokens: 9_000,
    estimatedInputTokens: 20_000,
    capacity: capacity(100),
  });
  assert.strictEqual(artifact.selectedOutputTokens, ARTIFACT_OUTPUT_POLICY.hardOutputTokens);
  assert.strictEqual(artifact.forceFallback, false);

  const intuitiveOrdinary = resolveOutputBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
  });
  assert.strictEqual(intuitiveOrdinary.selectedOutputTokens, 6_000);
  assert.strictEqual(intuitiveOrdinary.reasoningBudgetTokens, 2_000);
  assert.strictEqual(intuitiveOrdinary.protectedVisibleAnswerTokens, 1_500);
  assert.strictEqual(intuitiveOrdinary.timeoutMs, 120_000);
  assert(
    intuitiveOrdinary.reasoningBudgetTokens + intuitiveOrdinary.protectedVisibleAnswerTokens
      <= intuitiveOrdinary.selectedOutputTokens,
    "ordinary Intuitive reasoning and protected answer must fit its total ceiling",
  );

  const intuitiveComplex = resolveOutputBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "heavy",
    providerCapability: "nemotron_reasoning",
  });
  assert.strictEqual(intuitiveComplex.selectedOutputTokens, 8_000);
  assert.strictEqual(intuitiveComplex.reasoningBudgetTokens, 3_500);
  assert.strictEqual(intuitiveComplex.protectedVisibleAnswerTokens, 2_000);

  const providerLimitedIntuitive = resolveOutputBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    providerMaximumGeneratedTokens: 5_000,
  });
  assert.strictEqual(providerLimitedIntuitive.selectedOutputTokens, 5_000);
  assert.strictEqual(providerLimitedIntuitive.reasoningBudgetTokens, 2_000);

  const affordableIntuitive = resolveOutputBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 1_000,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 5_000,
  });
  assert.strictEqual(affordableIntuitive.selectedOutputTokens, 4_000);
  assert.strictEqual(affordableIntuitive.reasoningBudgetTokens, 2_000);
  assert.strictEqual(affordableIntuitive.protectedVisibleAnswerTokens, 1_500);

  const nearLimitIntuitive = resolveOutputBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 1_000,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 3_000,
  });
  assert.strictEqual(nearLimitIntuitive.selectedOutputTokens, 2_000);
  assert.strictEqual(nearLimitIntuitive.reasoningBudgetTokens, 500);
  assert.strictEqual(nearLimitIntuitive.protectedVisibleAnswerTokens, 1_500);

  assert.throws(
    () => resolveOutputBudget({
      planCode: "free",
      executionMode: "intuitive",
      budgetClass: "interactive",
      estimatedInputTokens: 700,
      complexity: "normal",
      providerCapability: "nemotron_reasoning",
      remainingReservationTokens: 2_000,
    }),
    GenerationBudgetError,
  );
  assert.throws(
    () => resolveOutputBudget({
      planCode: "free",
      executionMode: "fast",
      budgetClass: "interactive",
      estimatedInputTokens: 40,
      remainingReservationTokens: 60,
      reservationFeature: "lite_text",
    }),
    (error: unknown) => (
      error instanceof GenerationBudgetError
      && error.code === "token_reservation_exhausted"
      && error.message.includes("Lite")
    ),
  );

  const contexts = await Promise.all([
    runWithRequestBudgetContext({ planCode: "premium", executionMode: "intuitive", resolution: "billing" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getRequestBudgetContext();
    }),
    runWithRequestBudgetContext({ planCode: "pro", executionMode: "fast", resolution: "billing" }, async () => getRequestBudgetContext()),
  ]);
  assert.deepStrictEqual(contexts.map((context) => [context.planCode, context.executionMode]), [
    ["premium", "intuitive"],
    ["pro", "fast"],
  ]);
  assert.strictEqual(getRequestBudgetContext().planCode, "free");
  assert.strictEqual(getRequestBudgetContext().executionMode, "fast");

  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "intuitive", resolution: "billing" },
    async () => {
      attachTokenAllowanceAccounting({
        feature: "premium_text",
        requestId: "nemotron-usage-test",
        planCode: "free",
        reservedTokens: 10_000,
      });
      recordSuccessfulModelUsage({
        prompt: "reported input",
        output: "visible answer",
        reportedInputTokens: 25,
        // Provider output usage includes hidden reasoning plus visible output.
        reportedOutputTokens: 125,
      });
      recordSuccessfulModelUsage({
        prompt: "estimated input",
        output: "estimated visible output",
      });
      // A failed provider call deliberately has no recordSuccessfulModelUsage call.
      const accounting = getTokenAllowanceAccounting("nemotron-usage-test");
      assert(accounting);
      assert.strictEqual(accounting.successfulCalls, 2);
      assert.strictEqual(accounting.reportedCalls, 1);
      assert.strictEqual(accounting.estimatedCalls, 1);
      assert(accounting.inputTokens > 25);
      assert(accounting.outputTokens > 125);
    },
  );

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    for (const id of [1, 2, 3, 4]) {
      process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
      process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
    }
    const { BillingQuotaService } = await import("./billing/quotaService");
    const paidService = new BillingQuotaService({
      getUsageSummary: async () => ({ plan_code: "premium" }),
    } as never);
    assert.strictEqual(
      await paidService.resolvePlanCode({ userId: "redacted", anonymousKeyHash: null, isGuest: false }),
      "premium",
    );
    const unknownService = new BillingQuotaService({
      getUsageSummary: async () => ({ plan_code: "unknown" }),
    } as never);
    assert.strictEqual(
      await unknownService.resolvePlanCode({ userId: "redacted", anonymousKeyHash: null, isGuest: false }),
      "free",
    );
    const service = new BillingQuotaService({
      getUsageSummary: async () => { throw new Error("unavailable"); },
    } as never);
    const resolved = await service.resolvePlanCode({ userId: "redacted", anonymousKeyHash: null, isGuest: false });
    assert.strictEqual(resolved, "free");
  } finally {
    console.warn = originalWarn;
  }

  console.log("Context budget Phase 1 validation passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
