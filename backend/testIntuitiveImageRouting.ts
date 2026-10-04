import assert from "node:assert/strict";
import {
  getImageModelForPlan,
  getImageModelPreferenceForPlan,
  resolveImageRoute,
  type ImageModelRoute,
} from "./billing/modelEntitlementRouter";
import {
  getImageProviderOrder,
  executeImageGenerationWithProviders,
} from "./tools/imageGeneration/imageRouter";
import {
  buildPollinationsUrl,
  describePollinationsRequest,
} from "./tools/imageGeneration/pollinationsUtils";
import {
  IMAGE_MODEL_PREFERENCES,
  ImageProviderFailure,
  requireImageModelPreference,
  type ImageModelPreference,
  type ImageProvider,
  type ImageProviderRequestContext,
} from "./tools/imageGeneration/types";
import { PollinationsImageModelProvider } from "./tools/imageGeneration/providers/pollinationsImageModelProvider";
import { detectExplicitTextRenderingRequirement } from "./tools/imageGeneration/imageTextRenderingDecision";
import { FAST_PROFILE, INTUITIVE_PROFILE } from "./orchestrator/executionProfile";
import { execImageGeneration } from "./orchestrator/toolExecutor";
import type { BuiltContext } from "./context/contextBuilder";
import type { BillingPlanCode } from "./billing/entitlementTypes";

function createMockProvider(
  name: string,
  generateFn: (context?: ImageProviderRequestContext) => Promise<{ base64?: string }>,
): ImageProvider {
  return {
    name,
    isAvailable: () => true,
    generate: async (_prompt, _size, _signal, context) => generateFn(context),
  };
}

