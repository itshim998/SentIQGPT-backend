import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "crypto";

const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260817140000_durable_guest_generations.sql"), "utf8");
const identity = fs.readFileSync(path.resolve(__dirname, "services/guestGenerationIdentity.ts"), "utf8");
const transport = fs.readFileSync(path.resolve(__dirname, "chatGenerationTransportBootstrap.ts"), "utf8");
const recovery = fs.readFileSync(path.resolve(__dirname, "services/guestGenerationRecovery.ts"), "utf8");
const authRecovery = fs.readFileSync(path.resolve(__dirname, "services/generationRecovery.ts"), "utf8");
const server = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");

test("legacy schema integrity: guest generation tables and RPCs remain as legacy schema", () => {
  assert.match(migration, /create table if not exists public\.guest_chat_generations/);
  assert.match(migration, /user_id text not null/);
  assert.match(migration, /guest_chat_generation_events/);
  assert.match(migration, /recovery_attempts integer not null default 0/);
  assert.doesNotMatch(migration, /references auth\.users/);

  assert.match(migration, /claim_guest_chat_generation_execution/);
  assert.match(migration, /renew_guest_chat_generation_execution_lease/);
  assert.match(migration, /release_guest_chat_generation_execution_lease/);
  assert.match(migration, /request_guest_chat_generation_cancel/);
  assert.match(migration, /append_guest_chat_generation_event_fenced/);
});

test("guest identity is database-independent and isolated from dbRouter", () => {
  assert.match(identity, /GUEST_OWNER_KEY_VERSION/);
  assert.match(identity, /guestGenerationOwnerKeyFromAnonymousId/);
  assert.match(identity, /getGuestGenerationOwnerKeyForRequest/);
  assert.doesNotMatch(identity, /dbRouter/);
  assert.doesNotMatch(identity, /getDataShardDatabases/);
  assert.doesNotMatch(identity, /ASSIGNABLE_DATABASE_IDS/);
});

test("guest transport uses memory-only execution without durable generation store calls", () => {
  assert.doesNotMatch(transport, /getGuestGenerationDatabase/);
  assert.match(transport, /getGuestGenerationOwnerKeyForRequest/);
  assert.match(transport, /findByUserAndClientRequestId/);
  assert.match(transport, /userDb:\s*null/);
  const guestBlock = transport.slice(transport.indexOf("if (!requestUser?.isGuest)"));
  assert.doesNotMatch(guestBlock, /createChatGeneration/);
  assert.doesNotMatch(guestBlock, /getChatGenerationByClientRequestId/);
  assert.doesNotMatch(guestBlock, /updateChatGenerationExecutionSnapshot/);
});

