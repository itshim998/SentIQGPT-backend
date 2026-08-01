import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getPlanCatalog,
  TEXT_TOKEN_PLAN_POLICY,
  TEXT_TOKEN_POLICY_VERSION,
} from "./planCatalog";
import type { BillableFeature } from "./entitlementTypes";
import {
  applyAffordableTokenCeiling,
  getTokenAllowanceAccounting,
  recordSuccessfulModelUsage,
  runWithRequestBudgetContext,
} from "../context/requestBudgetContext";

const repoRoot = resolve(__dirname, "../..");
const migration = readFileSync(
  resolve(repoRoot, "supabase/migrations/20260718120000_standard_lite_token_allowances.sql"),
  "utf8",
);
const billingRoutesSource = readFileSync(resolve(repoRoot, "backend/billing/billingRoutes.ts"), "utf8");
const billingPanelSource = readFileSync(resolve(repoRoot, "frontend/scripts/panels/billing-panel.js"), "utf8");
const llmServiceSource = readFileSync(resolve(repoRoot, "backend/llm_service.py"), "utf8");
let BillingQuotaServiceCtor: typeof import("./quotaService").BillingQuotaService;

class FakeRepository {
  commits: Array<Record<string, any>> = [];
  releases: string[] = [];

  async reserveUsage(args: { feature: BillableFeature; units: number }): Promise<any> {
    return {
      reserved: true,
      idempotent: false,
      plan_code: "free",
      limit: args.feature === "premium_text" ? 25_000 : 50_000,
      remaining: 9_000,
      reservation_units: 10_000,
      window_identity: `window-${args.feature}`,
    };
  }

  async commitReservation(args: Record<string, any>) {
    this.commits.push(args);
    return { committed: true, idempotent: false };
  }

  async releaseReservation(requestId: string) {
    this.releases.push(requestId);
    return { released: true, idempotent: false };
  }
}

class FakeAtomicRepository extends FakeRepository {
  private remaining = 1_000;
  private chain = Promise.resolve();

  override async reserveUsage(args: { feature: BillableFeature; units: number }): Promise<any> {
    let result: Record<string, any> = {};
    this.chain = this.chain.then(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
      const reservationUnits = Math.min(args.units, this.remaining);
      if (reservationUnits < 256) {
        result = { reserved: false, plan_code: "free", limit: 1_000, remaining: this.remaining };
        return;
      }
      this.remaining -= reservationUnits;
      result = {
        reserved: true,
        plan_code: "free",
        limit: 1_000,
        remaining: this.remaining,
        reservation_units: reservationUnits,
        window_identity: "concurrent-window",
      };
    });
    await this.chain;
    return result;
  }
}

const standardRoute = {
  feature: "premium_text" as const,
  provider: "test",
  model: "test",
  adapterModelOverride: "test",
  safeModelLabel: "Standard",
  route: "standard" as const,
};

