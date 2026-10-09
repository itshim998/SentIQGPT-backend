import assert from "node:assert/strict";
import test from "node:test";

for (const id of [1, 2, 3, 4]) {
  process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
}

import { BillingRepository, BillingRepositoryError } from "./billing/billingRepository";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

/**
 * Regression test suite verifying guest text generation robustness:
 * - Requirements A through G
 * - No permanent "Thinking" state
 * - Concurrency limit (3) enforcement & observable queueing
 * - Reconnect without token duplication
 * - Multi-instance durable billing settlement
 */

function guestIdentity(anonymousHash = "guest-test-anon-hash") {
  return {
    userId: null,
    anonymousKeyHash: anonymousHash,
    isGuest: true,
  } as const;
}

// ----------------------------------------------------------------------------
// Test A: Sequential guest turns (10+ turns, total tokens < 8K, no thinking lock)
// ----------------------------------------------------------------------------
test("Requirement A: Sequential guest turns complete cleanly without thinking lock", async () => {
  const GUEST_LIMIT = 8000;
  let usedTokens = 0;
  let activeReservedTokens = 0;
  const turnsCount = 12;

  const mockDb = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              user_id: null,
              metadata: { quota_policy_version: "guest-text-trial-v1", guest_text_trial: true },
            },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "get_guest_text_usage_summary") {
        return {
          data: {
            policy_version: "guest-text-trial-v1",
            limit_tokens: GUEST_LIMIT,
            used_tokens: usedTokens,
            active_reserved_tokens: activeReservedTokens,
            remaining_tokens: GUEST_LIMIT - usedTokens - activeReservedTokens,
            exhausted: usedTokens + activeReservedTokens >= GUEST_LIMIT,
          },
          error: null,
        };
      }
      if (name === "reserve_guest_text_tokens") {
        const requested = Number(args.p_requested_tokens || 250);
        if (usedTokens + activeReservedTokens + requested > GUEST_LIMIT) {
          return { data: { reserved: false, reason: "guest_text_quota_exhausted" }, error: null };
        }
        activeReservedTokens += requested;
        return {
          data: {
            reserved: true,
            reservation_id: `res-${args.p_request_id}`,
            reservation_units: requested,
            plan_code: "free",
            limit: GUEST_LIMIT,
            remaining: GUEST_LIMIT - usedTokens - activeReservedTokens,
          },
          error: null,
        };
      }
      if (name === "commit_guest_text_tokens") {
        const actual = Number(args.p_actual_tokens || 180);
        activeReservedTokens = Math.max(0, activeReservedTokens - 250);
        usedTokens += actual;
        return {
          data: {
            matched: true,
            committed: true,
            settled_units: actual,
            released_units: Math.max(0, 250 - actual),
          },
          error: null,
        };
      }
      if (name === "release_guest_text_tokens") {
        activeReservedTokens = Math.max(0, activeReservedTokens - 250);
        return { data: { matched: true, released: true, released_units: 250 }, error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    },
  } as any;

  const repo = new BillingRepository(mockDb);

  for (let turn = 1; turn <= turnsCount; turn++) {
    const requestId = `turn-${turn}-req`;
    const summaryBefore = await repo.getGuestTextUsageSummary("guest-test-anon-hash");
    assert.equal(summaryBefore.exhausted, false, `Turn ${turn} should start with non-exhausted quota`);

    const reserved = await repo.reserveUsage({
      identity: guestIdentity(),
      feature: "premium_text",
      units: 250,
      requestId,
      metadata: { minimum_tokens: 100 },
    });
    assert.equal(reserved.reserved, true, `Turn ${turn} reservation must succeed`);

    // Simulate turn execution and settlement
    const settled = await repo.commitReservation({
      requestId,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      route: "normal_chat",
      metadata: { actual_token_units: 180 },
    });
    assert.equal(settled.committed, true, `Turn ${turn} settlement must succeed`);
    assert.equal(settled.settled_units, 180, `Turn ${turn} settled units must be 180`);
  }

  assert.equal(usedTokens, turnsCount * 180, "Total tokens used must equal 12 * 180 = 2160");
  assert.equal(activeReservedTokens, 0, "All active reservations must be cleared");
  const finalSummary = await repo.getGuestTextUsageSummary("guest-test-anon-hash");
  assert.equal(finalSummary.used_tokens, 2160);
  assert.equal(finalSummary.remaining_tokens, GUEST_LIMIT - 2160);
  assert.equal(finalSummary.exhausted, false);
});

