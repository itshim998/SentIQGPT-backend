import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

async function testEventDeliveryOrderAndDurability() {
  const notifications: number[] = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const userDb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "append_chat_generation_event_fenced") {
        return { data: [{ generation_id: args.p_generation_id, sequence: args.p_sequence, event_payload: args.p_event_payload }], error: null };
      }
      return { data: null, error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
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
  assert.deepEqual(notifications, Array.from({ length: 75 }, (_, index) => index + 1));
  const persisted = rpcCalls.filter((call) => call.name === "append_chat_generation_event_fenced");
  assert.equal(persisted.length, 75, "every emitted event must be durably persisted");
  assert.equal(persisted[persisted.length - 1]?.args.p_sequence, 75, "durable cursor must reach the final emitted event");
  assert.equal(persisted[0]?.args.p_sequence, 1, "durable cursor must begin at sequence 1");
  assert.ok(persisted.every((call) => call.args.p_lease_id === "lease-p0"), "every durable event append must be lease fenced");
}

function testSourceContracts() {
  const lifecycle = read("frontend/scripts/generation-lifecycle.js");
  const transport = read("backend/chatGenerationTransportBootstrap.ts");
  const session = read("frontend/scripts/generation-session.js");
  const runner = read("backend/services/generationRunner.ts");
  const coordinator = read("backend/services/chatGenerationTaskCoordinator.ts");
  const eventsService = read("backend/services/chatGenerationEventService.ts");
  const migration = read("supabase/migrations/20260817123000_durable_generation_event_log.sql");
  const controlsMigration = read("supabase/migrations/20260817113000_harden_generation_p0_controls.sql");

  assert.ok(!lifecycle.includes("handlePageTeardown"), "generation lifecycle must not own page teardown cancellation");
  assert.ok(!lifecycle.includes('window.addEventListener("pagehide"'), "pagehide must not cancel through generation lifecycle");
  assert.ok(transport.includes("bulk_cancellation_requires_explicit_intent"), "bulk cancellation must require explicit intent");
  assert.ok(
    transport.includes("const subscriptionAfter = cursor > 0 ? cursor : Number(persisted?.last_event_sequence ?? task.sequence);"),
    "reconnects with a cursor must subscribe from replay history rather than mixing in a fresh snapshot",
  );
  assert.ok(
    transport.includes("if (cursor === 0) emit(await chatGenerationTaskCoordinator.snapshot(generationId, persisted));"),
    "fresh connections may receive a snapshot, while cursor-based reconnects remain replay-only",
  );
  assert.ok(session.includes('window.addEventListener("pagehide"'), "generation session must remain the lifecycle owner");
  assert.ok(runner.includes("CONTROL_POLL_MS"), "generation runner must poll durable control state");
  assert.ok(runner.includes("executionOwnershipLost"), "generation runner must abort after lease ownership loss");
  assert.ok(runner.includes("getChatGenerationById(userDb"), "generation runner must observe remote cancellation state");
  assert.ok(runner.includes("renewChatGenerationExecutionLease"), "lease renewals must be checked");
  assert.ok(coordinator.includes("executionLeaseId"), "task state must retain the execution lease id");
  assert.ok(coordinator.includes("deliveryChain"), "subscriber delivery must use a serialized queue");
  assert.ok(coordinator.includes("DURABLE_EVENT_POLL_MS"), "subscriptions must poll durable events across replicas");
  assert.ok(coordinator.includes("appendChatGenerationEventFenced"), "emitted events must use the fenced durable append");
  assert.ok(eventsService.includes("listChatGenerationEvents"), "replay must read the durable event log");
  assert.ok(migration.includes("append_chat_generation_event_fenced"), "database must atomically append and advance the durable cursor");
  assert.ok(migration.includes("primary key (generation_id, sequence)"), "event sequence must be unique per generation");
  assert.ok(controlsMigration.includes("set status = 'cancel_requested'"), "session expiry must emit a durable cancellation state");
}

async function main() {
  testSourceContracts();
  await testEventDeliveryOrderAndDurability();
  console.log("Generation P0 hardening tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});