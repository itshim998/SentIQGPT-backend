import { getPlanCatalog } from "./planCatalog";
import { getImageModelForPlan, getLiteTextRoute, getPremiumTextRoute } from "./modelEntitlementRouter";
import { createHmac } from "crypto";
import { readFileSync } from "fs";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), message);
}

function ensureTestSupabaseEnv() {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
}

function testPlanCatalog() {
  const planPriceEnvNames = [
    "SENTIQ_PLAN_FREE_PRICE_PAISE",
    "SENTIQ_PLAN_STUDENT_CORE_PRICE_PAISE",
    "SENTIQ_PLAN_PREMIUM_PRICE_PAISE",
    "SENTIQ_PLAN_PRO_PRICE_PAISE",
  ];
  const previousPlanPrices = new Map(planPriceEnvNames.map((name) => [name, process.env[name]]));
  for (const name of planPriceEnvNames) delete process.env[name];

  let plans;
  try {
    plans = getPlanCatalog();
  } finally {
    for (const [name, value] of previousPlanPrices) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert(plans.length === 4, "expected exactly four default billing plans");
  const expectedPlans = [
    {
      code: "free",
      name: "Free",
      description: "A straightforward way to get started, with clear rolling limits.",
      pricePaise: 0,
    },
    {
      code: "student_core",
      name: "Essential",
      description: "Balanced access for regular, everyday use.",
      pricePaise: 9_900,
    },
    {
      code: "premium",
      name: "Plus",
      description: "Expanded limits for frequent and more involved workflows.",
      pricePaise: 24_900,
    },
    {
      code: "pro",
      name: "Pro",
      description: "Our highest limits for sustained, demanding use.",
      pricePaise: 54_900,
    },
  ] as const;
  expectedPlans.forEach((expected, index) => {
    const actual = plans[index];
    assert(actual?.code === expected.code, `plan ${index + 1} should use code ${expected.code}`);
    assert(actual?.name === expected.name, `${expected.code} should use public name ${expected.name}`);
    assert(actual?.description === expected.description, `${expected.code} should use the exact public description`);
    assert(actual?.pricePaise === expected.pricePaise, `${expected.code} default price should remain unchanged`);
  });

  for (const plan of plans) {
    assert(plan.entitlements.quotas.premium_text.limit >= 0, `${plan.code} missing premium_text quota`);
    assert(plan.entitlements.quotas.lite_text.limit >= 0, `${plan.code} missing lite_text quota`);
    assert(plan.entitlements.quotas.image_generation.limit >= 0, `${plan.code} missing image_generation quota`);
  }

  const premium = getPremiumTextRoute();
  const lite = getLiteTextRoute();
  const image = getImageModelForPlan("premium", true);
  assert(premium.safeModelLabel === "Standard", "premium route must expose safe Standard label");
  assert(lite.safeModelLabel === "Lite", "lite route must expose safe Lite label");
  assert(image.safeModelLabel === "Precision Image", "text-image route must expose safe Precision Image label");
}

function testMigrationSafety() {
  const migration = readFileSync("supabase/migrations/20260604120000_billing_plans_usage_and_subscriptions.sql", "utf8");
  assertIncludes(migration, "pg_advisory_xact_lock", "reserve_usage must serialize identity+feature quota checks");
  assertIncludes(migration, "user_subscriptions_gateway_subscription_unique", "subscription upsert conflict target needs a matching unique constraint");
  assertIncludes(migration, "'canceling'", "cancel-at-period-end status must be supported by the database");
  assertIncludes(migration, "subscription.status = 'canceling'", "canceling subscriptions must remain effective until period end only");
}

function testRouteSafetySource() {
  const routes = readFileSync("backend/billing/billingRoutes.ts", "utf8");
  const server = readFileSync("backend/server.ts", "utf8");
  assertIncludes(routes, "SENTIQ_BILLING_ALLOW_PERMANENT_MANUAL_GRANTS", "paid permanent manual grants must require explicit env opt-in");
  assertIncludes(routes, "manual_grant_expiry_required", "manual grant expiry failures should be explicit");
  assertIncludes(server, 'originalUrl.startsWith("/api/billing/webhook/razorpay")', "Razorpay raw body capture should survive query strings");
  const guestBranchIndex = server.indexOf("console.log(`[Latency] guest user query received`)");
  const guestReasoningIndex = server.indexOf("if (isBufferedReasoning)", guestBranchIndex);
  const guestMathReservationIndex = server.indexOf("const guestMathReservation = await reserveAdvancedBilling", guestReasoningIndex);
  const nextFlushIndex = server.indexOf("res.flushHeaders();", guestReasoningIndex);
  assert(guestReasoningIndex >= 0 && guestMathReservationIndex > guestReasoningIndex, "guest math streaming reservation should exist");
  assert(nextFlushIndex < 0 || guestMathReservationIndex < nextFlushIndex, "guest reasoning streaming must reserve before direct SSE header flush");
}

async function testRazorpayWebhookSafety() {
  ensureTestSupabaseEnv();
  const { RazorpayProvider } = await import("./paymentProviders/razorpayProvider");
  const upserts: any[] = [];
  const provider = new RazorpayProvider({
    recordBillingEvent: async () => ({ duplicate: false }),
    upsertGatewaySubscription: async (args: any) => {
      upserts.push(args);
      return { id: "row-subscription" };
    },
  } as any);

  await provider.handleWebhook({
    id: "evt_subscription_charged",
    event: "subscription.charged",
    payload: {
      payment: {
        entity: {
          id: "pay_should_not_be_used",
          status: "captured",
          notes: {
            sentiq_user_id: "11111111-1111-1111-1111-111111111111",
            sentiq_plan_code: "pro",
          },
        },
      },
      subscription: {
        entity: {
          id: "sub_expected",
          status: "authenticated",
          plan_id: "plan_pro",
          customer_id: "cust_expected",
          current_start: 1780000000,
          current_end: 1782600000,
          notes: {
            sentiq_user_id: "11111111-1111-1111-1111-111111111111",
            sentiq_plan_code: "pro",
          },
        },
      },
    },
  });

  assert(upserts.length === 1, "valid subscription webhook should upsert exactly one subscription");
  assert(upserts[0].gatewaySubscriptionId === "sub_expected", "webhook must prefer subscription entity over payment entity");
  assert(upserts[0].status === "active", "charged/authenticated Razorpay subscription should map to active");
  assert(upserts[0].planCode === "pro", "webhook must use the signed subscription plan note");

  const duplicateUpserts: any[] = [];
  const duplicateProvider = new RazorpayProvider({
    recordBillingEvent: async () => ({ duplicate: true }),
    upsertGatewaySubscription: async (args: any) => {
      duplicateUpserts.push(args);
      return { id: "duplicate" };
    },
  } as any);
  await duplicateProvider.handleWebhook({
    id: "evt_duplicate",
    event: "subscription.charged",
    payload: { subscription: { entity: { id: "sub_duplicate" } } },
  });
  assert(duplicateUpserts.length === 0, "duplicate Razorpay webhooks must not mutate subscription state");
}

async function testRazorpaySignatureVerification() {
  ensureTestSupabaseEnv();
  const { RazorpayProvider } = await import("./paymentProviders/razorpayProvider");
  const previousSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = "test_razorpay_secret";
  try {
    const provider = new RazorpayProvider({} as any);
    const payload = {
      razorpay_payment_id: "pay_123",
      razorpay_subscription_id: "sub_123",
    };
    const signature = createHmac("sha256", "test_razorpay_secret")
      .update(`${payload.razorpay_payment_id}|${payload.razorpay_subscription_id}`)
      .digest("hex");
    const valid = await provider.verifyCheckout({ ...payload, razorpay_signature: signature });
    assert(valid.verified === true, "valid Razorpay checkout signature should verify");
    const invalid = await provider.verifyCheckout({ ...payload, razorpay_signature: "bad" });
    assert(invalid.verified === false, "invalid Razorpay checkout signature must fail");
  } finally {
    if (previousSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = previousSecret;
  }
}

async function main() {
  testPlanCatalog();
  testMigrationSafety();
  testRouteSafetySource();
  await testRazorpayWebhookSafety();
  await testRazorpaySignatureVerification();
  console.log("Billing quota and payment safety checks passed.");
}

main().catch((error) => {
  console.error(`Billing quota test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
