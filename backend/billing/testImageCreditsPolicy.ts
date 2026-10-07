import dotenv from "dotenv";
dotenv.config();

for (const id of [1, 2, 3, 4]) {
  process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
}

import assert from "node:assert/strict";
import { getPlanCatalog } from "./planCatalog";
import {
  getImageModelCreditCost,
  getImageReservationCredits,
  isRetiredKlein9B,
  IMAGE_MODEL_CREDIT_COSTS,
} from "./imageCreditPolicy";
import { resolveImageRoute, getImageModelForPlan } from "./modelEntitlementRouter";
import { getImageProviderOrder } from "../tools/imageGeneration/imageRouter";
import {
  CLOUDFLARE_MODEL_SCHNELL,
  CLOUDFLARE_MODEL_KLEIN_4B,
  CLOUDFLARE_MODEL_DREAMSHAPER,
} from "../tools/imageGeneration/providers/cloudflareImageProvider";

function testPlanPricingAndQuotas(): void {
  const plans = getPlanCatalog();
  const planMap = new Map(plans.map((p) => [p.code, p]));

  // 1. Pricing verification
  assert.equal(planMap.get("free")?.pricePaise, 0, "Free price must be 0 paise");
  assert.equal(planMap.get("student_core")?.pricePaise, 12_900, "Essential price must be 12,900 paise (₹129)");
  assert.equal(planMap.get("premium")?.pricePaise, 29_900, "Plus price must be 29,900 paise (₹299)");
  assert.equal(planMap.get("pro")?.pricePaise, 69_900, "Pro price must be 69,900 paise (₹699)");

  // 2. Quota verification
  const freeQuota = planMap.get("free")?.entitlements.quotas.image_generation;
  assert.deepEqual(freeQuota, {
    limit: 2,
    windowSeconds: 86_400,
    label: "Image credits",
  });

  const essentialQuota = planMap.get("student_core")?.entitlements.quotas.image_generation;
  assert.deepEqual(essentialQuota, {
    limit: 12,
    windowSeconds: 43_200,
    label: "Image credits",
  });

  const plusQuota = planMap.get("premium")?.entitlements.quotas.image_generation;
  assert.deepEqual(plusQuota, {
    limit: 20,
    windowSeconds: 43_200,
    label: "Image credits",
  });

  const proQuota = planMap.get("pro")?.entitlements.quotas.image_generation;
  assert.deepEqual(proQuota, {
    limit: 32,
    windowSeconds: 43_200,
    label: "Image credits",
  });

  console.log("PASS: Plan catalog prices and image credit quotas verified.");
}

function testCreditCostsAndModelRules(): void {
  // Schnell
  assert.equal(getImageModelCreditCost(CLOUDFLARE_MODEL_SCHNELL), 1);
  assert.equal(getImageModelCreditCost("flux-1-schnell"), 1);
  assert.equal(getImageModelCreditCost("schnell"), 1);

  // Dreamshaper
  assert.equal(getImageModelCreditCost(CLOUDFLARE_MODEL_DREAMSHAPER), 1);
  assert.equal(getImageModelCreditCost("dreamshaper"), 1);

  // Klein 4B
  assert.equal(getImageModelCreditCost(CLOUDFLARE_MODEL_KLEIN_4B), 2);
  assert.equal(getImageModelCreditCost("flux-2-klein-4b"), 2);
  assert.equal(getImageModelCreditCost("klein-4b"), 2);

  // Pro Intuitive Pollinations chain
  assert.equal(getImageModelCreditCost("openai/gpt-image-2"), 8);
  assert.equal(getImageModelCreditCost("gpt-image-2"), 8);
  assert.equal(getImageModelCreditCost("microsoft/mai-image-2.6"), 8);
  assert.equal(getImageModelCreditCost("mai-image-2.6"), 8);
  assert.equal(getImageModelCreditCost("black-forest-labs/flux.1.1-pro"), 8);
  assert.equal(getImageModelCreditCost("flux-pro"), 8);

  // Klein 9B retired status
  assert.equal(isRetiredKlein9B("@cf/black-forest-labs/flux-2-klein-9b"), true);
  assert.equal(isRetiredKlein9B("flux-2-klein-9b"), true);
  assert.equal(isRetiredKlein9B("klein-9b"), true);
  assert.equal(isRetiredKlein9B(CLOUDFLARE_MODEL_SCHNELL), false);
  assert.throws(() => getImageModelCreditCost("@cf/black-forest-labs/flux-2-klein-9b"), /retired/i);

  // Unrecognized models throw safely
  assert.throws(() => getImageModelCreditCost("non-existent-provider-model"), /unrecognized/i);

  console.log("PASS: Model credit costs and retirement rules verified.");
}

