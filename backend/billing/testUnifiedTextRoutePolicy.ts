import assert from "node:assert/strict";
import { runWithRequestBudgetContext } from "../context/requestBudgetContext";
import { UNIFIED_TEXT_POLICY_VERSION } from "./planCatalog";

let BillingQuotaServiceCtor: typeof import("./quotaService").BillingQuotaService;
let BillingQuotaErrorCtor: typeof import("./quotaService").BillingQuotaError;
let buildQuotaErrorPayload: typeof import("./quotaService").buildQuotaErrorPayload;

const identity = {
  userId: "00000000-0000-0000-0000-000000000201",
  anonymousKeyHash: null,
  isGuest: false,
} as const;

class RouteRepositoryFixture {
  v1Calls: Array<Record<string, unknown>> = [];
  v2Calls: Array<Record<string, unknown>> = [];
  v2Result: Record<string, unknown> = {};
  rejectStandardV1 = false;

  async reserveUsage(args: Record<string, unknown>): Promise<any> {
    this.v1Calls.push(args);
    if (this.rejectStandardV1 && args.feature === "premium_text") {
      return {
        reserved: false,
        reason: "quota_exceeded",
        plan_code: "free",
        limit: 25_000,
        remaining: 0,
      };
    }
    return {
      reserved: true,
      idempotent: false,
      plan_code: "free",
      limit: args.feature === "premium_text" ? 25_000 : 50_000,
      remaining: 10_000,
      reservation_units: 12_000,
      window_identity: "v1-window",
    };
  }

  async reserveUnifiedTextTokensV2(args: Record<string, unknown>): Promise<any> {
    this.v2Calls.push(args);
    if (Object.keys(this.v2Result).length > 0) return this.v2Result;
    return {
      reserved: true,
      idempotent: false,
      reservation_id: "20000000-0000-0000-0000-000000000001",
      request_id: args.requestId,
      status: "reserved",
      plan_code: "free",
      policy_version: UNIFIED_TEXT_POLICY_VERSION,
      execution_mode: args.executionMode,
      limit_tokens: 50_000,
      window_seconds: 18_000,
      fast_reserve_tokens: 10_000,
      used_tokens: 0,
      active_reserved_tokens: args.requestedTokens,
      reservation_tokens: args.requestedTokens,
      remaining_tokens: 50_000 - Number(args.requestedTokens),
      fast_available_tokens: 50_000 - Number(args.requestedTokens),
      intuitive_available_tokens: 40_000 - Number(args.requestedTokens),
      next_recovery_at: null,
      full_reset_at: null,
    };
  }
}

