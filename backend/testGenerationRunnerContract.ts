import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const runner = fs.readFileSync(new URL("./services/generationRunner.ts", import.meta.url), "utf8");
const coordinator = fs.readFileSync(new URL("./services/chatGenerationTaskCoordinator.ts", import.meta.url), "utf8");
const service = fs.readFileSync(new URL("./services/chatGenerationService.ts", import.meta.url), "utf8");
const transport = fs.readFileSync(new URL("./chatGenerationTransportBootstrap.ts", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/20260816162000_add_generation_execution_snapshot.sql", import.meta.url), "utf8");

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
