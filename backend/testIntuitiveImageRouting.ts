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
import {
  CLOUDFLARE_MODEL_SCHNELL,
  CLOUDFLARE_MODEL_KLEIN_4B,
  CLOUDFLARE_MODEL_DREAMSHAPER,
} from "./tools/imageGeneration/providers/cloudflareImageProvider";
import { detectExplicitTextRenderingRequirement } from "./tools/imageGeneration/imageTextRenderingDecision";
import { FAST_PROFILE, INTUITIVE_PROFILE } from "./orchestrator/executionProfile";
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
  // 1. FAST MODE POLICY MATRIX
  // =========================================================================
  console.log("1. Testing Fast Mode Policy Matrix...");
  // Fast + Free
  const fastFreeVisual = resolveImageRoute({ planCode: "free", executionMode: "fast", requiresTextRendering: false });
  const fastFreeText = resolveImageRoute({ planCode: "free", executionMode: "fast", requiresTextRendering: true });
  assert.equal(fastFreeVisual.model, CLOUDFLARE_MODEL_SCHNELL, "Fast + Free visual must use Schnell");
  assert.equal(fastFreeText.model, CLOUDFLARE_MODEL_SCHNELL, "Fast + Free text must use Schnell");
  assert.deepEqual(
    getImageProviderOrder("a dog", fastFreeVisual.model, "free", "fast").slice(0, 2),
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
  );

  // Fast + Essential (student_core)
  const fastEssential = resolveImageRoute({ planCode: "student_core", executionMode: "fast" });
  assert.equal(fastEssential.model, CLOUDFLARE_MODEL_SCHNELL);
  assert.deepEqual(
    getImageProviderOrder("visual prompt", fastEssential.model, "student_core", "fast").slice(0, 2),
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
  );

  // Fast + Plus (premium)
  const fastPlus = resolveImageRoute({ planCode: "premium", executionMode: "fast" });
  assert.equal(fastPlus.model, CLOUDFLARE_MODEL_SCHNELL);
  assert.deepEqual(
    getImageProviderOrder("visual prompt", fastPlus.model, "premium", "fast").slice(0, 2),
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
  );

  // Fast + Pro
  const fastPro = resolveImageRoute({ planCode: "pro", executionMode: "fast" });
  assert.equal(fastPro.model, CLOUDFLARE_MODEL_SCHNELL);
  assert.deepEqual(
    getImageProviderOrder("visual prompt", fastPro.model, "pro", "fast").slice(0, 2),
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
  );
  console.log("   ✓ Fast mode behavior verified intact across all plans.\n");

  // =========================================================================
  // 2. FREE + INTUITIVE (PROTECTION AGAINST PAID MODELS & POLLINATIONS)
  // =========================================================================
  console.log("2. Testing Free + Intuitive Protection...");
  const freeIntuitiveVisual = resolveImageRoute({ planCode: "free", executionMode: "intuitive", requiresTextRendering: false });
  const freeIntuitiveText = resolveImageRoute({ planCode: "free", executionMode: "intuitive", requiresTextRendering: true });
  assert.equal(freeIntuitiveVisual.model, CLOUDFLARE_MODEL_SCHNELL, "Free + Intuitive must use Schnell");
  assert.equal(freeIntuitiveText.model, CLOUDFLARE_MODEL_SCHNELL, "Free + Intuitive text must use Schnell");
  assert.notEqual(freeIntuitiveVisual.model, "openai/gpt-image-2", "Free must NOT receive Pollinations");
  assert.equal(freeIntuitiveVisual.provider, "cloudflare");

  const freeIntuitiveOrder = getImageProviderOrder("landscape", freeIntuitiveVisual.model, "free", "intuitive");
  assert.deepEqual(
    freeIntuitiveOrder.slice(0, 2),
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
    "Free + Intuitive provider order must be Schnell -> Dreamshaper",
  );
  assert(!freeIntuitiveOrder.some((p) => p.includes("pollinations") || p.includes("gpt-image-2")), "Free must never reach Pollinations");
  console.log("   ✓ Free users in Intuitive mode correctly retain Free Cloudflare behavior.\n");

  // =========================================================================
  // 3. PAID + INTUITIVE POLICY
  // =========================================================================
  console.log("3. Testing Paid + Intuitive Policy...");
  // Essential Intuitive: Klein 4B -> Schnell
  const essentialIntuitive = resolveImageRoute({ planCode: "student_core", executionMode: "intuitive" });
  assert.equal(essentialIntuitive.model, CLOUDFLARE_MODEL_KLEIN_4B);
  assert.equal(essentialIntuitive.provider, "cloudflare");
  assert.deepEqual(
    getImageProviderOrder("scenic", essentialIntuitive.model, "student_core", "intuitive").slice(0, 2),
    [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
  );

  // Plus Intuitive: Klein 4B -> Schnell
  const plusIntuitive = resolveImageRoute({ planCode: "premium", executionMode: "intuitive" });
  assert.equal(plusIntuitive.model, CLOUDFLARE_MODEL_KLEIN_4B);
  assert.equal(plusIntuitive.provider, "cloudflare");
  assert.deepEqual(
    getImageProviderOrder("scenic", plusIntuitive.model, "premium", "intuitive").slice(0, 2),
    [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
  );

  // Pro Intuitive: Pollinations GPT-Image-2 -> MAI-Image-2.6 -> FLUX 1.1 Pro
  const proIntuitive = resolveImageRoute({ planCode: "pro", executionMode: "intuitive" });
  assert.equal(proIntuitive.model, "openai/gpt-image-2");
  assert.equal(proIntuitive.provider, "pollinations");
  const proIntuitiveOrder = getImageProviderOrder("scenic", proIntuitive.model, "pro", "intuitive");
  assert.deepEqual(
    proIntuitiveOrder.slice(0, 3),
    ["openai/gpt-image-2", "microsoft/mai-image-2.6", "black-forest-labs/flux.1.1-pro"],
  );
  assert(!proIntuitiveOrder.some((p) => p.startsWith("@cf/")), "Pro Intuitive must never reach Cloudflare");
  console.log("   ✓ Paid plans in Intuitive mode match the exact policy.\n");

  // =========================================================================
  // 4. INTUITIVE TEXT-RENDERING OVERRIDE PREVENTED
  // =========================================================================
  console.log("4. Testing Text-Rendering Non-Override...");
  const textPrompts = [
    "A modern poster that says SENTIQ",
    "Create a billboard with the words 'Hello World'",
    "Draw a detailed infographic with labels explaining quantum mechanics",
  ];
  for (const prompt of textPrompts) {
    const requiresText = detectExplicitTextRenderingRequirement(prompt);
    assert.equal(requiresText, true, `Text requirement should be detected for: "${prompt}"`);

    // Essential and Plus must never switch to GPT-Image-2
    const essentialRoute = resolveImageRoute({ planCode: "student_core", executionMode: "intuitive", requiresTextRendering: requiresText });
    assert.equal(essentialRoute.model, CLOUDFLARE_MODEL_KLEIN_4B);
    assert.notEqual(essentialRoute.model, "openai/gpt-image-2");

    const plusRoute = resolveImageRoute({ planCode: "premium", executionMode: "intuitive", requiresTextRendering: requiresText });
    assert.equal(plusRoute.model, CLOUDFLARE_MODEL_KLEIN_4B);
    assert.notEqual(plusRoute.model, "openai/gpt-image-2");

    // Pro Fast must never switch to GPT-Image-2
    const proFastRoute = resolveImageRoute({ planCode: "pro", executionMode: "fast", requiresTextRendering: requiresText });
    assert.equal(proFastRoute.model, CLOUDFLARE_MODEL_SCHNELL);
    assert.notEqual(proFastRoute.model, "openai/gpt-image-2");
  }
  console.log("   ✓ Text-rendering prompts cannot override plan entitlement.\n");

  // =========================================================================
  // 5. PROVIDER FALLBACK EXECUTION (MOCKED)
  // =========================================================================
  console.log("5. Testing Provider Fallback Execution...");
  const attemptedProviders: string[] = [];
  const mockProviders: readonly ImageProvider[] = [
    createMockProvider(CLOUDFLARE_MODEL_SCHNELL, async () => {
      attemptedProviders.push(CLOUDFLARE_MODEL_SCHNELL);
      throw new ImageProviderFailure("503 Service Unavailable", "indeterminate", 503);
    }),
    createMockProvider(CLOUDFLARE_MODEL_KLEIN_4B, async () => {
      attemptedProviders.push(CLOUDFLARE_MODEL_KLEIN_4B);
      return { base64: "fallback_image_success_data" };
    }),
  ];

  const executionResult = await executeImageGenerationWithProviders({
    prompt: "A cinematic mountain landscape",
    requestKey: "test-fallback-key",
    providers: mockProviders,
  });

  assert.equal(executionResult.success, true, "Generation should succeed on fallback provider");
  assert.equal(executionResult.provider_used, CLOUDFLARE_MODEL_KLEIN_4B, "provider_used must be fallback provider");
  assert.deepEqual(
    attemptedProviders,
    [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    "Should attempt primary first, then fallback next",
  );
  console.log("   ✓ Primary failure successfully triggers fallback to next model in chain.\n");

  // =========================================================================
  // 6. POLLINATIONS URL ENCODING & SAFETY FOR PRO INTUITIVE
  // =========================================================================
  console.log("6. Testing Pollinations URL Encoding and Safe Logging...");
  const gptUrl = buildPollinationsUrl("mountain landscape", "openai/gpt-image-2", "1024x1024", "req-1");
  const maiUrl = buildPollinationsUrl("mountain landscape", "microsoft/mai-image-2.6", "1024x1024", "req-2");
  const fluxProUrl = buildPollinationsUrl("mountain landscape", "black-forest-labs/flux.1.1-pro", "1024x1024", "req-3");

  assert.equal(new URL(gptUrl).searchParams.get("model"), "openai/gpt-image-2");
  assert.equal(new URL(maiUrl).searchParams.get("model"), "microsoft/mai-image-2.6");
  assert.equal(new URL(fluxProUrl).searchParams.get("model"), "black-forest-labs/flux.1.1-pro");

  assert(gptUrl.includes("model=openai%2Fgpt-image-2"), "Model openai/gpt-image-2 must be URL encoded as %2F");
  assert(maiUrl.includes("model=microsoft%2Fmai-image-2.6"), "Model microsoft/mai-image-2.6 must be URL encoded as %2F");

  const testSecretUrl = `${gptUrl}&key=super-secret-key-12345`;
  const safeLog = describePollinationsRequest(testSecretUrl, true);
  assert.match(safeLog, /model=openai\/gpt-image-2/);
  assert.match(safeLog, /width=1024 height=1024 auth=true/);
  assert(!safeLog.includes("super-secret-key-12345"), "API key must not be logged");
  assert(!safeLog.includes("mountain"), "Prompt text must not be logged");
  assert(!safeLog.includes("key="), "Key query param must not appear in log");
  console.log("   ✓ Pollinations URLs properly encode slash characters and diagnostics stay safe.\n");

  // =========================================================================
  // 7. COMPLETE POLICY TEST MATRIX (ALL 8 CELLS)
  // =========================================================================
  console.log("7. Validating Complete 8-Cell Policy Matrix...");
  interface MatrixRow {
    readonly plan: BillingPlanCode;
    readonly mode: "fast" | "intuitive";
    readonly expectedProvider: "cloudflare" | "pollinations";
    readonly expectedPrimary: string;
    readonly expectedFallbackChain: readonly string[];
  }

  const matrix: readonly MatrixRow[] = [
    // 1. Free Fast
    {
      plan: "free",
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedFallbackChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
    },
    // 2. Free Intuitive
    {
      plan: "free",
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedFallbackChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
    },
    // 3. Essential Fast
    {
      plan: "student_core",
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedFallbackChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    // 4. Essential Intuitive
    {
      plan: "student_core",
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedFallbackChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
    },
    // 5. Plus Fast
    {
      plan: "premium",
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedFallbackChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    // 6. Plus Intuitive
    {
      plan: "premium",
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedFallbackChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
    },
    // 7. Pro Fast
    {
      plan: "pro",
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedFallbackChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    // 8. Pro Intuitive
    {
      plan: "pro",
      mode: "intuitive",
      expectedProvider: "pollinations",
      expectedPrimary: "openai/gpt-image-2",
      expectedFallbackChain: ["openai/gpt-image-2", "microsoft/mai-image-2.6", "black-forest-labs/flux.1.1-pro"],
    },
  ];

  for (const row of matrix) {
    const route = resolveImageRoute({
      planCode: row.plan,
      executionMode: row.mode,
    });
    assert.equal(route.provider, row.expectedProvider, `${row.plan}/${row.mode} provider`);
    assert.equal(route.model, row.expectedPrimary, `${row.plan}/${row.mode} primary model`);

    const providers = getImageProviderOrder(
      "A scenic mountain lake",
      route.adapterModelOverride,
      row.plan,
      row.mode,
    );
    assert.deepEqual(providers, row.expectedFallbackChain, `${row.plan}/${row.mode} fallback chain`);
  }
  console.log("   ✓ Full 8-cell policy matrix verified successfully.\n");

  // =========================================================================
  // 8. POLICY ISOLATION VERIFICATION
  // =========================================================================
  console.log("8. Verifying Strict Provider Isolation...");
  // Free, Essential, Plus, Pro Fast must never contain Pollinations in their provider list
  const nonProIntuitiveConfigs: Array<{ plan: BillingPlanCode; mode: "fast" | "intuitive" }> = [
    { plan: "free", mode: "fast" },
    { plan: "free", mode: "intuitive" },
    { plan: "student_core", mode: "fast" },
    { plan: "student_core", mode: "intuitive" },
    { plan: "premium", mode: "fast" },
    { plan: "premium", mode: "intuitive" },
    { plan: "pro", mode: "fast" },
  ];

  for (const cfg of nonProIntuitiveConfigs) {
    const route = resolveImageRoute({ planCode: cfg.plan, executionMode: cfg.mode });
    assert.equal(route.provider, "cloudflare", `${cfg.plan}/${cfg.mode} must have provider=cloudflare`);
    const chain = getImageProviderOrder("test prompt", route.model, cfg.plan, cfg.mode);
    for (const p of chain) {
      assert(!p.startsWith("openai/") && !p.startsWith("microsoft/") && !p.includes("pollinations"), `${cfg.plan}/${cfg.mode} chain contains Pollinations provider: ${p}`);
      assert(p.startsWith("@cf/"), `${cfg.plan}/${cfg.mode} provider must be Cloudflare: ${p}`);
    }
  }

  // Pro Intuitive must never contain Cloudflare in its provider list
  const proIntuitiveRoute = resolveImageRoute({ planCode: "pro", executionMode: "intuitive" });
  assert.equal(proIntuitiveRoute.provider, "pollinations", "Pro Intuitive must have provider=pollinations");
  const proChain = getImageProviderOrder("test prompt", proIntuitiveRoute.model, "pro", "intuitive");
  for (const p of proChain) {
    assert(!p.startsWith("@cf/"), `Pro Intuitive chain contains Cloudflare provider: ${p}`);
  }

  console.log("   ✓ Provider isolation strictly verified.\n");

  console.log("=========================================================================");
  console.log("ALL INTUITIVE IMAGE GENERATION EXTENSION TESTS PASSED SUCCESSFULLY!");
  console.log("=========================================================================");
}

runTestSuite().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});
