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
  ARTIFACT_GENERATION_POLICY,
  EXECUTION_MODE_GENERATION_POLICIES,
  GenerationBudgetError,
  INTUITIVE_GENERATION_POLICIES,
  PLAN_MODE_INPUT_CONTEXT_POLICIES,
  estimateInputTokens,
  resolveGenerationBudget,
  type GroqCapacitySnapshot,
} from "./orchestrator/contextBudgetManager";

function capacity(remainingTokens: number, limitTokens = 10_000): GroqCapacitySnapshot {
  return { limitTokens, remainingTokens, observedAtMs: Date.now() };
}

async function main(): Promise<void> {
  assert.deepStrictEqual(PLAN_MODE_INPUT_CONTEXT_POLICIES.free, {
    fast: { constrainedCeilingTokens: 2_500, ordinaryCeilingTokens: 3_200, complexCeilingTokens: 4_000 },
    intuitive: { constrainedCeilingTokens: 2_500, ordinaryCeilingTokens: 6_000, complexCeilingTokens: 8_000 },
  });
  assert.deepStrictEqual(EXECUTION_MODE_GENERATION_POLICIES, {
    fast: { defaultGenerationTokens: 2_500, generationCeilingTokens: 2_500, reasoningEffort: "low" },
    intuitive: { defaultGenerationTokens: 3_500, generationCeilingTokens: 3_500, reasoningEffort: "medium" },
  });
  assert.deepStrictEqual(AUXILIARY_OUTPUT_CAPS, {
    title: 80,
    routing: 200,
    memory: 400,
  });
  assert.strictEqual(ARTIFACT_GENERATION_POLICY.generationCeilingTokens, 6_500);
  assert.deepStrictEqual(INTUITIVE_GENERATION_POLICIES, {
    normal: {
      generationCeilingTokens: 6_000,
      maximumReasoningTokens: 2_000,
      protectedVisibleAnswerTokens: 1_500,
      timeoutMs: 120_000,
    },
    heavy: {
      generationCeilingTokens: 8_000,
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

  for (const planCode of Object.keys(PLAN_MODE_INPUT_CONTEXT_POLICIES)) {
    const fast = resolveGenerationBudget({
      planCode,
      executionMode: "fast",
      budgetClass: "interactive",
      requestedOutputTokens: 6_000,
      estimatedInputTokens: 500,
    });
    const intuitive = resolveGenerationBudget({
      planCode,
      executionMode: "intuitive",
      budgetClass: "interactive",
      requestedOutputTokens: 6_000,
      estimatedInputTokens: 500,
    });
    assert.strictEqual(fast.selectedGenerationTokens, 2_500);
    assert.strictEqual(fast.reasoningEffort, "low");
    assert.strictEqual(intuitive.selectedGenerationTokens, 3_500);
    assert.strictEqual(intuitive.reasoningEffort, "medium");
  }

  const proDefault = resolveGenerationBudget({ planCode: "pro", executionMode: "fast", budgetClass: "interactive", estimatedInputTokens: 500 });
  assert.strictEqual(proDefault.selectedGenerationTokens, 2_500);
  assert.strictEqual(proDefault.inputContextCeilingTokens, 16_000);

  const guarded = resolveGenerationBudget({
    planCode: "free",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(3_000),
  });
  assert.strictEqual(guarded.capacityBand, "guarded");
  assert.strictEqual(guarded.selectedGenerationTokens, 2_125);
  assert.strictEqual(guarded.allowHeavyExpansion, false);

  const constrained = resolveGenerationBudget({
    planCode: "premium",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(2_000),
  });
  assert.strictEqual(constrained.capacityBand, "constrained");
  assert.strictEqual(constrained.selectedGenerationTokens, 2_100);
  assert.strictEqual(constrained.inputContextCeilingTokens, 7_000);

  const critical = resolveGenerationBudget({
    planCode: "pro",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    capacity: capacity(900),
  });
  assert.strictEqual(critical.selectedGenerationTokens, 256);
  assert.strictEqual(critical.forceFallback, true);

  const insufficient = resolveGenerationBudget({
    planCode: "premium",
    budgetClass: "interactive",
    estimatedInputTokens: 1_900,
    capacity: capacity(2_100),
  });
  assert.strictEqual(insufficient.forceFallback, true);

  for (const [kind, expected] of Object.entries(AUXILIARY_OUTPUT_CAPS)) {
    const decision = resolveGenerationBudget({
      planCode: "pro",
      budgetClass: "auxiliary",
      auxiliaryKind: kind as keyof typeof AUXILIARY_OUTPUT_CAPS,
      requestedOutputTokens: 9_000,
      estimatedInputTokens: 100,
    });
    assert.strictEqual(decision.selectedGenerationTokens, expected);
  }

  const artifact = resolveGenerationBudget({
    planCode: "free",
    budgetClass: "artifact",
    requestedOutputTokens: 9_000,
    estimatedInputTokens: 20_000,
    capacity: capacity(100),
  });
  assert.strictEqual(artifact.selectedGenerationTokens, ARTIFACT_GENERATION_POLICY.generationCeilingTokens);
  assert.strictEqual(artifact.forceFallback, false);

  const intuitiveOrdinary = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
  });
  assert.strictEqual(intuitiveOrdinary.selectedGenerationTokens, 6_000);
  assert.strictEqual(intuitiveOrdinary.reasoningBudgetTokens, 2_000);
  assert.strictEqual(intuitiveOrdinary.protectedVisibleAnswerTokens, 1_500);
  assert.strictEqual(intuitiveOrdinary.providerMaximumGeneratedTokens, 8_000);
  assert.strictEqual(intuitiveOrdinary.timeoutMs, 120_000);
  assert(
    intuitiveOrdinary.reasoningBudgetTokens + intuitiveOrdinary.protectedVisibleAnswerTokens
      <= intuitiveOrdinary.selectedGenerationTokens,
    "ordinary Intuitive reasoning and protected answer must fit its total ceiling",
  );

  const intuitiveComplex = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "heavy",
    providerCapability: "nemotron_reasoning",
  });
  assert.strictEqual(intuitiveComplex.selectedGenerationTokens, 8_000);
  assert.strictEqual(intuitiveComplex.reasoningBudgetTokens, 3_500);
  assert.strictEqual(intuitiveComplex.protectedVisibleAnswerTokens, 2_000);

  const providerLimitedIntuitive = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 500,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    providerMaximumGeneratedTokens: 5_000,
  });
  assert.strictEqual(providerLimitedIntuitive.selectedGenerationTokens, 5_000);
  assert.strictEqual(providerLimitedIntuitive.reasoningBudgetTokens, 2_000);

  const boundedWebSurfIntuitive = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    requestedOutputTokens: 500,
    requestedVisibleAnswerTokens: 500,
    estimatedInputTokens: 4_019,
    complexity: "heavy",
    providerCapability: "nemotron_reasoning",
    providerMaximumGeneratedTokens: 8_000,
    remainingReservationTokens: 16_000,
  });
  assert.strictEqual(
    boundedWebSurfIntuitive.selectedGenerationTokens,
    4_000,
    "bounded WebSurf synthesis adds its hidden-reasoning allowance to the visible-answer target",
  );
  assert.strictEqual(boundedWebSurfIntuitive.reasoningBudgetTokens, 3_500);
  assert.strictEqual(
    boundedWebSurfIntuitive.protectedVisibleAnswerTokens,
    500,
    "a deliberate 500-token WebSurf answer is not rejected by the generic heavy-answer floor",
  );

  const affordableIntuitive = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 1_000,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 5_000,
  });
  assert.strictEqual(affordableIntuitive.selectedGenerationTokens, 4_000);
  assert.strictEqual(affordableIntuitive.reasoningBudgetTokens, 2_000);
  assert.strictEqual(affordableIntuitive.protectedVisibleAnswerTokens, 1_500);

  const exactWorkedExample = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 2_200,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 7_000,
  });
  assert.strictEqual(exactWorkedExample.selectedGenerationTokens, 4_800);
  assert.strictEqual(exactWorkedExample.reasoningBudgetTokens, 2_000);
  assert.strictEqual(exactWorkedExample.protectedVisibleAnswerTokens, 1_500);
  assert.strictEqual(2_200 + exactWorkedExample.selectedGenerationTokens, 7_000);

  const exactReserveFloor = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 2_200,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 3_700,
  });
  assert.strictEqual(exactReserveFloor.selectedGenerationTokens, 1_500);
  assert.strictEqual(exactReserveFloor.reasoningBudgetTokens, 0);
  assert.throws(
    () => resolveGenerationBudget({
      planCode: "free",
      executionMode: "intuitive",
      budgetClass: "interactive",
      estimatedInputTokens: 2_200,
      complexity: "normal",
      providerCapability: "nemotron_reasoning",
      remainingReservationTokens: 3_699,
    }),
    GenerationBudgetError,
  );
  assert.throws(
    () => resolveGenerationBudget({
      planCode: "free",
      executionMode: "intuitive",
      budgetClass: "interactive",
      estimatedInputTokens: 100,
      complexity: "normal",
      providerCapability: "nemotron_reasoning",
      providerMaximumGeneratedTokens: 1_499,
    }),
    GenerationBudgetError,
  );
  const providerAtFloor = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 100,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    providerMaximumGeneratedTokens: 1_500,
  });
  assert.strictEqual(providerAtFloor.selectedGenerationTokens, 1_500);
  assert.strictEqual(providerAtFloor.reasoningBudgetTokens, 0);

  const nearLimitIntuitive = resolveGenerationBudget({
    planCode: "free",
    executionMode: "intuitive",
    budgetClass: "interactive",
    estimatedInputTokens: 1_000,
    complexity: "normal",
    providerCapability: "nemotron_reasoning",
    remainingReservationTokens: 3_000,
  });
  assert.strictEqual(nearLimitIntuitive.selectedGenerationTokens, 2_000);
  assert.strictEqual(nearLimitIntuitive.reasoningBudgetTokens, 500);
  assert.strictEqual(nearLimitIntuitive.protectedVisibleAnswerTokens, 1_500);

  assert.throws(
    () => resolveGenerationBudget({
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
    () => resolveGenerationBudget({
      planCode: "free",
      executionMode: "fast",
      budgetClass: "interactive",
      estimatedInputTokens: 40,
      remainingReservationTokens: 60,
      reservationAllowanceClass: "lite",
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
