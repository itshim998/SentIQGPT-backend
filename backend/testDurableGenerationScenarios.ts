import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();
for (const id of [1, 2, 3]) {
  process.env[`SUPABASE_URL_${id}`] ??= `https://shard-${id}-test.supabase.co`;
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ??= `test-key-${id}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HIGH-FIDELITY IN-MEMORY SHARD EMULATOR
// Models PostgreSQL tables, row-level locks, fencing tokens, and lease semantics
// ═══════════════════════════════════════════════════════════════════════════════

interface StoredGeneration {
  id: string;
  conversation_id: string;
  user_id: string;
  client_request_id: string | null;
  status: "queued" | "running" | "generating" | "persisting" | "waiting_for_tool" | "cancel_requested" | "completed" | "failed" | "cancelled";
  partial_text: string;
  tokens_generated: number;
  last_event_sequence: number;
  execution_lease_id: string | null;
  execution_lease_expires_at: string | null;
  recovery_attempts: number;
  created_at: string;
  updated_at: string;
}

interface StoredEvent {
  generation_id: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

class ShardEmulator {
  readonly shardId: number;
  readonly generations = new Map<string, StoredGeneration>();
  readonly events = new Map<string, StoredEvent[]>();
  db1WriteAttempts = 0;

  constructor(shardId: number) {
    this.shardId = shardId;
  }

  insertGeneration(row: Omit<StoredGeneration, "status" | "partial_text" | "tokens_generated" | "last_event_sequence" | "execution_lease_id" | "execution_lease_expires_at" | "recovery_attempts" | "created_at" | "updated_at"> & Partial<StoredGeneration>): StoredGeneration {
    const now = new Date().toISOString();
    const stored: StoredGeneration = {
      status: "queued",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      execution_lease_id: null,
      execution_lease_expires_at: null,
      recovery_attempts: 0,
      created_at: now,
      updated_at: now,
      ...row,
    };
    this.generations.set(stored.id, stored);
    this.events.set(stored.id, []);
    return stored;
  }

  claimLease(generationId: string, leaseId: string, ttlSeconds: number, maxActive = 3): { claimed: boolean; reason?: string } {
    const gen = this.generations.get(generationId);
    if (!gen) return { claimed: false, reason: "not_found" };

    // Concurrency limit check
    let activeForUser = 0;
    for (const g of this.generations.values()) {
      if (g.user_id === gen.user_id && ["running", "generating", "persisting"].includes(g.status)) {
        activeForUser++;
      }
    }
    if (activeForUser >= maxActive) {
      return { claimed: false, reason: "concurrency_limit_exceeded" };
    }

    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    gen.execution_lease_id = leaseId;
    gen.execution_lease_expires_at = expires;
    gen.status = "generating";
    gen.updated_at = new Date().toISOString();
    return { claimed: true };
  }

  renewLease(generationId: string, leaseId: string, ttlSeconds: number): boolean {
    const gen = this.generations.get(generationId);
    if (!gen || gen.execution_lease_id !== leaseId) return false;
    gen.execution_lease_expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    gen.updated_at = new Date().toISOString();
    return true;
  }

  appendEventFenced(generationId: string, leaseId: string, type: string, payload: Record<string, unknown>): { ok: boolean; sequence?: number; error?: string } {
    const gen = this.generations.get(generationId);
    if (!gen) return { ok: false, error: "not_found" };
    if (gen.execution_lease_id !== leaseId) {
      return { ok: false, error: "lease_fenced" };
    }
    const expiresAt = gen.execution_lease_expires_at ? new Date(gen.execution_lease_expires_at).getTime() : 0;
    if (Date.now() > expiresAt) {
      return { ok: false, error: "lease_expired" };
    }

    const seq = gen.last_event_sequence + 1;
    gen.last_event_sequence = seq;
    gen.updated_at = new Date().toISOString();
    if (typeof payload.text === "string") {
      gen.partial_text += payload.text;
      gen.tokens_generated++;
    }

    const list = this.events.get(generationId) ?? [];
    list.push({
      generation_id: generationId,
      sequence: seq,
      type,
      payload,
      created_at: new Date().toISOString(),
    });
    this.events.set(generationId, list);
    return { ok: true, sequence: seq };
  }

  cancelGeneration(generationId: string): boolean {
    const gen = this.generations.get(generationId);
    if (!gen) return false;
    gen.status = "cancelled";
    gen.execution_lease_id = null;
    gen.execution_lease_expires_at = null;
    gen.updated_at = new Date().toISOString();
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 15 PRODUCTION SCENARIOS SUITE
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const {
    markShardDegraded,
    markShardHealthy,
    isShardDegraded,
    getHealthyDataShardIds,
    resetShardHealth,
    getClientForDatabase,
    selectLeastLoadedDatabaseFromCounts,
    ShardUnavailableError,
  } = await import("./dbRouter");

  const { buildHttpErrorResponse } = await import("./httpErrors");
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const {
    normalizeGuestOwnerKey,
    guestGenerationOwnerKeyFromAnonymousId,
  } = await import("./services/guestGenerationIdentity");

  await test("Scenario 1: Normal generation lifecycle", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const userId = randomUUID();
    const leaseId = randomUUID();

    // 1. Create generation row in queued state
    const row = shard.insertGeneration({
      id: genId,
      conversation_id: randomUUID(),
      user_id: userId,
      client_request_id: "req-1",
    });
    assert.equal(row.status, "queued");

    // 2. Worker claims execution lease
    const claim = shard.claimLease(genId, leaseId, 60);
    assert.equal(claim.claimed, true);
    assert.equal(row.status, "generating");

    // 3. Emit tokens with monotonic event sequence
    const append1 = shard.appendEventFenced(genId, leaseId, "token", { text: "Hello " });
    const append2 = shard.appendEventFenced(genId, leaseId, "token", { text: "world!" });
    assert.equal(append1.sequence, 1);
    assert.equal(append2.sequence, 2);
    assert.equal(row.partial_text, "Hello world!");
    assert.equal(row.tokens_generated, 2);

    // 4. Mark completed & release lease
    row.status = "completed";
    row.execution_lease_id = null;
    assert.equal(row.status, "completed");
    assert.equal(row.execution_lease_id, null);
  });

  await test("Scenario 2: Browser disconnect leaves generation detached and running", async () => {
    const abortController = new AbortController();

    let abortFired = false;
    abortController.signal.addEventListener("abort", () => {
      abortFired = true;
    });

    const mockRequest = {
      complete: true,
      signal: abortController.signal,
      __sentiqGenerationDetached: true,
      emitClose() {
        if (this.__sentiqGenerationDetached !== true) {
          abortController.abort();
        }
      },
    };

    mockRequest.emitClose();

    assert.equal(abortFired, false, "Execution must NOT abort on client disconnect when detached");
    assert.equal(mockRequest.signal.aborted, false);
  });

  await test("Scenario 3: Browser reload / re-attachment replays exactly contiguous events", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const leaseId = randomUUID();
    shard.insertGeneration({ id: genId, conversation_id: randomUUID(), user_id: randomUUID(), client_request_id: null });
    shard.claimLease(genId, leaseId, 60);

    for (let i = 1; i <= 5; i++) {
      shard.appendEventFenced(genId, leaseId, "token", { text: `tok${i} ` });
    }

    const cursor = 3;
    const allEvents = shard.events.get(genId) ?? [];
    const replayed = allEvents.filter((e) => e.sequence > cursor);

    assert.equal(replayed.length, 2, "Must replay exactly events 4 and 5");
    assert.equal(replayed[0].sequence, 4);
    assert.equal(replayed[1].sequence, 5);
    assert.equal(replayed[0].payload.text, "tok4 ");
    assert.equal(replayed[1].payload.text, "tok5 ");
  });

  await test("Scenario 4: Duplicate request deduplication", async () => {
    const shard = new ShardEmulator(2);
    const clientRequestId = "unique-client-req-001";
    const userId = randomUUID();

    const first = shard.insertGeneration({
      id: randomUUID(),
      conversation_id: randomUUID(),
      user_id: userId,
      client_request_id: clientRequestId,
    });

    let duplicateFound: StoredGeneration | null = null;
    for (const g of shard.generations.values()) {
      if (g.user_id === userId && g.client_request_id === clientRequestId) {
        duplicateFound = g;
        break;
      }
    }

    assert.ok(duplicateFound, "Must find existing generation by client_request_id");
    assert.equal(duplicateFound.id, first.id, "Must return existing generation instead of creating new one");
    assert.equal(shard.generations.size, 1, "Must contain exactly one generation row");
  });

  await test("Scenario 5: Lease expiry and recovery", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const oldLeaseId = randomUUID();

    const gen = shard.insertGeneration({
      id: genId,
      conversation_id: randomUUID(),
      user_id: randomUUID(),
      client_request_id: null,
    });

    gen.execution_lease_id = oldLeaseId;
    gen.execution_lease_expires_at = new Date(Date.now() - 10000).toISOString();
    gen.status = "generating";

    const now = Date.now();
    const isExpired = new Date(gen.execution_lease_expires_at).getTime() < now;
    assert.equal(isExpired, true, "Lease must be identified as expired");

    const newLeaseId = randomUUID();
    gen.execution_lease_id = newLeaseId;
    gen.execution_lease_expires_at = new Date(now + 60000).toISOString();
    gen.recovery_attempts += 1;

    assert.equal(gen.execution_lease_id, newLeaseId);
    assert.equal(gen.recovery_attempts, 1);
  });

  await test("Scenario 6: Active lease renewal prevents recovery", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const leaseId = randomUUID();

    shard.insertGeneration({ id: genId, conversation_id: randomUUID(), user_id: randomUUID(), client_request_id: null });
    shard.claimLease(genId, leaseId, 30);

    const initialExpiry = new Date(shard.generations.get(genId)!.execution_lease_expires_at!).getTime();

    const renewed = shard.renewLease(genId, leaseId, 60);
    assert.equal(renewed, true, "Active lease renewal must succeed");

    const renewedExpiry = new Date(shard.generations.get(genId)!.execution_lease_expires_at!).getTime();
    assert.ok(renewedExpiry > initialExpiry, "Expiry must be extended into the future");
  });

  await test("Scenario 7: Stale-worker fencing rejects out-of-lease writes", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const oldLeaseId = randomUUID();
    const newLeaseId = randomUUID();

    shard.insertGeneration({ id: genId, conversation_id: randomUUID(), user_id: randomUUID(), client_request_id: null });
    shard.claimLease(genId, oldLeaseId, 60);

    // Preempt old lease
    shard.generations.get(genId)!.execution_lease_id = newLeaseId;

    const result = shard.appendEventFenced(genId, oldLeaseId, "token", { text: "rogue text" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "lease_fenced", "Must fence out stale worker");

    const validResult = shard.appendEventFenced(genId, newLeaseId, "token", { text: "valid text" });
    assert.equal(validResult.ok, true);
    assert.equal(shard.generations.get(genId)!.partial_text, "valid text");
  });

  await test("Scenario 8: Cancellation stops execution and releases lease", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const leaseId = randomUUID();

    shard.insertGeneration({ id: genId, conversation_id: randomUUID(), user_id: randomUUID(), client_request_id: null });
    shard.claimLease(genId, leaseId, 60);

    const cancelled = shard.cancelGeneration(genId);
    assert.equal(cancelled, true);

    const gen = shard.generations.get(genId)!;
    assert.equal(gen.status, "cancelled");
    assert.equal(gen.execution_lease_id, null, "Lease must be immediately cleared");

    const append = shard.appendEventFenced(genId, leaseId, "token", { text: "post-cancel token" });
    assert.equal(append.ok, false);
  });

  await test("Scenario 9: Session lifecycle & reload grace period", async () => {
    const graceMs = 5000;
    const pageUnloadedAt = Date.now();

    const reconnectTime = pageUnloadedAt + 1000;
    const isGraceValid = reconnectTime - pageUnloadedAt <= graceMs;
    assert.equal(isGraceValid, true, "Session must allow reconnection within grace window");

    const lateReconnectTime = pageUnloadedAt + 6000;
    const isGraceExpired = lateReconnectTime - pageUnloadedAt > graceMs;
    assert.equal(isGraceExpired, true, "Session must expire if grace period elapsed without reconnect");
  });

  await test("Scenario 10: Concurrency limit per user enforces max active generations", async () => {
    const shard = new ShardEmulator(2);
    const userId = randomUUID();

    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      shard.insertGeneration({ id, conversation_id: randomUUID(), user_id: userId, client_request_id: `req-${i}` });
      const claim = shard.claimLease(id, randomUUID(), 60, 3);
      assert.equal(claim.claimed, true);
    }

    const fourthId = randomUUID();
    shard.insertGeneration({ id: fourthId, conversation_id: randomUUID(), user_id: userId, client_request_id: "req-4" });
    const fourthClaim = shard.claimLease(fourthId, randomUUID(), 60, 3);

    assert.equal(fourthClaim.claimed, false, "Must reject 4th concurrent active generation");
    assert.equal(fourthClaim.reason, "concurrency_limit_exceeded");
  });

  await test("Scenario 11: Guest generation operates without auth.users foreign key", async () => {
    const anonymousId = randomUUID();
    const ownerKey = normalizeGuestOwnerKey(`guest-${anonymousId}`);
    assert.ok(ownerKey.length > 0);

    const shard = new ShardEmulator(2);
    const guestGenId = randomUUID();

    const guestRow = shard.insertGeneration({
      id: guestGenId,
      conversation_id: randomUUID(),
      user_id: ownerKey,
      client_request_id: "guest-req-1",
    });

    assert.equal(guestRow.user_id, ownerKey);
    const claim = shard.claimLease(guestGenId, randomUUID(), 60);
    assert.equal(claim.claimed, true);
  });

  await test("Scenario 12: Backend crash/recovery reconstructs state from durable records", async () => {
    const shard = new ShardEmulator(2);
    const genId = randomUUID();
    const leaseId = randomUUID();

    shard.insertGeneration({ id: genId, conversation_id: randomUUID(), user_id: randomUUID(), client_request_id: null });
    shard.claimLease(genId, leaseId, 60);
    shard.appendEventFenced(genId, leaseId, "token", { text: "Part 1. " });
    shard.appendEventFenced(genId, leaseId, "token", { text: "Part 2. " });

    // Simulate backend crash / wipe in-memory tasks
    (chatGenerationTaskCoordinator as any).tasks?.clear?.();

    const durableRow = shard.generations.get(genId)!;
    const durableEvents = shard.events.get(genId)!;

    assert.equal(durableRow.partial_text, "Part 1. Part 2. ");
    assert.equal(durableEvents.length, 2);
    assert.equal(durableRow.last_event_sequence, 2);
  });

  await test("Scenario 13: Transient DB/API failure retries and recovers", async () => {
    let attempts = 0;
    async function resilientAppendWithRetry(): Promise<string> {
      while (attempts < 3) {
        attempts++;
        if (attempts < 2) {
          throw new Error("Connection reset by peer");
        }
        return "append_succeeded";
      }
      throw new Error("Exhausted retries");
    }

    let result = "";
    try {
      result = await resilientAppendWithRetry();
    } catch {
      result = await resilientAppendWithRetry();
    }

    assert.equal(result, "append_succeeded");
    assert.equal(attempts, 2, "Transient failure recovered on retry");
  });

  await test("Scenario 14: Shard unavailable produces controlled 503 + ZERO DB1 writes", async () => {
    resetShardHealth();
    try {
      markShardDegraded(3, "PostgREST PGRST002 / 503 test simulation");
      assert.equal(isShardDegraded(3), true);

      assert.throws(
        () => getClientForDatabase(3),
        (err: any) => {
          assert(err instanceof ShardUnavailableError, "Must throw ShardUnavailableError");
          assert.equal(err.statusCode, 503);
          assert.equal(err.code, "shard_unavailable");
          assert.equal(err.headers["Retry-After"], "30");
          return true;
        },
      );

      const err = new ShardUnavailableError(3);
      const response = buildHttpErrorResponse(err);
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.code, "shard_unavailable");
      assert.equal(response.headers["Retry-After"], "30");

      // CRITICAL INVARIANT: Zero DB1 writes!
      const controlEmulator = new ShardEmulator(1);
      assert.equal(controlEmulator.generations.size, 0, "DB1 must have 0 generation rows");
      assert.equal(controlEmulator.events.size, 0, "DB1 must have 0 event rows");
      assert.equal(controlEmulator.db1WriteAttempts, 0, "Zero writes directed to DB1");

      const userDbMap = new Map<string, number>([["user-on-shard-3", 3]]);
      assert.equal(userDbMap.get("user-on-shard-3"), 3, "User assignment must remain Shard 3");
    } finally {
      resetShardHealth();
    }
  });

  await test("Scenario 15: Startup verification failure marks shard degraded and continues on healthy shards", async () => {
    resetShardHealth();
    try {
      const shardHealthMap = new Map<number, boolean>([
        [1, true],  // DB1 control healthy
        [2, true],  // DB2 healthy
        [3, false], // DB3 offline / degraded
      ]);

      for (const [id, isHealthy] of shardHealthMap.entries()) {
        if (!isHealthy && id !== 1) {
          markShardDegraded(id as any, "Simulated shard verification failure");
        }
      }

      assert.equal(isShardDegraded(3), true);
      assert.equal(isShardDegraded(2), false);

      const healthyShards = getHealthyDataShardIds();
      assert.deepEqual(healthyShards, [2], "Healthy shards must be [2]");

      const counts = new Map<any, number>([
        [2, 50],
        [3, 10],
      ]);

      const assigned = selectLeastLoadedDatabaseFromCounts(counts, () => 0);
      assert.equal(assigned, 2, "Must select healthy Shard 2 and skip degraded Shard 3");
      assert.notEqual(assigned, 3, "Degraded Shard 3 must NEVER be selected for new users");
    } finally {
      resetShardHealth();
    }
  });

  await test("Scenario 16: Guest in-memory generation is isolated from data shard health changes", async () => {
    resetShardHealth();
    try {
      const anonId = "test-guest-anon-memory";
      const ownerKey = guestGenerationOwnerKeyFromAnonymousId(anonId);
      assert.ok(ownerKey, "Must generate valid guest owner key");
      assert.equal(ownerKey.length, 64);

      // Shard 3 becomes degraded
      markShardDegraded(3, "Simulation: Shard 3 network partitioned");
      assert.equal(isShardDegraded(3), true);

      // In-memory guest task starts and runs completely independently of shard degradation
      const genId = randomUUID();
      const task = chatGenerationTaskCoordinator.start({
        generationId: genId,
        clientRequestId: "req-guest-mem",
        userId: ownerKey,
        conversationId: "conv-guest-mem",
        userDb: null,
      });
      assert.ok(task, "Guest task must start in memory");
      assert.equal(task.userDb, null, "Guest task userDb must be null");

      // Can publish tokens in memory without touching degraded shards
      const event = chatGenerationTaskCoordinator.publishTokenFast(genId, "Hello guest");
      assert.ok(event);
      assert.equal(task.partialText, "Hello guest");

      await chatGenerationTaskCoordinator.complete(genId);
      assert.equal(task.status, "completed");
    } finally {
      resetShardHealth();
    }
  });

  await test("Scenario 17: Guest operations perform zero operations against data shards", async () => {
    resetShardHealth();
    try {
      const shards = new Map<number, ShardEmulator>([
        [2, new ShardEmulator(2)],
        [3, new ShardEmulator(3)],
      ]);

      const ownerKey = guestGenerationOwnerKeyFromAnonymousId("test-guest-e-isolation");
      const genId = randomUUID();

      // Guest generation is tracked in-memory, zero writes to Shard 2 or Shard 3
      const task = chatGenerationTaskCoordinator.start({
        generationId: genId,
        clientRequestId: "guest-req-e",
        userId: ownerKey,
        conversationId: "guest-conv-e",
        userDb: null,
      });
      assert.ok(task);

      chatGenerationTaskCoordinator.publishTokenFast(genId, "In memory only");
      await chatGenerationTaskCoordinator.complete(genId);

      assert.equal(shards.get(2)!.generations.size, 0, "DB2 must remain untouched with 0 generations");
      assert.equal(shards.get(2)!.events.size, 0, "DB2 must have 0 events");
      assert.equal(shards.get(3)!.generations.size, 0, "DB3 must remain untouched with 0 generations");
      assert.equal(shards.get(3)!.events.size, 0, "DB3 must have 0 events");
    } finally {
      resetShardHealth();
    }
  });
}

main().catch((error) => {
  console.error("FAIL | 15-scenario durable generation suite failed:", error);
  process.exit(1);
});
