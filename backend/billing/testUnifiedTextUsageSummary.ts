import assert from "node:assert/strict";
import { UNIFIED_TEXT_POLICY_VERSION } from "./planCatalog";

let BillingQuotaServiceCtor: typeof import("./quotaService").BillingQuotaService;

const identity = {
  userId: null,
  anonymousKeyHash: "test-guest-hash-not-logged",
  isGuest: true,
} as const;

class SummaryRepositoryFixture {
  planCode: "free" | "premium" = "free";
  failV2 = false;
  v2Calls = 0;

  async getUsageSummary(): Promise<any> {
    return {
      plan_code: this.planCode,
      status: this.planCode === "free" ? "free" : "active",
      quota_policy_version: "standard-lite-tokens-v1",
      quotas: {
        premium_text: {
          used: 1_000,
          reserved: 0,
          limit: 25_000,
          remaining: 24_000,
          tokens_consumed: 1_000,
          tokens_remaining: 24_000,
        },
        lite_text: { remaining: 50_000 },
      },
    };
  }

  async getUnifiedTextUsageSummaryV2(): Promise<any> {
    this.v2Calls += 1;
    if (this.failV2) throw new Error("missing migration");
    return {
      eligible: true,
      policy_version: UNIFIED_TEXT_POLICY_VERSION,
      plan_code: "free",
      limit_tokens: 50_000,
      window_seconds: 18_000,
      used_tokens: 12_000,
      active_reserved_tokens: 3_000,
      remaining_tokens: 35_000,
      fast_reserve_tokens: 10_000,
      fast_available_tokens: 35_000,
      intuitive_available_tokens: 25_000,
      intuitive_allowed: true,
      required_mode: null,
      exhausted: false,
      next_recovery_at: "2026-07-27T12:10:00.000Z",
      full_reset_at: "2026-07-27T16:00:00.000Z",
      stale_reclaimed_tokens: 0,
      rollback_shadow_v1_standard_tokens: 1_000,
    };
  }
}

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
  BillingQuotaServiceCtor = (await import("./quotaService")).BillingQuotaService;

  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
  const freeRepository = new SummaryRepositoryFixture();
  const freeSummary = await new BillingQuotaServiceCtor(freeRepository as any).getUsageSummary(identity);
  assert.deepEqual(freeSummary.quotas, {
    premium_text: {
      used: 0,
      reserved: 0,
      limit: 25_000,
      remaining: 25_000,
      tokens_consumed: 0,
      tokens_remaining: 25_000,
    },
    lite_text: { remaining: 50_000 },
  });
  assert.deepEqual(freeSummary.text_allowance, {
    policy_version: "unified-text-tokens-v2",
    plan_code: "free",
    limit_tokens: 50_000,
    window_seconds: 18_000,
    used_tokens: 12_000,
    reserved_tokens: 3_000,
    remaining_tokens: 35_000,
    fast_reserve_tokens: 10_000,
    fast_available_tokens: 35_000,
    intuitive_available_tokens: 25_000,
    intuitive_allowed: true,
    required_mode: null,
    exhausted: false,
    next_recovery_at: "2026-07-27T12:10:00.000Z",
    full_reset_at: "2026-07-27T16:00:00.000Z",
  });

  const paidRepository = new SummaryRepositoryFixture();
  paidRepository.planCode = "premium";
  const paidSummary = await new BillingQuotaServiceCtor(paidRepository as any).getUsageSummary({
    userId: "00000000-0000-0000-0000-000000000301",
    anonymousKeyHash: null,
    isGuest: false,
  });
  assert.equal(paidSummary.text_allowance, undefined);
  assert.equal(paidRepository.v2Calls, 0);

  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "false";
  const disabledRepository = new SummaryRepositoryFixture();
  const disabledSummary = await new BillingQuotaServiceCtor(disabledRepository as any).getUsageSummary(identity);
  assert.equal(disabledSummary.text_allowance, undefined);
  assert.equal(disabledRepository.v2Calls, 0);

  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
  const unavailableRepository = new SummaryRepositoryFixture();
  unavailableRepository.failV2 = true;
  await assert.rejects(
    new BillingQuotaServiceCtor(unavailableRepository as any).getUsageSummary(identity),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "unified_text_quota_unavailable");
      assert.equal((error as { statusCode?: number }).statusCode, 503);
      return true;
    },
  );

  console.log("Unified text-token V2 usage-summary checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
