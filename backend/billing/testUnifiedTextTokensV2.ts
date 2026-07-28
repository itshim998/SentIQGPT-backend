import assert from "node:assert/strict";
import {
  FREE_UNIFIED_TEXT_FAST_RESERVE_TOKENS,
  FREE_UNIFIED_TEXT_LIMIT_TOKENS,
  FREE_UNIFIED_TEXT_POLICY,
  FREE_UNIFIED_TEXT_WINDOW_SECONDS,
  TEXT_TOKEN_PLAN_POLICY,
  TEXT_TOKEN_POLICY_VERSION,
  UNIFIED_TEXT_POLICY_VERSION,
} from "./planCatalog";
import {
  getTokenAllowanceAccounting,
  recordSuccessfulModelUsage,
  runWithRequestBudgetContext,
} from "../context/requestBudgetContext";

let BillingQuotaServiceCtor: typeof import("./quotaService").BillingQuotaService;

const identity = {
  userId: "00000000-0000-0000-0000-000000000101",
  anonymousKeyHash: null,
  isGuest: false,
} as const;

class UnifiedRepositoryFixture {
  reserveResult: Record<string, unknown> = {
    reserved: true,
    idempotent: false,
    reservation_id: "10000000-0000-0000-0000-000000000001",
    request_id: "fixture",
    status: "reserved",
    policy_version: UNIFIED_TEXT_POLICY_VERSION,
    plan_code: "free",
    execution_mode: "fast",
    limit_tokens: 50_000,
    window_seconds: 18_000,
    fast_reserve_tokens: 10_000,
    used_tokens: 0,
    active_reserved_tokens: 12_000,
    reservation_tokens: 12_000,
    remaining_tokens: 38_000,
    fast_available_tokens: 38_000,
    intuitive_available_tokens: 28_000,
    next_recovery_at: "2026-07-27T12:00:00.000Z",
    full_reset_at: null,
  };
  reserves: Array<Record<string, unknown>> = [];
  commits: Array<Record<string, unknown>> = [];
  releases: Array<Record<string, unknown>> = [];

  async reserveUnifiedTextTokensV2(args: Record<string, unknown>): Promise<any> {
    this.reserves.push(args);
    return {
      ...this.reserveResult,
      request_id: args.requestId,
      execution_mode: args.executionMode,
    };
  }

  async commitUnifiedTextTokensV2(args: Record<string, unknown>): Promise<any> {
    this.commits.push(args);
    const reservedTokens = 12_000;
    const actualTokens = Number(args.actualTokens);
    return {
      committed: true,
      idempotent: false,
      actual_tokens: actualTokens,
      released_tokens: Math.max(0, reservedTokens - actualTokens),
      usage_overrun_tokens: Math.max(0, actualTokens - reservedTokens),
      fast_reserve_breach_tokens: 0,
    };
  }

