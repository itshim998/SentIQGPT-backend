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

function testSettlementAndReleaseCalculations(): void {
  // Pro Fast: reserves 2 credits.
  // Case A: Schnell succeeds -> settles 1 credit, releases 1 credit.
  const reservedProFast = getImageReservationCredits("pro", "fast");
  assert.equal(reservedProFast, 2);
  const actualCostSchnell = getImageModelCreditCost(CLOUDFLARE_MODEL_SCHNELL);
  assert.equal(actualCostSchnell, 1);
  const releasedWhenSchnellSucceeds = reservedProFast - actualCostSchnell;
  assert.equal(releasedWhenSchnellSucceeds, 1);

  // Case B: Schnell fails, Klein 4B succeeds -> settles 2 credits, releases 0 credits.
  const actualCostKlein4B = getImageModelCreditCost(CLOUDFLARE_MODEL_KLEIN_4B);
  assert.equal(actualCostKlein4B, 2);
  const releasedWhenKlein4BSucceeds = reservedProFast - actualCostKlein4B;
  assert.equal(releasedWhenKlein4BSucceeds, 0);

  // Pro Intuitive: reserves 8 credits.
  const reservedProIntuitive = getImageReservationCredits("pro", "intuitive");
  assert.equal(reservedProIntuitive, 8);
  const actualCostGptImage2 = getImageModelCreditCost("openai/gpt-image-2");
  assert.equal(actualCostGptImage2, 8);
  assert.equal(reservedProIntuitive - actualCostGptImage2, 0);

  // Entire failure: releases all reserved credits
  const releasedOnFailure = reservedProIntuitive;
  assert.equal(releasedOnFailure, 8);

  console.log("PASS: Settlement and refund calculations verified.");
}

function main(): void {
  console.log("=== Running Weighted Image Credits & Revised Tiers Policy Suite ===\n");
  testPlanPricingAndQuotas();
  testCreditCostsAndModelRules();
  testEightCellMatrixAndReservations();
  testSettlementAndReleaseCalculations();
  console.log("\nAll Weighted Image Credits tests passed successfully!");
}

main();
