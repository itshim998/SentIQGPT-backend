import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const runner = fs.readFileSync(path.resolve(__dirname, "services/generationRunner.ts"), "utf8");
const coordinator = fs.readFileSync(path.resolve(__dirname, "services/chatGenerationTaskCoordinator.ts"), "utf8");
const service = fs.readFileSync(path.resolve(__dirname, "services/chatGenerationService.ts"), "utf8");
const transport = fs.readFileSync(path.resolve(__dirname, "chatGenerationTransportBootstrap.ts"), "utf8");
const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260816162000_add_generation_execution_snapshot.sql"), "utf8");

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

test("Phase 6 checkpoints are time- and token-triggered", () => {
  assert.match(coordinator, /CHECKPOINT_INTERVAL_MS = 750/);
  assert.match(coordinator, /CHECKPOINT_TOKEN_INTERVAL = 75/);
  assert.match(coordinator, /now - task\.lastCheckpointAt < CHECKPOINT_INTERVAL_MS/);
  assert.match(coordinator, /tokenDelta < CHECKPOINT_TOKEN_INTERVAL/);
  assert.match(coordinator, /await this\.checkpoint\(task, true\)/);
});

test("Phase 6 persists execution snapshot and partial output", () => {
  assert.match(service, /execution_snapshot/);
  assert.match(service, /partial_text/);
  assert.match(service, /checkpointChatGeneration/);
  assert.match(migration, /add column if not exists execution_snapshot jsonb/);
});

test("Phase 7 seeds event sequence from durable state and exposes replay metadata", () => {
  assert.match(coordinator, /sequence: persistedSequence/);
  assert.match(coordinator, /last_event_sequence/);
  assert.match(coordinator, /getReplayInfo\(generationId, afterSequence = 0\)/);
  assert.match(coordinator, /canReplay/);
  assert.match(coordinator, /Register before replay/);
  assert.match(coordinator, /event\.sequence > Math\.max\(0, Math\.floor\(afterSequence\)\)/);
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