  async releaseUnifiedTextTokensV2(args: Record<string, unknown>): Promise<any> {
    this.releases.push(args);
    return { released: true, idempotent: false, released_tokens: 12_000 };
  }
}

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
  process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
  BillingQuotaServiceCtor = (await import("./quotaService")).BillingQuotaService;

  assert.equal(UNIFIED_TEXT_POLICY_VERSION, "unified-text-tokens-v2");
  assert.equal(TEXT_TOKEN_POLICY_VERSION, "standard-lite-tokens-v1");
  assert.equal(FREE_UNIFIED_TEXT_LIMIT_TOKENS, 50_000);
  assert.equal(FREE_UNIFIED_TEXT_WINDOW_SECONDS, 18_000);
  assert.equal(FREE_UNIFIED_TEXT_FAST_RESERVE_TOKENS, 10_000);
  assert.deepEqual(FREE_UNIFIED_TEXT_POLICY, {
    policyVersion: "unified-text-tokens-v2",
    limitTokens: 50_000,
    windowSeconds: 18_000,
    fastReserveTokens: 10_000,
    fastDesiredReservationTokens: 12_000,
    intuitiveDesiredReservationTokens: 16_000,
    fastMinimumReservationTokens: 256,
    intuitiveOrdinaryMinimumReservationTokens: 1_500,
    intuitiveComplexMinimumReservationTokens: 2_000,
  });
  assert.deepEqual(TEXT_TOKEN_PLAN_POLICY.free, {
    standardTokens: 25_000,
    liteTokens: 50_000,
  });

  const repository = new UnifiedRepositoryFixture();
  const service = new BillingQuotaServiceCtor(repository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      const reservation = await service.reserveTextRoute({
        identity,
        requestId: "v2-fast-ledger",
        executionMode: "fast",
      });
      assert.equal(reservation.feature, "unified_text");
      assert.equal(reservation.allowanceClass, "unified_text");
      assert.equal(reservation.policyVersion, UNIFIED_TEXT_POLICY_VERSION);
      assert.equal(reservation.reservedUnits, 12_000);
      assert.equal(repository.reserves[0]?.requestedTokens, 12_000);
      assert.equal(repository.reserves[0]?.minimumTokens, 256);
      assert.equal(getTokenAllowanceAccounting()?.allowanceClass, "unified_text");

      recordSuccessfulModelUsage({
        prompt: "supporting call",
        output: "supporting result",
        reportedInputTokens: 500,
        reportedOutputTokens: 300,
      });
      recordSuccessfulModelUsage({
        prompt: "final synthesis",
        output: "final answer",
        reportedInputTokens: 900,
        reportedOutputTokens: 700,
      });
      await service.commit(reservation);
      assert.equal(repository.commits.length, 1);
      assert.equal(repository.commits[0]?.actualTokens, 2_400);
      assert.equal(
        (repository.commits[0]?.metadata as Record<string, unknown>)?.successful_model_calls,
        2,
      );
      assert.equal(getTokenAllowanceAccounting()?.closed, true);
    },
  );

  const overrunRepository = new UnifiedRepositoryFixture();
  const overrunService = new BillingQuotaServiceCtor(overrunRepository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      const reservation = await overrunService.reserveTextRoute({
        identity,
        requestId: "v2-observed-overrun",
        executionMode: "fast",
      });
      recordSuccessfulModelUsage({
        prompt: "large provider call",
        output: "answer",
        reportedInputTokens: 8_000,
        reportedOutputTokens: 6_000,
      });
      await overrunService.commit(reservation);
      assert.equal(overrunRepository.commits[0]?.actualTokens, 14_000);
    },
  );

  const abnormalRepository = new UnifiedRepositoryFixture();
  const abnormalService = new BillingQuotaServiceCtor(abnormalRepository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "intuitive", resolution: "billing" },
    async () => {
      abnormalRepository.reserveResult = {
        ...abnormalRepository.reserveResult,
        execution_mode: "intuitive",
        reservation_tokens: 16_000,
      };
      const reservation = await abnormalService.reserveTextRoute({
        identity,
        requestId: "v2-abnormal-reliable-usage",
        executionMode: "intuitive",
      });
      recordSuccessfulModelUsage({
        prompt: "reported before abnormal termination",
        output: "",
        reportedInputTokens: 700,
        reportedOutputTokens: 250,
      });
      await abnormalService.release(reservation, "client_disconnected");
      assert.equal(abnormalRepository.commits.length, 1);
      assert.equal(abnormalRepository.releases.length, 0);
      assert.equal(abnormalRepository.commits[0]?.actualTokens, 950);
    },
  );

  const cancelRepository = new UnifiedRepositoryFixture();
  const cancelService = new BillingQuotaServiceCtor(cancelRepository as any);
  await runWithRequestBudgetContext(
    { planCode: "free", executionMode: "fast", resolution: "billing" },
    async () => {
      const reservation = await cancelService.reserveTextRoute({
        identity,
        requestId: "v2-cancel-before-provider",
        executionMode: "fast",
      });
      await cancelService.release(reservation, "context_budget_insufficient");
      assert.equal(cancelRepository.commits.length, 0);
      assert.equal(cancelRepository.releases.length, 1);
      assert.equal(getTokenAllowanceAccounting()?.closed, true);
    },
  );

  console.log("Unified text-token V2 policy and request-ledger checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