async function reserveWithContext(args: {
  planCode: "free" | "student_core" | "premium" | "pro";
  mode: "fast" | "intuitive";
  requestId: string;
  repository: RouteRepositoryFixture;
  complexity?: "normal" | "heavy";
}) {
  const service = new BillingQuotaServiceCtor(args.repository as any);
  return runWithRequestBudgetContext(
    { planCode: args.planCode, executionMode: args.mode, resolution: "billing" },
    () => service.reserveTextRoute({
      identity,
      requestId: args.requestId,
      executionMode: args.mode,
      complexity: args.complexity,
    }),
  );
}

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
  const quotaModule = await import("./quotaService");
  BillingQuotaServiceCtor = quotaModule.BillingQuotaService;
  BillingQuotaErrorCtor = quotaModule.BillingQuotaError;
  buildQuotaErrorPayload = quotaModule.buildQuotaErrorPayload;

  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "false";
  const disabledFree = new RouteRepositoryFixture();
  await reserveWithContext({
    planCode: "free",
    mode: "fast",
    requestId: "flag-off-free",
    repository: disabledFree,
  });
  assert.deepEqual(disabledFree.v1Calls.map((call) => call.feature), ["premium_text"]);
  assert.equal(disabledFree.v2Calls.length, 0);

  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
  const fastFree = new RouteRepositoryFixture();
  const fastReservation = await reserveWithContext({
    planCode: "free",
    mode: "fast",
    requestId: "flag-on-free-fast",
    repository: fastFree,
  });
  assert.equal(fastReservation.feature, "unified_text");
  assert.equal(fastFree.v1Calls.length, 0);
  assert.equal(fastFree.v2Calls[0]?.executionMode, "fast");
  assert.equal(fastFree.v2Calls[0]?.requestedTokens, 12_000);
  assert.equal(fastFree.v2Calls[0]?.minimumTokens, 256);

  const intuitiveFree = new RouteRepositoryFixture();
  await reserveWithContext({
    planCode: "free",
    mode: "intuitive",
    requestId: "flag-on-free-intuitive",
    repository: intuitiveFree,
    complexity: "heavy",
  });
  assert.equal(intuitiveFree.v2Calls[0]?.executionMode, "intuitive");
  assert.equal(intuitiveFree.v2Calls[0]?.requestedTokens, 16_000);
  assert.equal(intuitiveFree.v2Calls[0]?.minimumTokens, 2_000);

  for (const planCode of ["student_core", "premium", "pro"] as const) {
    for (const mode of ["fast", "intuitive"] as const) {
      const paid = new RouteRepositoryFixture();
      await reserveWithContext({
        planCode,
        mode,
        requestId: `flag-on-${planCode}-${mode}`,
        repository: paid,
      });
      assert.deepEqual(paid.v1Calls.map((call) => call.feature), ["premium_text"]);
      assert.equal(paid.v2Calls.length, 0);
    }
  }

  const noDowngrade = new RouteRepositoryFixture();
  noDowngrade.rejectStandardV1 = true;
  await reserveWithContext({
    planCode: "free",
    mode: "fast",
    requestId: "v2-no-standard-lite-downgrade",
    repository: noDowngrade,
  });
  assert.equal(noDowngrade.v1Calls.length, 0);
  assert.equal(noDowngrade.v2Calls.length, 1);

  const changedPlan = new RouteRepositoryFixture();
  changedPlan.v2Result = {
    reserved: false,
    reason: "plan_not_eligible",
    plan_code: "premium",
    policy_version: UNIFIED_TEXT_POLICY_VERSION,
  };
  await reserveWithContext({
    planCode: "free",
    mode: "fast",
    requestId: "v2-plan-changed-to-paid",
    repository: changedPlan,
  });
  assert.equal(changedPlan.v2Calls.length, 1);
  assert.deepEqual(changedPlan.v1Calls.map((call) => call.feature), ["premium_text"]);

  const fastRequired = new RouteRepositoryFixture();
  fastRequired.v2Result = {
    reserved: false,
    reason: "intuitive_fast_required",
    plan_code: "free",
    policy_version: UNIFIED_TEXT_POLICY_VERSION,
    limit_tokens: 50_000,
    used_tokens: 40_000,
    active_reserved_tokens: 0,
    remaining_tokens: 10_000,
    fast_reserve_tokens: 10_000,
    fast_available_tokens: 10_000,
    intuitive_available_tokens: 0,
    required_mode: "fast",
    next_recovery_at: "2026-07-27T12:05:00.000Z",
  };
  await assert.rejects(
    reserveWithContext({
      planCode: "free",
      mode: "intuitive",
      requestId: "intuitive-fast-required",
      repository: fastRequired,
    }),
    (error: unknown) => {
      assert(error instanceof BillingQuotaErrorCtor);
      const payload = buildQuotaErrorPayload(error);
      assert.equal(payload.code, "intuitive_fast_required");
      assert.equal(payload.type, "mode_switch_required");
      assert.equal(payload.required_mode, "fast");
      assert.equal(payload.remaining_tokens, 10_000);
      assert.equal(payload.reset_at, payload.next_recovery_at);
      assert.equal(payload.feature, undefined);
      assert.doesNotMatch(JSON.stringify(payload), /nvidia|nemotron|groq|gemini|pollinations/i);
      return true;
    },
  );

  const exhausted = new RouteRepositoryFixture();
  exhausted.v2Result = {
    ...fastRequired.v2Result,
    reason: "unified_text_quota_exhausted",
    used_tokens: 50_000,
    remaining_tokens: 0,
    fast_available_tokens: 0,
    required_mode: null,
  };
  await assert.rejects(
    reserveWithContext({
      planCode: "free",
      mode: "fast",
      requestId: "unified-exhausted",
      repository: exhausted,
    }),
    (error: unknown) => {
      assert(error instanceof BillingQuotaErrorCtor);
      const payload = buildQuotaErrorPayload(error);
      assert.equal(payload.code, "unified_text_quota_exhausted");
      assert.equal(payload.type, "quota_exceeded");
      assert.equal(payload.remaining_tokens, 0);
      assert.equal(payload.required_mode, null);
      return true;
    },
  );

  const insufficient = new RouteRepositoryFixture();
  insufficient.v2Result = {
    ...fastRequired.v2Result,
    reason: "unified_text_insufficient_for_request",
    used_tokens: 38_501,
    remaining_tokens: 11_499,
    fast_available_tokens: 11_499,
    intuitive_available_tokens: 1_499,
    required_mode: null,
  };
  await assert.rejects(
    reserveWithContext({
      planCode: "free",
      mode: "intuitive",
      requestId: "unified-insufficient",
      repository: insufficient,
    }),
    (error: unknown) => {
      assert(error instanceof BillingQuotaErrorCtor);
      const payload = buildQuotaErrorPayload(error);
      assert.equal(payload.code, "unified_text_insufficient_for_request");
      assert.equal(payload.type, "insufficient_allowance");
      assert.equal(payload.remaining_tokens, 11_499);
      assert.equal(payload.intuitive_available_tokens, 1_499);
      return true;
    },
  );

  const unavailableService = new BillingQuotaServiceCtor({
    reserveUnifiedTextTokensV2: async () => {
      throw new Error("missing rpc");
    },
  } as any);
  await assert.rejects(
    runWithRequestBudgetContext(
      { planCode: "free", executionMode: "fast", resolution: "billing" },
      () => unavailableService.reserveTextRoute({
        identity,
        requestId: "unified-unavailable",
        executionMode: "fast",
      }),
    ),
    (error: unknown) => {
      assert(error instanceof BillingQuotaErrorCtor);
      const payload = buildQuotaErrorPayload(error);
      assert.equal(error.statusCode, 503);
      assert.equal(payload.code, "unified_text_quota_unavailable");
      assert.equal(payload.type, "service_unavailable");
      return true;
    },
  );

  console.log("Unified text-token V2 route-policy checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
