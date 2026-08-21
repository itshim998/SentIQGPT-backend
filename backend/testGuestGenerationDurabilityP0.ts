import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL(".", import.meta.url);
const migration = fs.readFileSync(new URL("../supabase/migrations/20260817140000_durable_guest_generations.sql", import.meta.url), "utf8");
const store = fs.readFileSync(new URL("./services/guestGenerationStore.ts", import.meta.url), "utf8");
const transport = fs.readFileSync(new URL("./chatGenerationTransportBootstrap.ts", import.meta.url), "utf8");
const recovery = fs.readFileSync(new URL("./services/guestGenerationRecovery.ts", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("./server.ts", import.meta.url), "utf8");

void root;

test("guest generation persistence exists outside auth.users", () => {
  assert.match(migration, /create table if not exists public\.guest_chat_generations/);
  assert.match(migration, /user_id text not null/);
  assert.match(migration, /guest_chat_generation_events/);
  assert.doesNotMatch(migration, /references auth\.users/);
});

test("guest generation lease and fenced event RPCs exist", () => {
  assert.match(migration, /claim_guest_chat_generation_execution/);
  assert.match(migration, /renew_guest_chat_generation_execution_lease/);
  assert.match(migration, /release_guest_chat_generation_execution_lease/);
  assert.match(migration, /request_guest_chat_generation_cancel/);
  assert.match(migration, /append_guest_chat_generation_event_fenced/);
});

test("guest owner is deterministically routed to one data shard", () => {
  assert.match(store, /getDataShardDatabases/);
  assert.match(store, /createHash\("sha256"\)/);
  assert.match(store, /chat_generations:\s*"guest_chat_generations"/);
  assert.match(store, /chat_generation_events:\s*"guest_chat_generation_events"/);
});

test("guest transport uses durable generation store rather than in-memory fallback", () => {
  assert.match(transport, /getGuestGenerationDatabase/);
  assert.match(transport, /getGuestGenerationOwnerKeyForRequest/);
  assert.match(transport, /createChatGeneration\(userDb, \{ conversationId, userId, clientRequestId/);
  assert.doesNotMatch(transport, /const generationId = requestedGenerationId; request\.body = .*const task = chatGenerationTaskCoordinator\.get\(generationId\);\n  return \{ requestUser, userId, userDb: null/);
});

test("guest generations are included in startup recovery", () => {
  assert.match(recovery, /guest_chat_generations/);
  assert.match(recovery, /getGuestGenerationDatabase/);
  assert.match(recovery, /runGeneration\(row\.id\)/);
  assert.match(server, /guestGenerationRecovery/);
});
