import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

async function testEventDeliveryOrderAndLeaseFence() {
  const notifications: number[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const userDb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return {
        data: [{
          id: "00000000-0000-4000-8000-000000000001",
          conversation_id: "00000000-0000-4000-8000-000000000002",
          user_id: "00000000-0000-4000-8000-000000000003",
          client_request_id: "p0-test",
          generation_session_id: null,
          status: "running",
          execution_lease_id: "lease-p0",
        }],
        error: null,
      };
    },
  };

  const task = chatGenerationTaskCoordinator.start({
    generationId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000003",
    conversationId: "00000000-0000-4000-8000-000000000002",
    userDb,
    generation: {
      id: "00000000-0000-4000-8000-000000000001",
      conversation_id: "00000000-0000-4000-8000-000000000002",
      user_id: "00000000-0000-4000-8000-000000000003",
      client_request_id: "p0-test",
      generation_session_id: null,
      status: "running",
      execution_mode: "fast",
      model_route: null,
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      error_code: null,
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      execution_snapshot: {},
      execution_lease_id: "lease-p0",
      execution_lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      recovery_attempts: 0,
      last_execution_error: null,
    },
  });

  assert.equal(task.executionLeaseId, "lease-p0");
  const unsubscribe = chatGenerationTaskCoordinator.subscribe(task.generationId, (event) => {
    notifications.push(Number(event.sequence));
  }, 0);

  for (let i = 0; i < 75; i += 1) {
    await chatGenerationTaskCoordinator.publish(task.generationId, { type: "token", text: "x" });
  }

  unsubscribe();
  assert.deepEqual(notifications, Array.from({ length: notifications.length }, (_, index) => index + 1));
  const checkpoint = rpcCalls.find((call) => call.name === "checkpoint_chat_generation_fenced");
  assert.ok(checkpoint, "checkpoint must use the fenced RPC");
  assert.equal(checkpoint?.args.p_lease_id, "lease-p0");
  assert.equal(checkpoint?.args.p_last_event_sequence, 76);
}

function testSourceContracts() {
  const lifecycle = read("frontend/scripts/generation-lifecycle.js");
  const transport = read("backend/chatGenerationTransportBootstrap.ts");
  const session = read("frontend/scripts/generation-session.js");
  const runner = read("backend/services/generationRunner.ts");
  const coordinator = read("backend/services/chatGenerationTaskCoordinator.ts");
  const migration = read("supabase/migrations/20260817113000_harden_generation_p0_controls.sql");

  assert.ok(lifecycle.includes("handlePageTeardown"), "legacy page teardown handler should remain visible until fully retired");
  assert.ok(transport.includes("bulk_cancellation_requires_explicit_intent"), "bulk cancellation must require explicit intent");
  assert.ok(session.includes('window.addEventListener("pagehide"'), "generation session must remain the lifecycle owner");
  assert.ok(runner.includes("CONTROL_POLL_MS"), "generation runner must poll durable control state");
  assert.ok(runner.includes("executionOwnershipLost"), "generation runner must abort after lease ownership loss");
  assert.ok(runner.includes("renewChatGenerationExecutionLease"), "lease renewals must be checked");
  assert.ok(coordinator.includes("executionLeaseId"), "task state must retain the execution lease id");
  assert.ok(coordinator.includes("checkpointChatGenerationFenced"), "checkpoint writes must be lease fenced");
  assert.ok(coordinator.includes("finalizeChatGenerationFenced"), "terminal writes must be lease fenced");
  assert.ok(migration.includes("checkpoint_chat_generation_fenced"), "database must expose fenced checkpoint mutation");
  assert.ok(migration.includes("finalize_chat_generation_fenced"), "database must expose fenced terminal mutation");
  assert.ok(migration.includes("status = 'cancel_requested'"), "session expiry must emit a durable cancellation state");
}

async function main() {
  testSourceContracts();
  await testEventDeliveryOrderAndLeaseFence();
  console.log("Generation P0 hardening tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