test("guest startup recovery is removed from server while authenticated recovery remains", () => {
  assert.doesNotMatch(server, /guestGenerationRecovery/);
  assert.match(server, /import "\.\/services\/generationRecovery"/);
  assert.match(authRecovery, /recoverStaleGenerations/);
  assert.doesNotMatch(recovery, /setTimeout/);
  assert.doesNotMatch(recovery, /select\("id,/);
});

test("runtime: guest owner key derivation is deterministic and versioned", async () => {
  const { guestGenerationOwnerKeyFromAnonymousId, getGuestGenerationOwnerKeyForRequest } = await import("./services/guestGenerationIdentity");
  const key1 = guestGenerationOwnerKeyFromAnonymousId("anon-client-123");
  const key2 = guestGenerationOwnerKeyFromAnonymousId("anon-client-123");
  const keyDiff = guestGenerationOwnerKeyFromAnonymousId("anon-client-456");

  assert.equal(key1, key2);
  assert.notEqual(key1, keyDiff);
  assert.equal(key1.length, 64);

  const reqMock = { headers: { "x-sentiq-anonymous-id": "anon-client-123" } };
  assert.equal(getGuestGenerationOwnerKeyForRequest(reqMock), key1);

  const reqFallback = { headers: { "user-agent": "test-agent" }, ip: "192.168.1.1" };
  const fallbackKey = getGuestGenerationOwnerKeyForRequest(reqFallback);
  assert.ok(fallbackKey);
  assert.equal(fallbackKey.length, 64);
});

test("runtime: in-memory guest duplicate lookup is strictly scoped to owner key and clientRequestId", async () => {
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const ownerA = "guest-owner-aaa";
  const ownerB = "guest-owner-bbb";
  const clientReqId = "req-shared-client-id-123";
  const genIdA = randomUUID();

  const taskA = chatGenerationTaskCoordinator.start({
    generationId: genIdA,
    clientRequestId: clientReqId,
    userId: ownerA,
    conversationId: "conv-a",
    userDb: null,
  });

  try {
    // Exact match for ownerA + clientReqId
    const foundA = chatGenerationTaskCoordinator.findByUserAndClientRequestId(ownerA, clientReqId);
    assert.ok(foundA);
    assert.equal(foundA?.generationId, genIdA);

    // Cross-guest isolation: ownerB with same clientReqId must NOT match ownerA's task
    const foundB = chatGenerationTaskCoordinator.findByUserAndClientRequestId(ownerB, clientReqId);
    assert.equal(foundB, null, "Guest B must not match Guest A's task");

    // Missing clientReqId
    assert.equal(chatGenerationTaskCoordinator.findByUserAndClientRequestId(ownerA, "unknown-req"), null);
  } finally {
    await chatGenerationTaskCoordinator.complete(genIdA);
  }
});

test("runtime: guest task executes in memory with userDb: null and streams events", async () => {
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const { registerChatGenerationExecutor } = await import("./services/chatGenerationExecutor");
  const { runGeneration } = await import("./services/generationRunner");

  const genId = randomUUID();
  const guestOwner = "guest-runtime-exec-owner";

  registerChatGenerationExecutor((req, sink, finish) => {
    assert.equal(req.user?.isGuest, true, "Execution request must preserve isGuest: true");
    assert.equal(req.userDb, null, "Guest userDb must be null");
    sink.writeEvent({ type: "token", text: "Hello " });
    sink.writeEvent({ type: "token", text: "World" });
    sink.end();
    finish();
  });

  const task = chatGenerationTaskCoordinator.start({
    generationId: genId,
    clientRequestId: "req-exec-1",
    userId: guestOwner,
    conversationId: "conv-exec-1",
    userDb: null,
    liveExecutionSnapshot: {
      body: { message: "hi" },
      user: { sub: guestOwner, isGuest: true },
    },
  });

  const events: any[] = [];
  chatGenerationTaskCoordinator.subscribe(genId, (event) => {
    events.push(event);
  });

  await runGeneration(genId);

  assert.equal(task.status, "completed");
  assert.equal(task.terminal, true);
  assert.equal(task.partialText, "Hello World");
  assert.equal(task.tokensGenerated, 2);

  const tokenEvents = events.filter((e) => e.type === "token");
  assert.equal(tokenEvents.length, 2);
  assert.equal(tokenEvents[0].text, "Hello ");
  assert.equal(tokenEvents[1].text, "World");
});

test("runtime: second guest cannot inspect or cancel first guest's task", async () => {
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const owner1 = "guest-owner-1";
  const owner2 = "guest-owner-2";
  const genId = randomUUID();

  const task = chatGenerationTaskCoordinator.start({
    generationId: genId,
    clientRequestId: "req-owner-iso",
    userId: owner1,
    conversationId: "conv-iso",
    userDb: null,
  });

  try {
    // Owner 1 matches
    assert.equal(task.userId, owner1);
    assert.notEqual(task.userId, owner2);

    // Verify coordinator isolation
    const matched = chatGenerationTaskCoordinator.findByUserAndClientRequestId(owner2, "req-owner-iso");
    assert.equal(matched, null, "Guest 2 cannot find Guest 1 task by client request id");
  } finally {
    await chatGenerationTaskCoordinator.complete(genId);
  }
});

test("runtime: in-memory guest cancellation and status snapshot work cleanly", async () => {
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const genId = randomUUID();
  const owner = "guest-cancel-owner";

  const task = chatGenerationTaskCoordinator.start({
    generationId: genId,
    clientRequestId: "req-cancel-test",
    userId: owner,
    conversationId: "conv-cancel-test",
    userDb: null,
  });

  const snapshotInitial = await chatGenerationTaskCoordinator.snapshot(genId);
  assert.equal(snapshotInitial.status, "queued");
  assert.equal(snapshotInitial.generation_id, genId);

  const cancelResult = await chatGenerationTaskCoordinator.requestCancel(genId);
  assert.equal(cancelResult, true);
  assert.equal(chatGenerationTaskCoordinator.isExplicitCancelRequested(genId), true);

  await chatGenerationTaskCoordinator.cancelled(genId);
  assert.equal(task.status, "cancelled");
  assert.equal(task.terminal, true);

  const snapshotFinal = await chatGenerationTaskCoordinator.snapshot(genId);
  assert.equal(snapshotFinal.status, "cancelled");
  assert.equal(snapshotFinal.terminal, true);
});

test("runtime: authenticated durability persists fenced events and claims durable lease when userDb is present", async () => {
  const { chatGenerationTaskCoordinator } = await import("./services/chatGenerationTaskCoordinator");
  const genId = randomUUID();
  const userId = "auth-user-durability-test";
  const leaseId = randomUUID();

  const rpcCalls: Array<{ name: string; args: any }> = [];
  const fakeUserDb = {
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name === "append_chat_generation_event_fenced") {
        return { data: { sequence: 1 }, error: null };
      }
      if (name === "release_chat_generation_execution_lease") {
        return { data: { released: true }, error: null };
      }
      return { data: null, error: null };
    },
  };

  const task = chatGenerationTaskCoordinator.start({
    generationId: genId,
    clientRequestId: "req-auth-durability",
    userId,
    conversationId: "conv-auth-durability",
    userDb: fakeUserDb,
    generation: {
      id: genId,
      conversation_id: "conv-auth-durability",
      user_id: userId,
      client_request_id: "req-auth-durability",
      generation_session_id: null,
      status: "running",
      execution_mode: "fast",
      model_route: null,
      execution_snapshot: {},
      started_at: new Date().toISOString(),
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      error_code: null,
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      execution_lease_id: leaseId,
      execution_lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      recovery_attempts: 0,
      last_execution_error: null,
    },
  });

  task.executionLeaseId = leaseId;

  await chatGenerationTaskCoordinator.publish(genId, {
    type: "token",
    text: "Authenticated persistent token",
  });

  await chatGenerationTaskCoordinator.complete(genId);

  // Authenticated tasks with userDb MUST persist fenced events to the database
  const fencedEvents = rpcCalls.filter((c) => c.name === "append_chat_generation_event_fenced");
  assert.ok(fencedEvents.length > 0, "Authenticated generation must persist fenced events via DB RPC");
  assert.equal(fencedEvents[0].args.p_user_id, userId);
  assert.equal(fencedEvents[0].args.p_lease_id, leaseId);
});