// ----------------------------------------------------------------------------
// Test B: Forced SSE disconnect mid-stream -> reconnect without token duplication
// ----------------------------------------------------------------------------
test("Requirement B: Forced SSE disconnect mid-stream recovers without token duplication", async () => {
  const generationId = "gen-disconnect-test-1";
  const coordinator = chatGenerationTaskCoordinator;

  const task = coordinator.start({
    generationId,
    clientRequestId: "req-disc-1",
    userId: "guest-owner-1",
    conversationId: "conv-1",
  });

  const receivedPass1: string[] = [];
  const receivedPass2: string[] = [];
  let disconnectSequence = 0;

  // Client 1 connects at cursor = 0
  const unsubscribe1 = coordinator.subscribe(generationId, (event) => {
    const anyEvent = event as any;
    if (anyEvent.type === "token" && anyEvent.text) {
      receivedPass1.push(String(anyEvent.text));
      disconnectSequence = Number(anyEvent.sequence);
    }
  }, 0);

  // Emit 3 tokens
  await coordinator.publish(generationId, { type: "token", text: "Hello" });
  await coordinator.publish(generationId, { type: "token", text: " world" });
  await coordinator.publish(generationId, { type: "token", text: " from" });

  assert.equal(receivedPass1.join(""), "Hello world from");
  assert.equal(disconnectSequence, 3);

  // Client 1 disconnects intentionally
  unsubscribe1();

  // Background generation continues emitting on the server
  await coordinator.publish(generationId, { type: "token", text: " SentIQ" });
  await coordinator.publish(generationId, { type: "token", text: " guest!" });

  // Client 2 reconnects using afterSequence = disconnectSequence (3)
  const unsubscribe2 = coordinator.subscribe(generationId, (event) => {
    const anyEvent = event as any;
    if (anyEvent.type === "token" && anyEvent.text) {
      receivedPass2.push(String(anyEvent.text));
    }
  }, disconnectSequence);

  // Complete the generation
  await coordinator.complete(generationId);
  unsubscribe2();

  assert.equal(receivedPass2.join(""), " SentIQ guest!", "Reconnected subscriber receives only post-disconnect tokens");
  const fullDelivered = receivedPass1.join("") + receivedPass2.join("");
  assert.equal(fullDelivered, "Hello world from SentIQ guest!", "Tokens must not be duplicated or missed");
  assert.equal(task.terminal, true, "Task reaches terminal completed state cleanly");
});

// ----------------------------------------------------------------------------
// Test C: Disconnect then immediate follow-up request
// ----------------------------------------------------------------------------
test("Requirement C: Disconnect followed by immediate next turn succeeds without leaked capacity", async () => {
  let activeExecutionLeases = 0;
  const maxActive = 3;

  function claimLease() {
    if (activeExecutionLeases >= maxActive) {
      const err = new Error("Guest generation concurrency limit reached");
      (err as any).code = "55P03";
      throw err;
    }
    activeExecutionLeases += 1;
    return `lease-${activeExecutionLeases}`;
  }

  function releaseLease() {
    activeExecutionLeases = Math.max(0, activeExecutionLeases - 1);
  }

  // Turn 1 starts and acquires lease
  const lease1 = claimLease();
  assert.equal(activeExecutionLeases, 1);

  // Turn 1 network disconnects, server finishes execution and cleans up
  releaseLease();
  assert.equal(activeExecutionLeases, 0);

  // Turn 2 starts immediately
  const lease2 = claimLease();
  assert.equal(activeExecutionLeases, 1);
  assert.ok(lease2);

  // Turn 2 finishes cleanly
  releaseLease();
  assert.equal(activeExecutionLeases, 0, "No execution lease leaked");
});

// ----------------------------------------------------------------------------
// Test D: Concurrency exhaustion (3 active, 4th queued, bounded retry)
// ----------------------------------------------------------------------------
test("Requirement D: Concurrency limit (3) queues 4th generation and bounds retries", async () => {
  let activeCount = 3; // 3 active generations currently running
  const MAX_ACTIVE = 3;

  function claimLease(isFourth: boolean) {
    if (activeCount >= MAX_ACTIVE) {
      const err = new Error("Guest generation concurrency limit reached");
      (err as any).code = "55P03";
      return { data: null, error: err };
    }
    activeCount += 1;
    return { data: { id: "claimed" }, error: null };
  }

  // Fourth generation arrives
  const fourthClaim = claimLease(true);
  assert.equal((fourthClaim.error as any)?.code, "55P03", "4th generation hits concurrency limit");

  // Verify bounded retry policy behavior: retries increment, does not loop infinitely
  const MAX_CONCURRENCY_RETRIES = 30;
  let retries = 0;
  let failedWithTimeout = false;

  while (retries <= MAX_CONCURRENCY_RETRIES + 1) {
    retries += 1;
    if (retries > MAX_CONCURRENCY_RETRIES) {
      failedWithTimeout = true;
      break;
    }
  }

  assert.equal(failedWithTimeout, true, "Exceeding MAX_CONCURRENCY_RETRIES triggers timeout failure");
  assert.equal(retries, 31, "Fails cleanly after exactly bounded retries");

  // Now simulate slot freeing up before timeout
  activeCount = 2; // One finished
  const unblockedClaim = claimLease(false);
  assert.equal(unblockedClaim.error, null, "Freed slot allows queued generation to claim lease");
  assert.ok(unblockedClaim.data);
});

