import assert from "assert";
import { getRequestBudgetContext, runWithRequestBudgetContext } from "./context/requestBudgetContext";
import {
  AUXILIARY_OUTPUT_CAPS,
  ARTIFACT_OUTPUT_POLICY,
  EXECUTION_MODE_OUTPUT_POLICIES,
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
    critic: 300,
    memory: 400,
    clarification: 600,
  });
  assert.strictEqual(ARTIFACT_OUTPUT_POLICY.hardOutputTokens, 6_500);

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