function testEightCellMatrixAndReservations(): void {
  const cells = [
    // 1. Free Fast
    {
      plan: "free" as const,
      mode: "fast" as const,
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
      expectedReservation: 1,
    },
    // 2. Free Intuitive
    {
      plan: "free" as const,
      mode: "intuitive" as const,
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
      expectedReservation: 1,
    },
    // 3. Essential Fast
    {
      plan: "student_core" as const,
      mode: "fast" as const,
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
      expectedReservation: 2,
    },
    // 4. Essential Intuitive
    {
      plan: "student_core" as const,
      mode: "intuitive" as const,
      expectedPrimary: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
      expectedReservation: 2,
    },
    // 5. Plus Fast
    {
      plan: "premium" as const,
      mode: "fast" as const,
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
      expectedReservation: 2,
    },
    // 6. Plus Intuitive
    {
      plan: "premium" as const,
      mode: "intuitive" as const,
      expectedPrimary: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
      expectedReservation: 2,
    },
    // 7. Pro Fast
    {
      plan: "pro" as const,
      mode: "fast" as const,
      expectedPrimary: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
      expectedReservation: 2,
    },
    // 8. Pro Intuitive
    {
      plan: "pro" as const,
      mode: "intuitive" as const,
      expectedPrimary: "openai/gpt-image-2",
      expectedChain: ["openai/gpt-image-2", "microsoft/mai-image-2.6", "black-forest-labs/flux.1.1-pro"],
      expectedReservation: 8,
    },
  ];

  for (const cell of cells) {
    const route = resolveImageRoute({ planCode: cell.plan, executionMode: cell.mode });
    assert.equal(route.model, cell.expectedPrimary, `${cell.plan}/${cell.mode} primary`);

    const chain = getImageProviderOrder("prompt", route.adapterModelOverride, cell.plan, cell.mode);
    assert.deepEqual(chain, cell.expectedChain, `${cell.plan}/${cell.mode} fallback chain`);

    const reservation = getImageReservationCredits(cell.plan, cell.mode);
    assert.equal(reservation, cell.expectedReservation, `${cell.plan}/${cell.mode} reservation credits`);
  }

  console.log("PASS: 8-cell routing matrix and reservation amounts verified.");
}

import { BillingQuotaService, BillingQuotaError } from "./quotaService";
import type { BillingIdentity } from "./entitlementTypes";

