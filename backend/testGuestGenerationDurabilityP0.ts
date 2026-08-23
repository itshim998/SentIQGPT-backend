import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const migration = fs.readFileSync(path.resolve(__dirname, "../supabase/migrations/20260817140000_durable_guest_generations.sql"), "utf8");
const store = fs.readFileSync(path.resolve(__dirname, "services/guestGenerationStore.ts"), "utf8");
const transport = fs.readFileSync(path.resolve(__dirname, "chatGenerationTransportBootstrap.ts"), "utf8");
const recovery = fs.readFileSync(path.resolve(__dirname, "services/guestGenerationRecovery.ts"), "utf8");
const server = fs.readFileSync(path.resolve(__dirname, "server.ts"), "utf8");

test("guest generation persistence exists outside auth.users", () => {
  assert.match(migration, /create table if not exists public\.guest_chat_generations/);
  assert.match(migration, /user_id text not null/);
  assert.match(migration, /guest_chat_generation_events/);
  assert.match(migration, /recovery_attempts integer not null default 0/);
  assert.doesNotMatch(migration, /references auth\.users/);
});

test("guest generation lease and fenced event RPCs exist", () => {
  assert.match(migration, /claim_guest_chat_generation_execution/);
  assert.match(migration, /renew_guest_chat_generation_execution_lease/);
  assert.match(migration, /release_guest_chat_generation_execution_lease/);
  assert.match(migration, /request_guest_chat_generation_cancel/);
  assert.match(migration, /append_guest_chat_generation_event_fenced/);
});

test("guest owner uses one canonical durable hash for routing", () => {
  assert.match(store, /getDataShardDatabases/);
  assert.match(store, /GUEST_OWNER_KEY_VERSION/);
  assert.match(store, /guestGenerationOwnerKeyFromAnonymousId/);
  assert.match(store, /return createGuestGenerationDbProxy\(DATA_SHARDS\[shardIndex\(ownerKey\)\]\)/);
  assert.doesNotMatch(store, /shardIndex\(createHash\("sha256"\)/);
  assert.match(store, /\.eq\("user_id", normalizeGuestOwnerKey\(ownerKey\)\)/);
  assert.match(store, /claimGuestGenerationRecoveryAttempt/);
});

test("guest transport uses durable generation store rather than in-memory fallback", () => {
  assert.match(transport, /getGuestGenerationDatabase/);
  assert.match(transport, /getGuestGenerationOwnerKeyForRequest/);
  assert.match(transport, /createChatGeneration\(userDb, \{ conversationId, userId, clientRequestId/);
  assert.doesNotMatch(transport, /const generationId = requestedGenerationId; request\.body = .*const task = chatGenerationTaskCoordinator\.get\(generationId\);\n  return \{ requestUser, userId, userDb: null/);
});

test("guest recovery uses the canonical owner key and durably claims attempts", () => {
  assert.match(recovery, /getGuestGenerationDatabase\(row\.user_id\)/);
  assert.match(recovery, /claimGuestGenerationRecoveryAttempt/);
  assert.match(recovery, /row\.recovery_attempts/);
  assert.match(recovery, /if \(!attempt\.claimed\) return/);
  assert.match(recovery, /recordGuestGenerationRecoveryFailure/);
});

test("guest generations are included in startup recovery", () => {
  assert.match(recovery, /guest_chat_generations/);
  assert.match(recovery, /runGeneration\(row\.id\)/);
  assert.match(server, /guestGenerationRecovery/);
});
