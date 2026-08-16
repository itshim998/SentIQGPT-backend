import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/20260816150000_add_chat_generations.sql"),
  "utf8",
);
const service = fs.readFileSync(
  path.join(root, "backend/services/chatGenerationService.ts"),
  "utf8",
);
const disconnectLifecycle = fs.readFileSync(
  path.join(root, "backend/streamDisconnectLifecycle.ts"),
  "utf8",
);

assert.match(migration, /create table if not exists public\.chat_generations/);
assert.match(migration, /id uuid primary key default gen_random_uuid\(\)/);
assert.match(migration, /conversation_id uuid not null references public\.conversations/);
assert.match(migration, /user_id uuid not null references public\.users/);
assert.match(migration, /client_request_id text/);
for (const status of [
  "queued",
  "running",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "waiting_for_tool",
  "generating",
  "persisting",
]) {
  assert.match(migration, new RegExp(`'${status}'`), `missing generation status: ${status}`);
}
assert.match(migration, /execution_mode text/);
assert.match(migration, /model_route text/);
assert.match(migration, /partial_text text not null default ''/);
assert.match(migration, /tokens_generated bigint not null default 0/);
assert.match(migration, /last_event_sequence bigint not null default 0/);
assert.match(migration, /messages[\s\S]*add column if not exists generation_id uuid/);
assert.match(migration, /messages_settle_chat_generation/);
assert.match(migration, /new\.generation_id := v_generation_id/);
assert.match(migration, /request_chat_generation_cancel/);
assert.match(migration, /cancel_chat_generation/);

// Cancellation is an explicit lifecycle operation. The generation migration
// must contain no trigger that observes streamDisconnectLifecycle or response
// connection state.
assert.doesNotMatch(migration, /streamDisconnectLifecycle|subscriber disconnect|response close/i);
assert.doesNotMatch(service, /streamDisconnectLifecycle|response close|subscriber.*cancel/i);
assert.match(service, /CHAT_GENERATION_CANCELLATION_INVARIANT/);
assert.match(service, /SSE subscriber disconnects do not cancel chat generations/);

// The existing stream lifecycle remains transport-aware for now; Phase 1/2 must
// not silently rewrite its semantics. Phase 3 will switch it from generation
// cancellation to subscriber detachment.
assert.match(disconnectLifecycle, /attachStreamDisconnectLifecycle/);

console.log("PASS | Chat generation Phase 1/2 identity + durable-state contracts are intact.");