async function testPlanResolutionFailClosed(): Promise<void> {
  // Mock repository with configurable behavior
  class MockBillingRepo {
    constructor(
      private readonly effectivePlan: { plan_code: string; status: string } | null,
      private readonly shouldThrow: boolean = false,
    ) {}

    async getEffectivePlan(_userId: string) {
      if (this.shouldThrow) {
        throw new Error("Database 1 connection timeout");
      }
      return this.effectivePlan;
    }
  }

  // 1. Guest identity always resolves to "free"
  const guestService = new BillingQuotaService(new MockBillingRepo(null, true) as any);
  const guestPlan = await guestService.resolvePlanCodeForImageBilling({
    userId: null,
    anonymousKeyHash: "anon_hash_123",
    isGuest: true,
  });
  assert.equal(guestPlan, "free", "Guest identity must resolve to free without querying DB");

  // 2. Authenticated Free user resolves to "free"
  const freeService = new BillingQuotaService(new MockBillingRepo({ plan_code: "free", status: "free" }) as any);
  const freePlan = await freeService.resolvePlanCodeForImageBilling({
    userId: "user_free_123",
    anonymousKeyHash: null,
    isGuest: false,
  });
  assert.equal(freePlan, "free", "Authenticated free user must resolve to free");

  // 3. Authenticated Paid users resolve to their correct plan codes
  for (const paidCode of ["student_core", "premium", "pro"] as const) {
    const paidService = new BillingQuotaService(new MockBillingRepo({ plan_code: paidCode, status: "active" }) as any);
    const resolved = await paidService.resolvePlanCodeForImageBilling({
      userId: `user_${paidCode}`,
      anonymousKeyHash: null,
      isGuest: false,
    });
    assert.equal(resolved, paidCode, `Authenticated user on ${paidCode} must resolve to ${paidCode}`);
  }

  // 4. CRITICAL: Simulated DB failure MUST throw and FAIL CLOSED, never convert to "free"
  const failingService = new BillingQuotaService(new MockBillingRepo(null, true) as any);
  await assert.rejects(
    async () => {
      await failingService.resolvePlanCodeForImageBilling({
        userId: "user_paid_victim",
        anonymousKeyHash: null,
        isGuest: false,
      });
    },
    /Database 1 connection timeout/,
    "Database failure during image plan resolution must throw and not convert to free",
  );

  // 5. Explicit edge cases: missing, null, empty, unknown, and malformed plan codes MUST fail closed
  const invalidCases = [
    { label: "null plan row", repo: new MockBillingRepo(null, false) },
    { label: "empty string plan_code", repo: new MockBillingRepo({ plan_code: "", status: "active" } as any) },
    { label: "whitespace-only plan_code", repo: new MockBillingRepo({ plan_code: "   ", status: "active" } as any) },
    { label: "unknown plan_code enterprise", repo: new MockBillingRepo({ plan_code: "enterprise", status: "active" } as any) },
    { label: "unknown plan_code unknown", repo: new MockBillingRepo({ plan_code: "unknown", status: "active" } as any) },
    { label: "malformed plan_code FREEE", repo: new MockBillingRepo({ plan_code: "FREEE", status: "active" } as any) },
    { label: "partial plan_code student", repo: new MockBillingRepo({ plan_code: "student", status: "active" } as any) },
    { label: "legacy plan_code premium_plus", repo: new MockBillingRepo({ plan_code: "premium_plus", status: "active" } as any) },
    { label: "non-string plan_code", repo: new MockBillingRepo({ plan_code: 12345 as any, status: "active" } as any) },
  ];

  for (const tc of invalidCases) {
    const service = new BillingQuotaService(tc.repo as any);
    await assert.rejects(
      async () => {
        await service.resolvePlanCodeForImageBilling({
          userId: "user_test_fail_closed",
          anonymousKeyHash: null,
          isGuest: false,
        });
      },
      (err: any) => {
        assert(err instanceof BillingQuotaError, `Expected BillingQuotaError for ${tc.label}`);
        assert.equal(err.code, "plan_resolution_failed", `Expected code plan_resolution_failed for ${tc.label}`);
        assert.equal(err.feature, "image_generation", `Expected feature image_generation for ${tc.label}`);
        return true;
      },
      `Invalid plan case "${tc.label}" must throw BillingQuotaError and fail closed`,
    );
  }

  console.log("PASS: Fail-closed image billing plan resolution verified across all valid and invalid cases.");
}