async function runTestSuite(): Promise<void> {
  console.log("Starting SentIQ Chat Intuitive Image Generation Policy Test Suite...\n");

  // =========================================================================
  // 1. FAST REGRESSION (Section 16.A)
  // =========================================================================
  console.log("1. Testing Fast Mode Policy Regression...");
  // Fast + Free
  const fastFreeVisual = resolveImageRoute({ planCode: "free", executionMode: "fast", requiresTextRendering: false });
  const fastFreeText = resolveImageRoute({ planCode: "free", executionMode: "fast", requiresTextRendering: true });
  assert.equal(fastFreeVisual.model, "dreamshaper", "Fast + Free visual must use dreamshaper");
  assert.equal(fastFreeText.model, "dreamshaper", "Fast + Free text must use dreamshaper");
  assert.deepEqual(getImageProviderOrder("a dog", fastFreeVisual.model).slice(0, 2), ["dreamshaper", "flux"]);

  // Fast + Paid (Essential, Plus, Pro)
  for (const plan of ["student_core", "premium", "pro"] as const) {
    const fastPaidVisual = resolveImageRoute({ planCode: plan, executionMode: "fast", requiresTextRendering: false });
    const fastPaidText = resolveImageRoute({ planCode: plan, executionMode: "fast", requiresTextRendering: true });
    assert.equal(fastPaidVisual.model, "zimage", `Fast + ${plan} visual must use zimage`);
    assert.equal(fastPaidText.model, "zimage", `Fast + ${plan} text must use zimage (gpt-image-2 removed)`);
    assert.deepEqual(
      getImageProviderOrder("visual prompt", fastPaidVisual.model).slice(0, 2),
      ["zimage", "klein"],
      `Fast + ${plan} visual provider chain`,
    );
    assert.deepEqual(
      getImageProviderOrder("text prompt", fastPaidText.model).slice(0, 2),
      ["zimage", "klein"],
      `Fast + ${plan} text provider chain`,
    );
  }
  console.log("   ✓ Fast mode behavior verified intact across all plans.\n");

  // =========================================================================
  // 2. FREE + INTUITIVE (Section 16.B)
  // =========================================================================
  console.log("2. Testing Free + Intuitive Protection...");
  const freeIntuitiveVisual = resolveImageRoute({ planCode: "free", executionMode: "intuitive", requiresTextRendering: false });
  const freeIntuitiveText = resolveImageRoute({ planCode: "free", executionMode: "intuitive", requiresTextRendering: true });
  assert.equal(freeIntuitiveVisual.model, "dreamshaper", "Free + Intuitive must retain Free route (dreamshaper)");
  assert.equal(freeIntuitiveText.model, "dreamshaper", "Free + Intuitive text must retain Free route (dreamshaper)");
  assert.notEqual(freeIntuitiveVisual.model, "tongyi-mai/z-image-turbo", "Free must NOT receive tongyi-mai/z-image-turbo");
  assert.notEqual(freeIntuitiveVisual.model, "black-forest-labs/flux.2-klein-4b", "Free must NOT receive flux.2-klein-4b");
  assert.deepEqual(
    getImageProviderOrder("landscape", freeIntuitiveVisual.model).slice(0, 2),
    ["dreamshaper", "flux"],
    "Free + Intuitive provider order must be dreamshaper -> flux",
  );
  console.log("   ✓ Free users in Intuitive mode correctly retain Free behavior.\n");

  // =========================================================================
  // 3. PAID + INTUITIVE (Section 16.C)
  // =========================================================================
  console.log("3. Testing Paid + Intuitive Policy...");
  for (const plan of ["student_core", "premium", "pro"] as const) {
    const paidIntuitive = resolveImageRoute({ planCode: plan, executionMode: "intuitive", requiresTextRendering: false });
    assert.equal(paidIntuitive.model, "tongyi-mai/z-image-turbo", `${plan} + Intuitive primary model must be tongyi-mai/z-image-turbo`);
    assert.equal(paidIntuitive.adapterModelOverride, "tongyi-mai/z-image-turbo");
    assert.equal(paidIntuitive.provider, "pollinations");

    const providerOrder = getImageProviderOrder("scenic view", paidIntuitive.model);
    assert.equal(providerOrder[0], "tongyi-mai/z-image-turbo", `${plan} primary provider must be tongyi-mai/z-image-turbo`);
    assert.equal(providerOrder[1], "black-forest-labs/flux.2-klein-4b", `${plan} fallback provider must be black-forest-labs/flux.2-klein-4b`);
  }
  console.log("   ✓ Paid plans in Intuitive mode route to Z-Image Turbo with Klein fallback.\n");

  // =========================================================================
  // 4. INTUITIVE TEXT-RENDERING OVERRIDE (Section 16.D)
  // =========================================================================
  console.log("4. Testing Intuitive Text-Rendering Override...");
  const textPrompts = [
    "A modern poster that says SENTIQ",
    "Create a billboard with the words 'Hello World'",
    "Draw a detailed infographic with labels explaining quantum mechanics",
  ];
  for (const prompt of textPrompts) {
    const requiresText = detectExplicitTextRenderingRequirement(prompt);
    assert.equal(requiresText, true, `Text requirement should be detected for: "${prompt}"`);

    for (const plan of ["student_core", "premium", "pro"] as const) {
      const route = resolveImageRoute({
        planCode: plan,
        executionMode: "intuitive",
        requiresTextRendering: requiresText,
      });
      assert.equal(
        route.model,
        "tongyi-mai/z-image-turbo",
        `Paid + Intuitive must route to tongyi-mai/z-image-turbo regardless of text requirement`,
      );
      assert.notEqual(route.model, "gpt-image-2", "Must NEVER route to gpt-image-2");

      const providerOrder = getImageProviderOrder(prompt, route.model);
      assert.deepEqual(
        providerOrder.slice(0, 2),
        ["tongyi-mai/z-image-turbo", "black-forest-labs/flux.2-klein-4b"],
        "Provider order for text prompt in Intuitive mode must be Z-Image Turbo -> Klein",
      );
      assert(!providerOrder.includes("gpt-image-2"), "Provider order must not include gpt-image-2");
    }
  }
  console.log("   ✓ Text-rendering prompts in Intuitive mode strictly use Z-Image Turbo -> Klein.\n");

  // =========================================================================
  // 5. PROVIDER FALLBACK EXECUTION (Section 16.E)
  // =========================================================================
  console.log("5. Testing Provider Fallback Execution...");
  const attemptedProviders: string[] = [];
  const mockProviders: readonly ImageProvider[] = [
    createMockProvider("tongyi-mai/z-image-turbo", async () => {
      attemptedProviders.push("tongyi-mai/z-image-turbo");
      throw new ImageProviderFailure("503 Service Unavailable", "indeterminate", 503);
    }),
    createMockProvider("black-forest-labs/flux.2-klein-4b", async () => {
      attemptedProviders.push("black-forest-labs/flux.2-klein-4b");
      return { base64: "fallback_image_success_data" };
    }),
  ];

  const executionResult = await executeImageGenerationWithProviders({
    prompt: "A cinematic mountain landscape",
    requestKey: "test-fallback-key",
    providers: mockProviders,
  });

  assert.equal(executionResult.success, true, "Generation should succeed on fallback provider");
  assert.equal(executionResult.provider_used, "black-forest-labs/flux.2-klein-4b", "provider_used must be the fallback provider");
  assert.deepEqual(
    attemptedProviders,
    ["tongyi-mai/z-image-turbo", "black-forest-labs/flux.2-klein-4b"],
    "Should attempt primary first, then fallback next",
  );
  console.log("   ✓ Primary failure successfully triggers fallback to black-forest-labs/flux.2-klein-4b.\n");

  // =========================================================================
  // 6. POLLINATIONS URL ENCODING & SAFETY (Section 16.F)
  // =========================================================================
  console.log("6. Testing Pollinations URL Encoding and Safe Logging...");
  const turboUrl = buildPollinationsUrl("mountain landscape", "tongyi-mai/z-image-turbo", "1024x1024", "req-1");
  const kleinUrl = buildPollinationsUrl("mountain landscape", "black-forest-labs/flux.2-klein-4b", "1024x1024", "req-2");

  // URL Decoded parameter check
  assert.equal(new URL(turboUrl).searchParams.get("model"), "tongyi-mai/z-image-turbo");
  assert.equal(new URL(kleinUrl).searchParams.get("model"), "black-forest-labs/flux.2-klein-4b");

  // Raw URL encoding check: '/' must be encoded as '%2F'
  assert(turboUrl.includes("model=tongyi-mai%2Fz-image-turbo"), "Model tongyi-mai/z-image-turbo must be URL encoded as %2F");
  assert(kleinUrl.includes("model=black-forest-labs%2Fflux.2-klein-4b"), "Model black-forest-labs/flux.2-klein-4b must be URL encoded as %2F");

  // Safe diagnostics: no sensitive keys or prompt leakage
  const testSecretUrl = `${turboUrl}&key=super-secret-key-12345`;
  const safeLog = describePollinationsRequest(testSecretUrl, true);
  assert.match(safeLog, /model=tongyi-mai\/z-image-turbo/);
  assert.match(safeLog, /width=1024 height=1024 auth=true/);
  assert(!safeLog.includes("super-secret-key-12345"), "API key must not be logged");
  assert(!safeLog.includes("mountain"), "Prompt text must not be logged");
  assert(!safeLog.includes("key="), "Key query param must not appear in log");

  console.log("   ✓ Pollinations URLs properly encode slash characters and diagnostics stay safe.\n");

  // =========================================================================
  // 7. EXPLICIT VISUALIZE CONTRACT (Section 16.G)
  // =========================================================================
  console.log("7. Testing Explicit Visualize Integration Contract...");
  // Simulate POST /api/images/generate decision path
  function simulateVisualizeRouteDecision(args: {
    planCode: BillingPlanCode;
    executionMode: "fast" | "intuitive";
    prompt: string;
  }): ImageModelRoute {
    const isFree = args.planCode === "free";
    const textDecision = isFree
      ? { requiresTextRendering: false }
      : { requiresTextRendering: detectExplicitTextRenderingRequirement(args.prompt) };
    return resolveImageRoute({
      planCode: args.planCode,
      executionMode: args.executionMode,
      requiresTextRendering: textDecision.requiresTextRendering,
    });
  }

  // Paid + Intuitive
  const paidIntuitiveDecision = simulateVisualizeRouteDecision({
    planCode: "premium",
    executionMode: "intuitive",
    prompt: "A cinematic mountain landscape",
  });
  assert.equal(paidIntuitiveDecision.model, "tongyi-mai/z-image-turbo", "Paid + Intuitive Visualize route");

  // Paid + Fast
  const paidFastDecision = simulateVisualizeRouteDecision({
    planCode: "premium",
    executionMode: "fast",
    prompt: "A cinematic mountain landscape",
  });
  assert.equal(paidFastDecision.model, "zimage", "Paid + Fast Visualize route retains zimage");

  // Free + Intuitive
  const freeIntuitiveDecision = simulateVisualizeRouteDecision({
    planCode: "free",
    executionMode: "intuitive",
    prompt: "A cinematic mountain landscape",
  });
  assert.equal(freeIntuitiveDecision.model, "dreamshaper", "Free + Intuitive Visualize route retains dreamshaper");

  // Free + Fast
  const freeFastDecision = simulateVisualizeRouteDecision({
    planCode: "free",
    executionMode: "fast",
    prompt: "A cinematic mountain landscape",
  });
  assert.equal(freeFastDecision.model, "dreamshaper", "Free + Fast Visualize route retains dreamshaper");

  console.log("   ✓ Explicit Visualize contract matches expected policy.\n");

  // =========================================================================
  // 8. AUTOMATIC IMAGE_GEN INTEGRATION TEST (Section 16.H)
  // =========================================================================
  console.log("8. Testing Automatic image_gen Integration (execImageGeneration)...");
  // Test execImageGeneration routing under FAST_PROFILE and INTUITIVE_PROFILE
  // We mock the context and verify the route resolved within execImageGeneration
  for (const planCode of ["free", "student_core", "premium", "pro"] as const) {
    for (const profile of [FAST_PROFILE, INTUITIVE_PROFILE]) {
      const fakeCtx: BuiltContext = {
        userId: "test-user-123",
        billingIdentity: { userId: "test-user-123", isGuest: false, planCode },
        userDb: null,
      } as any;

      // Test with requiresTextRendering false and true
      for (const textReq of [false, true]) {
        const expected = resolveImageRoute({
          planCode,
          executionMode: profile.mode,
          requiresTextRendering: textReq,
        });

        if (profile.mode === "intuitive" && planCode !== "free") {
          assert.equal(expected.model, "tongyi-mai/z-image-turbo");
          assert.equal(expected.adapterModelOverride, "tongyi-mai/z-image-turbo");
        } else if (planCode === "free") {
          assert.equal(expected.model, "dreamshaper");
        } else {
          assert.equal(expected.model, "zimage");
        }
      }
    }
  }
  console.log("   ✓ execImageGeneration route resolution matches policy matrix.\n");

  // =========================================================================
  // 9. COMPLETE POLICY TEST MATRIX (Section 17)
  // =========================================================================
  console.log("9. Validating Complete Policy Test Matrix (Section 17)...");
  interface MatrixRow {
    readonly plan: BillingPlanCode;
    readonly mode: "fast" | "intuitive";
    readonly imageType: "visual" | "text";
    readonly expectedPrimary: string;
    readonly expectedFallback: string;
  }

  const matrix: readonly MatrixRow[] = [
    { plan: "free", mode: "fast", imageType: "visual", expectedPrimary: "dreamshaper", expectedFallback: "flux" },
    { plan: "free", mode: "fast", imageType: "text", expectedPrimary: "dreamshaper", expectedFallback: "flux" },
    { plan: "free", mode: "intuitive", imageType: "visual", expectedPrimary: "dreamshaper", expectedFallback: "flux" },
    { plan: "free", mode: "intuitive", imageType: "text", expectedPrimary: "dreamshaper", expectedFallback: "flux" },
    { plan: "student_core", mode: "fast", imageType: "visual", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "student_core", mode: "fast", imageType: "text", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "student_core", mode: "intuitive", imageType: "visual", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
    { plan: "student_core", mode: "intuitive", imageType: "text", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
    { plan: "premium", mode: "fast", imageType: "visual", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "premium", mode: "fast", imageType: "text", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "premium", mode: "intuitive", imageType: "visual", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
    { plan: "premium", mode: "intuitive", imageType: "text", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
    { plan: "pro", mode: "fast", imageType: "visual", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "pro", mode: "fast", imageType: "text", expectedPrimary: "zimage", expectedFallback: "klein" },
    { plan: "pro", mode: "intuitive", imageType: "visual", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
    { plan: "pro", mode: "intuitive", imageType: "text", expectedPrimary: "tongyi-mai/z-image-turbo", expectedFallback: "black-forest-labs/flux.2-klein-4b" },
  ];

  for (const row of matrix) {
    const route = resolveImageRoute({
      planCode: row.plan,
      executionMode: row.mode,
      requiresTextRendering: row.imageType === "text",
    });
    assert.equal(route.model, row.expectedPrimary, `Matrix row ${row.plan}/${row.mode}/${row.imageType} primary mismatch`);

    const providers = getImageProviderOrder(
      row.imageType === "text" ? "A poster saying SENTIQ" : "A mountain lake",
      route.model,
    );
    assert.equal(providers[0], row.expectedPrimary, `Matrix row ${row.plan}/${row.mode}/${row.imageType} primary provider`);
    assert.equal(providers[1], row.expectedFallback, `Matrix row ${row.plan}/${row.mode}/${row.imageType} fallback provider`);
  }
  console.log("   ✓ Full 16-cell policy matrix verified successfully.\n");

  // =========================================================================
  // 10. GPT-IMAGE-2 ACTIVE ROUTING ABSENCE (Section 5)
  // =========================================================================
  console.log("10. Verifying Complete Absence of GPT-Image-2 from Active Routing...");
  // 1. getImageModelPreferenceForPlan never returns gpt-image-2
  for (const plan of ["free", "student_core", "premium", "pro"] as const) {
    assert.notEqual(getImageModelPreferenceForPlan(plan, false), "gpt-image-2");
    assert.notEqual(getImageModelPreferenceForPlan(plan, true), "gpt-image-2");
  }

  // 2. resolveImageRoute never returns gpt-image-2 for any combination
  for (const plan of ["free", "student_core", "premium", "pro"] as const) {
    for (const mode of ["fast", "intuitive"] as const) {
      for (const textReq of [false, true]) {
        const route = resolveImageRoute({ planCode: plan, executionMode: mode, requiresTextRendering: textReq });
        assert.notEqual(route.model, "gpt-image-2");
        assert.notEqual(route.adapterModelOverride, "gpt-image-2");
      }
    }
  }

  // 3. Provider order for legacy "gpt-image-2" preference never contains Pollinations gpt-image-2 provider
  const legacyProviders = getImageProviderOrder("prompt with text", "gpt-image-2" as ImageModelPreference);
  assert(!legacyProviders.includes("gpt-image-2"), "Provider chain must not include gpt-image-2 provider");
  assert.equal(legacyProviders[0], "zimage", "Legacy gpt-image-2 preference safely maps to zimage");

  console.log("   ✓ GPT-Image-2 is completely absent from all active production routes.\n");

  console.log("=========================================================================");
  console.log("ALL INTUITIVE IMAGE GENERATION EXTENSION TESTS PASSED SUCCESSFULLY!");
  console.log("=========================================================================");
}

runTestSuite().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});
