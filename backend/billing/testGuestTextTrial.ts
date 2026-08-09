import { readFileSync } from "fs";
import { BillingRepository } from "./billingRepository";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), message);
}

function guestIdentity() {
  return {
    userId: null,
    anonymousKeyHash: "guest-hash-test",
    isGuest: true,
  } as const;
}

async function testGuestSummaryAndFastOnlyRouting(): Promise<void> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "get_usage_summary") {
        return { data: { plan_code: "free", quotas: {} }, error: null };
      }
      if (name === "get_guest_text_usage_summary") {
        return {
          data: {
            policy_version: "guest-text-trial-v1",
            limit_tokens: 8000,
            used_tokens: 1200,
            active_reserved_tokens: 0,
            remaining_tokens: 6800,
            exhausted: false,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  } as any;

  const repository = new BillingRepository(db);
  const summary = await repository.getUsageSummary(guestIdentity());
  assert(summary.guest_text_allowance?.limit_tokens === 8000, "guest usage summary must expose the 8K allowance");
  assert(summary.guest_text_allowance?.remaining_tokens === 6800, "guest usage summary must expose remaining guest tokens");

  const unified = await repository.getUnifiedTextUsageSummaryV2(guestIdentity());
  assert(unified.eligible === true, "guest quota should remain visible to unified quota UI");
  assert(unified.limit_tokens === 8000, "unified guest summary must report the 8K limit");
  assert(unified.intuitive_allowed === false, "guest unified quota must not allow Intuitive mode");
  assert(unified.required_mode === "fast", "guest unified quota must require Fast mode");

  const fastReservation = await repository.reserveUnifiedTextTokensV2({
    identity: guestIdentity(),
    requestId: "guest-fast-v2",
    executionMode: "fast",
    requestedTokens: 4096,
    minimumTokens: 256,
  });
  assert(fastReservation.reason === "plan_not_eligible", "Fast guest requests must fall back to the isolated guest V1 reservation path");

  const intuitiveReservation = await repository.reserveUnifiedTextTokensV2({
    identity: guestIdentity(),
    requestId: "guest-intuitive-v2",
    executionMode: "intuitive",
    requestedTokens: 4096,
    minimumTokens: 256,
  });
  assert(intuitiveReservation.reason === "intuitive_fast_required", "guest Intuitive requests must be rejected");
  assert(intuitiveReservation.required_mode === "fast", "guest Intuitive rejection must point to Fast mode");

  assert(calls.filter((call) => call.name === "get_guest_text_usage_summary").length >= 2, "guest summary RPC should back both public quota states");
  assert(!calls.some((call) => call.name === "get_unified_text_usage_summary_v2"), "guest quota must not use the signed-in unified text ledger");
}

async function testGuestReservationCommitAndRelease(): Promise<void> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "reserve_guest_text_tokens") {
        return {
          data: {
            reserved: true,
            reservation_id: "11111111-1111-1111-1111-111111111111",
            reservation_units: 4000,
            plan_code: "free",
            limit: 8000,
            remaining: 4000,
          },
          error: null,
        };
      }
      if (name === "commit_guest_text_tokens") {
        return {
          data: {
            matched: true,
            committed: true,
            settled_units: Number(args.p_actual_tokens || 0),
            released_units: 0,
          },
          error: null,
        };
      }
      if (name === "release_guest_text_tokens") {
        return {
          data: {
            matched: true,
            released: true,
            released_units: 4000,
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  } as any;

  const repository = new BillingRepository(db);
  const committedRequestId = "guest-reserve-commit";
  await repository.reserveUsage({
    identity: guestIdentity(),
    feature: "premium_text",
    units: 4000,
    requestId: committedRequestId,
    metadata: { minimum_tokens: 256 },
  });
  await repository.commitReservation({
    requestId: committedRequestId,
    provider: "test",
    model: "test",
    route: "normal_chat",
    metadata: { actual_token_units: 912 },
  });

  const commitCall = calls.find((call) => call.name === "commit_guest_text_tokens");
  assert(commitCall, "guest reservation must settle through the guest quota RPC");
  assert(commitCall.args.p_actual_tokens === 912, "guest settlement must use actual text-token usage");
  assert(!calls.some((call) => call.name === "commit_usage_reservation"), "guest text settlement must not fall through to signed-in plan settlement");

  const releasedRequestId = "guest-reserve-release";
  await repository.reserveUsage({
    identity: guestIdentity(),
    feature: "lite_text",
    units: 4000,
    requestId: releasedRequestId,
    metadata: { minimum_tokens: 256 },
  });
  await repository.releaseReservation(releasedRequestId);
  assert(calls.some((call) => call.name === "release_guest_text_tokens" && call.args.p_request_id === releasedRequestId), "guest failure path must release the isolated guest reservation");
  assert(!calls.some((call) => call.name === "release_usage_reservation"), "guest text release must not use the signed-in plan release RPC");
}

function testMigrationContract(): void {
  const migration = readFileSync("supabase/migrations/20260809133000_guest_text_trial_quota.sql", "utf8");
  assertIncludes(migration, "v_limit constant integer := 8000", "guest SQL must enforce an 8K limit in the database");
  assertIncludes(migration, "guest-text-trial-v1", "guest SQL must use a versioned policy marker");
  assertIncludes(migration, "pg_advisory_xact_lock", "guest reservation must serialize concurrent requests per anonymous identity");
  assertIncludes(migration, "feature in ('premium_text', 'lite_text')", "Standard and Lite fallbacks must share one guest pool");
  assertIncludes(migration, "grant execute on function public.reserve_guest_text_tokens", "guest quota RPCs must remain service-role only");
}

async function main(): Promise<void> {
  testMigrationContract();
  await testGuestSummaryAndFastOnlyRouting();
  await testGuestReservationCommitAndRelease();
  console.log("Guest text trial quota checks passed.");
}

main().catch((error) => {
  console.error(`Guest text trial test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