function testSettlementAndReleaseCalculations(): void {
  // Helper for reservation & settlement simulation
  function simulateSettlement(plan: "free" | "student_core" | "premium" | "pro", mode: "fast" | "intuitive", actualModel: string | null) {
    const reserved = getImageReservationCredits(plan, mode);
    if (!actualModel) {
      // Failure scenario: 0 charged, all reserved released
      return { reserved, settled: 0, released: reserved, charged: 0 };
    }
    const settled = getImageModelCreditCost(actualModel);
    const released = Math.max(0, reserved - settled);
    return { reserved, settled, released, charged: settled };
  }

  // Free Fast/Intuitive: Reserve 1
  assert.deepEqual(simulateSettlement("free", "fast", CLOUDFLARE_MODEL_SCHNELL), { reserved: 1, settled: 1, released: 0, charged: 1 });
  assert.deepEqual(simulateSettlement("free", "fast", CLOUDFLARE_MODEL_DREAMSHAPER), { reserved: 1, settled: 1, released: 0, charged: 1 });
  assert.deepEqual(simulateSettlement("free", "fast", null), { reserved: 1, settled: 0, released: 1, charged: 0 });

  // Essential Fast: Reserve 2
  // Schnell succeeds -> settled: 1, released: 1
  assert.deepEqual(simulateSettlement("student_core", "fast", CLOUDFLARE_MODEL_SCHNELL), { reserved: 2, settled: 1, released: 1, charged: 1 });
  // Schnell fails, Klein 4B succeeds -> settled: 2, released: 0
  assert.deepEqual(simulateSettlement("student_core", "fast", CLOUDFLARE_MODEL_KLEIN_4B), { reserved: 2, settled: 2, released: 0, charged: 2 });
  // Both fail -> 0 charged, 2 released
  assert.deepEqual(simulateSettlement("student_core", "fast", null), { reserved: 2, settled: 0, released: 2, charged: 0 });

  // Essential Intuitive: Reserve 2
  // Klein 4B succeeds -> settled: 2, released: 0
  assert.deepEqual(simulateSettlement("student_core", "intuitive", CLOUDFLARE_MODEL_KLEIN_4B), { reserved: 2, settled: 2, released: 0, charged: 2 });
  // Klein 4B fails, Schnell succeeds -> settled: 1, released: 1
  assert.deepEqual(simulateSettlement("student_core", "intuitive", CLOUDFLARE_MODEL_SCHNELL), { reserved: 2, settled: 1, released: 1, charged: 1 });
  // Both fail -> 0 charged, 2 released
  assert.deepEqual(simulateSettlement("student_core", "intuitive", null), { reserved: 2, settled: 0, released: 2, charged: 0 });

  // Plus Fast / Intuitive corresponding
  assert.deepEqual(simulateSettlement("premium", "fast", CLOUDFLARE_MODEL_SCHNELL), { reserved: 2, settled: 1, released: 1, charged: 1 });
  assert.deepEqual(simulateSettlement("premium", "fast", CLOUDFLARE_MODEL_KLEIN_4B), { reserved: 2, settled: 2, released: 0, charged: 2 });
  assert.deepEqual(simulateSettlement("premium", "intuitive", CLOUDFLARE_MODEL_KLEIN_4B), { reserved: 2, settled: 2, released: 0, charged: 2 });
  assert.deepEqual(simulateSettlement("premium", "intuitive", CLOUDFLARE_MODEL_SCHNELL), { reserved: 2, settled: 1, released: 1, charged: 1 });

  // Pro Fast: Reserve 2
  assert.deepEqual(simulateSettlement("pro", "fast", CLOUDFLARE_MODEL_SCHNELL), { reserved: 2, settled: 1, released: 1, charged: 1 });
  assert.deepEqual(simulateSettlement("pro", "fast", CLOUDFLARE_MODEL_KLEIN_4B), { reserved: 2, settled: 2, released: 0, charged: 2 });

  // Pro Intuitive: Reserve 8
  assert.deepEqual(simulateSettlement("pro", "intuitive", "openai/gpt-image-2"), { reserved: 8, settled: 8, released: 0, charged: 8 });
  assert.deepEqual(simulateSettlement("pro", "intuitive", "microsoft/mai-image-2.6"), { reserved: 8, settled: 8, released: 0, charged: 8 });
  assert.deepEqual(simulateSettlement("pro", "intuitive", "black-forest-labs/flux.1.1-pro"), { reserved: 8, settled: 8, released: 0, charged: 8 });
  assert.deepEqual(simulateSettlement("pro", "intuitive", null), { reserved: 8, settled: 0, released: 8, charged: 0 });

  console.log("PASS: Comprehensive fallback settlement and release verified across all tiers.");
}

async function main(): Promise<void> {
  console.log("=== Running Weighted Image Credits & Revised Tiers Policy Suite ===\n");
  testPlanPricingAndQuotas();
  testCreditCostsAndModelRules();
  testEightCellMatrixAndReservations();
  await testPlanResolutionFailClosed();
  testSettlementAndReleaseCalculations();
  console.log("\nAll Weighted Image Credits tests passed successfully!");
}

main().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
