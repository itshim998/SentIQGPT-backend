import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const runner = fs.readFileSync(path.resolve(__dirname, "services/generationRunner.ts"), "utf8");
const coordinator = fs.readFileSync(path.resolve(__dirname, "services/chatGenerationTaskCoordinator.ts"), "utf8");
const service = fs.readFileSync(path.resolve(__dirname, "services/chatGenerationService.ts"), "utf8");
const transport = fs.readFileSync(path.resolve(__dirname, "chatGenerationTransportBootstrap.ts"), "utf8");
const eventService = fs.readFileSync(path.resolve(__dirname, "services/chatGenerationEventService.ts"), "utf8");
const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260816162000_add_generation_execution_snapshot.sql"), "utf8");
const eventLogMigration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260817123000_durable_generation_event_log.sql"), "utf8");

test("Phase 5 runner is transport-independent", () => {
  assert.match(runner, /export async function runGeneration\(generationId: string\)/);
  assert.match(runner, /GenerationExecutionRequest/);
  assert.match(runner, /GenerationEventSink/);
  assert.doesNotMatch(runner, /import .*express/);
  assert.doesNotMatch(runner, /\bResponse\b/);
});

test("Phase 5 transport starts runner and keeps Express response at subscription boundary", () => {
  assert.match(transport, /runGeneration\(context\.generationId\)/);
  assert.match(transport, /openGenerationSubscription\(res/);
  assert.match(transport, /res\.status\(202\)\.json/);
  assert.doesNotMatch(transport, /startLegacyGeneration/);
});

test("Phase 6 generation progress is durably persisted through the fenced event log", () => {
  assert.match(coordinator, /appendChatGenerationEventFenced/);
  assert.match(coordinator, /partialText: state\?\.partialText \?\? task\.partialText/);
  assert.match(coordinator, /tokensGenerated: state\?\.tokensGenerated \?\? task\.tokensGenerated/);
  assert.match(coordinator, /status: durableStatus/);
  assert.match(eventService, /append_chat_generation_event_fenced/);
});

test("Phase 6 persists execution snapshot and partial output", () => {
  assert.match(service, /execution_snapshot/);
  assert.match(service, /partial_text/);
  assert.match(service, /updateChatGenerationExecutionSnapshot/);
  assert.match(migration, /add column if not exists execution_snapshot jsonb/);
});

test("Phase 7 seeds event sequence from durable state and exposes durable replay metadata", () => {
  assert.match(coordinator, /sequence: persistedSequence/);
  assert.match(coordinator, /last_event_sequence/);
  assert.ok(coordinator.includes("private async importDurableEvents(task: Task, afterSequence: number)"));
  assert.ok(coordinator.includes("listChatGenerationEvents(task.userDb, { userId: task.userId, generationId: task.generationId, afterSequence"));
  assert.ok(coordinator.includes("startPolling(task: Task)"));
  assert.ok(coordinator.includes("pollDurableEvents(task: Task)"));
  assert.ok(eventService.includes("list_chat_generation_events"));
  assert.match(eventLogMigration, /primary key \(generation_id, sequence\)/);
});

test("Phase 7 snapshot carries the authoritative sequence for resynchronization", () => {
  assert.match(coordinator, /sequence: task\.sequence/);
  assert.match(coordinator, /terminal: task\.terminal/);
  assert.match(coordinator, /last_event_sequence: sequence/);
});

test("Phase 7 transport replays from the requested contiguous sequence", () => {
  assert.match(transport, /req\.headers\["last-event-id"\] \?\? req\.query\.after/);
  assert.match(transport, /subscribe\(generationId, \(event\)/);
  assert.match(transport, /Math\.max\(0, afterSequence\)/);
});