async function settleFixture(args: {
  requestId: string;
  feature?: "premium_text" | "lite_text";
  calls: readonly { prompt: string; output: string; input?: number; outputTokens?: number }[];
}) {
  const repository = new FakeRepository();
  const service = new BillingQuotaServiceCtor(repository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      const reservation = await service.reserveFeature({
        identity: { userId: "00000000-0000-0000-0000-000000000001", anonymousKeyHash: null, isGuest: false },
        feature: args.feature ?? "premium_text",
        requestId: args.requestId,
        route: {
          ...standardRoute,
          feature: args.feature === "lite_text" ? "lite_text" as const : "premium_text" as const,
          route: args.feature === "lite_text" ? "lite" as const : "standard" as const,
        },
      });
      for (const call of args.calls) {
        recordSuccessfulModelUsage({
          prompt: call.prompt,
          output: call.output,
          reportedInputTokens: call.input,
          reportedOutputTokens: call.outputTokens,
        });
      }
      await service.commit(reservation, { fixture: true });
    },
  );
  return repository;
}

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
  BillingQuotaServiceCtor = (await import("./quotaService")).BillingQuotaService;
  assert.deepEqual(TEXT_TOKEN_PLAN_POLICY, {
    free: { standardTokens: 25_000, liteTokens: 50_000 },
    student_core: { standardTokens: 100_000, liteTokens: 175_000 },
    premium: { standardTokens: 180_000, liteTokens: 325_000 },
    pro: { standardTokens: 300_000, liteTokens: 550_000 },
  });
  assert.equal(TEXT_TOKEN_POLICY_VERSION, "standard-lite-tokens-v1");

  const plans = getPlanCatalog();
  assert.deepEqual(plans.map((plan) => plan.name), ["Free", "Essential", "Plus", "Pro"]);
  assert.deepEqual(plans.map((plan) => plan.pricePaise), [0, 9_900, 24_900, 54_900]);
  assert.deepEqual(plans.map((plan) => plan.entitlements.quotas.image_generation.limit), [2, 4, 8, 16]);
  assert.deepEqual(plans.map((plan) => plan.entitlements.quotas.deep_research.limit), [7, 15, 30, 50]);
  assert.deepEqual(plans.map((plan) => plan.entitlements.quotas.advanced_reasoning.limit), [0, 3, 8, 20]);
  assert(plans.every((plan) => plan.entitlements.quotas.premium_text.label === "Standard tokens"));
  assert(plans.every((plan) => plan.entitlements.quotas.lite_text.label === "Lite tokens"));
  assert(!plans.some((plan) => /student core|for students|student workflows|heavier student/i.test(`${plan.name} ${plan.description}`)));

  const standard = await settleFixture({
    requestId: "standard-turn",
    calls: [{ prompt: "A short prompt", output: "A short answer", input: 40, outputTokens: 20 }],
  });
  assert.equal(standard.commits[0].metadata.actual_token_units, 60);
  assert.equal(standard.commits[0].metadata.input_tokens, 40);
  assert.equal(standard.commits[0].metadata.output_tokens, 20);

  const lite = await settleFixture({
    requestId: "lite-turn",
    feature: "lite_text",
    calls: [{ prompt: "Lite input", output: "Lite output", input: 25, outputTokens: 15 }],
  });
  assert.equal(lite.commits[0].metadata.actual_token_units, 40);

  const multiCall = await settleFixture({
    requestId: "pdf-turn",
    calls: [
      { prompt: "Select the PDF tool", output: "file_gen", input: 80, outputTokens: 10 },
      { prompt: "Create the document", output: "x".repeat(12_000), input: 500, outputTokens: 4_000 },
      { prompt: "Repair the document once", output: "x".repeat(3_000), input: 300, outputTokens: 1_000 },
    ],
  });
  assert.equal(multiCall.commits[0].metadata.actual_token_units, 5_890);
  assert.equal(multiCall.commits[0].metadata.successful_model_calls, 3);
  assert.equal(multiCall.commits[0].metadata.usage_reported_calls, 3);
  assert(multiCall.commits[0].metadata.actual_token_units > standard.commits[0].metadata.actual_token_units);

  const failedRepository = new FakeRepository();
  const failedService = new BillingQuotaServiceCtor(failedRepository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      const reservation = await failedService.reserveFeature({
        identity: { userId: "00000000-0000-0000-0000-000000000002", anonymousKeyHash: null, isGuest: false },
        feature: "premium_text",
        requestId: "failed-pdf",
        route: standardRoute,
      });
      assert.equal(getTokenAllowanceAccounting(reservation.requestId)?.successfulCalls, 0);
      await failedService.commit(reservation, { outcome: "failed" });
    },
  );
  assert.equal(failedRepository.commits.length, 0);
  assert.deepEqual(failedRepository.releases, ["failed-pdf"]);

  const estimated = await settleFixture({
    requestId: "estimated-turn",
    calls: [{ prompt: "Estimate this input", output: "Estimate this generated output" }],
  });
  assert.equal(estimated.commits[0].metadata.usage_estimated_calls, 1);
  assert(estimated.commits[0].metadata.input_tokens > 0);
  assert(estimated.commits[0].metadata.output_tokens > 0);

  const ceilingRepository = new FakeRepository();
  const ceilingService = new BillingQuotaServiceCtor(ceilingRepository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      await ceilingService.reserveFeature({
        identity: { userId: "00000000-0000-0000-0000-000000000003", anonymousKeyHash: null, isGuest: false },
        feature: "premium_text",
        requestId: "affordable-ceiling",
        route: standardRoute,
      });
      const affordable = applyAffordableTokenCeiling("A compact prompt", 50_000);
      assert(affordable > 0 && affordable < 10_000);
    },
  );

  const atomicRepository = new FakeAtomicRepository();
  const atomicService = new BillingQuotaServiceCtor(atomicRepository as any);
  const concurrent = await Promise.allSettled(["concurrent-a", "concurrent-b"].map((requestId) =>
    runWithRequestBudgetContext(
      { planCode: "free", executionMode: "fast", resolution: "billing" },
      () => atomicService.reserveFeature({
        identity: { userId: "00000000-0000-0000-0000-000000000004", anonymousKeyHash: null, isGuest: false },
        feature: "premium_text",
        requestId,
        route: standardRoute,
      }),
    ),
  ));
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);

  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /least\(p_units, available_units\)/);
  assert.match(migration, /actual_token_units/);
  assert.match(migration, /reservation\.status = 'committed'/);
  assert.match(migration, /created_at >= now\(\) - make_interval/);
  assert.match(migration, /policy_version = v_policy_version/);
  assert.match(migration, /legacy_message_ratio/);
  assert.match(migration, /ceil\(greatest\(0, p_token_limit\)::numeric \* legacy_used::numeric \/ legacy_limit::numeric\)/);
  assert.match(migration, /metadata ->> 'quota_policy_version' = 'standard-lite-tokens-v1'/);
  assert.match(billingRoutesSource, /tokens_remaining/);
  assert.match(billingRoutesSource, /window_start/);
  assert.match(billingPanelSource, /Counts model input and generated output within your rolling allowance\./);
  assert.match(llmServiceSource, /PYTHON_LLM_QUOTA_ENFORCEMENT = False/);

  console.log("Standard/Lite token allowance checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