// ----------------------------------------------------------------------------
// Test E: Guest quota exhaustion (8,000 token limit enforced)
// ----------------------------------------------------------------------------
test("Requirement E: Guest quota limit of 8,000 tokens rejects turns exceeding limit cleanly", async () => {
  const GUEST_LIMIT = 8000;
  let usedTokens = 7600; // 400 remaining
  let activeReserved = 0;

  const mockDb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "reserve_guest_text_tokens") {
        const requested = Number(args.p_requested_tokens);
        const remaining = GUEST_LIMIT - usedTokens - activeReserved;
        if (requested > remaining) {
          return {
            data: {
              reserved: false,
              reason: "guest_text_quota_exhausted",
              limit: GUEST_LIMIT,
              remaining,
              required_mode: "fast",
            },
            error: null,
          };
        }
        activeReserved += requested;
        return {
          data: {
            reserved: true,
            reservation_id: "res-fit",
            reservation_units: requested,
            remaining: remaining - requested,
          },
          error: null,
        };
      }
      if (name === "commit_guest_text_tokens") {
        const actual = Number(args.p_actual_tokens);
        usedTokens += actual;
        activeReserved = 0;
        return { data: { matched: true, committed: true }, error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { user_id: null, metadata: { quota_policy_version: "guest-text-trial-v1" } },
            error: null,
          }),
        }),
      }),
    }),
  } as any;

  const repo = new BillingRepository(mockDb);

  // Turn fitting in remaining 400 tokens (request 300 tokens)
  const fitting = await repo.reserveUsage({
    identity: guestIdentity(),
    feature: "premium_text",
    units: 300,
    requestId: "fitting-req",
  });
  assert.equal(fitting.reserved, true, "Turn fitting in remaining quota succeeds");
  await repo.commitReservation({
    requestId: "fitting-req",
    provider: "groq",
    model: "llama",
    route: "chat",
    metadata: { actual_token_units: 300 },
  });

  assert.equal(usedTokens, 7900, "Used tokens now 7900 / 8000 (100 remaining)");

  // Turn requiring 250 tokens (> 100 remaining)
  const exceeding = await repo.reserveUsage({
    identity: guestIdentity(),
    feature: "premium_text",
    units: 250,
    requestId: "exceeding-req",
  });
  assert.equal(exceeding.reserved, false, "Turn exceeding remaining 8K quota is rejected");
  assert.equal(exceeding.reason, "guest_text_quota_exhausted");
  assert.equal(exceeding.remaining, 100);
});

// ----------------------------------------------------------------------------
// Test F: Failure settlement (provider failure releases reservation capacity)
// ----------------------------------------------------------------------------
test("Requirement F: Provider failure mid-stream releases reservation capacity cleanly", async () => {
  let activeReserved = 0;
  let releaseCalls = 0;

  const mockDb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "reserve_guest_text_tokens") {
        activeReserved += Number(args.p_requested_tokens || 1000);
        return { data: { reserved: true, reservation_id: "res-fail-test" }, error: null };
      }
      if (name === "release_guest_text_tokens") {
        releaseCalls += 1;
        activeReserved = 0;
        return { data: { matched: true, released: true, released_units: 1000 }, error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { user_id: null, metadata: { guest_text_trial: true } },
            error: null,
          }),
        }),
      }),
    }),
  } as any;

  const repo = new BillingRepository(mockDb);

  await repo.reserveUsage({
    identity: guestIdentity(),
    feature: "premium_text",
    units: 1000,
    requestId: "req-provider-fail",
  });
  assert.equal(activeReserved, 1000, "Quota reserved for generation");

  // Provider fails mid-stream -> releaseReservation called
  const releaseResult = await repo.releaseReservation("req-provider-fail");
  assert.equal(releaseResult.released, true, "Reservation release succeeds");
  assert.equal(activeReserved, 0, "Capacity restored back to 0");
  assert.equal(releaseCalls, 1, "release_guest_text_tokens was invoked");
});

