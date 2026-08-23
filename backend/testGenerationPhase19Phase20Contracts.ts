import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const eventTypes = fs.readFileSync(path.join(root, "backend/services/generationEventTypes.ts"), "utf8");
const coordinator = fs.readFileSync(path.join(root, "backend/services/chatGenerationTaskCoordinator.ts"), "utf8");
const runner = fs.readFileSync(path.join(root, "backend/services/generationRunner.ts"), "utf8");
const service = fs.readFileSync(path.join(root, "backend/services/chatGenerationService.ts"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260817100000_add_generation_event_types_and_concurrency.sql"), "utf8");

for (const type of [
  "generation_started", "route", "thinking", "tool_started", "tool_result", "token",
  "structured_response", "generation_checkpoint", "generation_completed",
  "generation_failed", "generation_cancelled",
]) assert.match(eventTypes, new RegExp(`\\"${type}\\"`));

assert.match(coordinator, /generation_id/);
assert.match(coordinator, /conversation_id/);
assert.match(coordinator, /normalizeGenerationEventType/);
assert.match(coordinator, /generation_checkpoint/);
assert.match(runner, /generation_started/);
assert.match(runner, /MAX_ACTIVE_GENERATIONS_PER_USER = 3|MAX_ACTIVE_GENERATIONS_PER_USER/);
assert.match(runner, /55P03/);
assert.match(service, /MAX_ACTIVE_GENERATIONS_PER_USER = 3/);
assert.match(service, /p_max_active_generations/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /p_max_active_generations/);
assert.match(migration, /Generation concurrency limit reached/);

console.log("Generation Phase 19/20 contract checks passed.");