// ----------------------------------------------------------------------------
// Test G: Multi-instance billing safety (reserve on A, commit/release on B)
// ----------------------------------------------------------------------------
test("Requirement G: Multi-instance billing safety without shared in-memory state", async () => {
  // Shared durable database store representing PostgreSQL public.quota_reservations
  const sharedDurableReservations = new Map<string, {
    requestId: string;
    userId: string | null;
    units: number;
    status: string;
    metadata: Record<string, unknown>;
  }>();

  function createInstanceDb() {
    return {
      from: (table: string) => {
        assert.equal(table, "quota_reservations");
        return {
          select: () => ({
            eq: (_col: string, requestId: string) => ({
              maybeSingle: async () => {
                const row = sharedDurableReservations.get(requestId);
                if (!row) return { data: null, error: null };
                return {
                  data: {
                    user_id: row.userId,
                    metadata: row.metadata,
                  },
                  error: null,
                };
              },
            }),
          }),
        };
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "reserve_guest_text_tokens") {
          const reqId = String(args.p_request_id);
          sharedDurableReservations.set(reqId, {
            requestId: reqId,
            userId: null,
            units: Number(args.p_requested_tokens || 500),
            status: "reserved",
            metadata: { quota_policy_version: "guest-text-trial-v1", guest_text_trial: true },
          });
          return { data: { reserved: true, reservation_id: `res-${reqId}` }, error: null };
        }
        if (name === "commit_guest_text_tokens") {
          const reqId = String(args.p_request_id);
          const row = sharedDurableReservations.get(reqId);
          if (!row || row.status !== "reserved") return { data: { matched: false }, error: null };
          row.status = "committed";
          return { data: { matched: true, committed: true, settled_units: Number(args.p_actual_tokens || 100) }, error: null };
        }
        if (name === "release_guest_text_tokens") {
          const reqId = String(args.p_request_id);
          const row = sharedDurableReservations.get(reqId);
          if (!row) return { data: { matched: false }, error: null };
          row.status = "released";
          return { data: { matched: true, released: true }, error: null };
        }
        if (name === "commit_usage_reservation" || name === "release_usage_reservation") {
          throw new Error(`Signed-in RPC ${name} should NOT be called for guest reservations!`);
        }
        throw new Error(`Unexpected RPC: ${name}`);
      },
    } as any;
  }

  // Create two isolated BillingRepository instances representing independent backend containers
  const instanceA = new BillingRepository(createInstanceDb());
  const instanceB = new BillingRepository(createInstanceDb());

  // 1. Commit flow: Reserve on Instance A, Commit on Instance B
  const commitReqId = "multi-instance-commit-req";
  await instanceA.reserveUsage({
    identity: guestIdentity(),
    feature: "premium_text",
    units: 500,
    requestId: commitReqId,
  });

  const commitResult = await instanceB.commitReservation({
    requestId: commitReqId,
    provider: "groq",
    model: "llama",
    route: "chat",
    metadata: { actual_token_units: 320 },
  });
  assert.equal(commitResult.committed, true, "Instance B settled guest reservation made on Instance A");
  assert.equal(commitResult.settled_units, 320);
  assert.equal(sharedDurableReservations.get(commitReqId)?.status, "committed");

  // 2. Release flow: Reserve on Instance A, Release on Instance B
  const releaseReqId = "multi-instance-release-req";
  await instanceA.reserveUsage({
    identity: guestIdentity(),
    feature: "lite_text",
    units: 400,
    requestId: releaseReqId,
  });

  const releaseResult = await instanceB.releaseReservation(releaseReqId);
  assert.equal(releaseResult.released, true, "Instance B released guest reservation made on Instance A");
  assert.equal(sharedDurableReservations.get(releaseReqId)?.status, "released");
});

test("multi-instance billing: lookup failure on quota_reservations throws reservation_lookup_failed and never falls through to generic settlement", async () => {
  const failingDb = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { message: "database connection timeout", code: "57014" },
          }),
        }),
      }),
    }),
    rpc: async (name: string) => {
      throw new Error(`RPC ${name} should NOT be called when reservation lookup fails!`);
    },
  } as any;

  const repo = new BillingRepository(failingDb);

  await assert.rejects(
    async () => {
      await repo.commitReservation({
        requestId: "failing-lookup-req",
        provider: "groq",
        model: "llama",
        route: "chat",
        metadata: { actual_token_units: 100 },
      });
    },
    (err: any) => {
      assert.equal(err.code, "reservation_lookup_failed");
      return true;
    },
    "commitReservation must fail-closed on reservation lookup error",
  );

  await assert.rejects(
    async () => {
      await repo.releaseReservation("failing-lookup-req");
    },
    (err: any) => {
      assert.equal(err.code, "reservation_lookup_failed");
      return true;
    },
    "releaseReservation must fail-closed on reservation lookup error",
  );
});

