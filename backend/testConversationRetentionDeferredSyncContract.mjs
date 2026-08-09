import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const server = fs.readFileSync(path.join(root, "backend/server.ts"), "utf8");
const policy = fs.readFileSync(path.join(root, "frontend/scripts/services/conversation-ordering-policy.js"), "utf8");
const httpErrors = fs.readFileSync(path.join(root, "backend/httpErrors.ts"), "utf8");

const syncRouteStart = server.indexOf('// POST /api/chat/sync');
const syncRouteEnd = server.indexOf('// PATCH /api/conversations/:id/title', syncRouteStart);
assert.ok(syncRouteStart >= 0 && syncRouteEnd > syncRouteStart, "chat sync route must exist");
const syncRoute = server.slice(syncRouteStart, syncRouteEnd);
assert.match(syncRoute, /const resolvedConversation = await resolveOrCreateConversationForRequest\(/);
assert.doesNotMatch(
  syncRoute.slice(0, syncRoute.indexOf("const resolvedConversation = await resolveOrCreateConversationForRequest(")),
  /try\s*\{[^]*$/,
  "chat sync conversation creation must surface DB retention failures to the HTTP error boundary",
);

const fastBootstrapStart = server.indexOf("const bootstrapFastPersistence = async");
const fastBootstrapEnd = server.indexOf("const persistenceBootstrapPromise = bootstrapFastPersistence();", fastBootstrapStart);
assert.ok(fastBootstrapStart >= 0 && fastBootstrapEnd > fastBootstrapStart, "fast persistence bootstrap must exist");
const fastBootstrap = server.slice(fastBootstrapStart, fastBootstrapEnd);
assert.match(fastBootstrap, /resolveOrCreateConversationForRequest\(/);
assert.match(fastBootstrap, /catch \(conversationCreateError\)/);
assert.match(fastBootstrap, /sync\.reason = "persistence_deferred"/);

const bufferedChatStart = server.indexOf('// POST /api/chat — Main conversation endpoint');
const bufferedChatEnd = server.indexOf('// POST /api/chat/stream', bufferedChatStart);
assert.ok(bufferedChatStart >= 0 && bufferedChatEnd > bufferedChatStart, "buffered chat route must exist");
const bufferedChat = server.slice(bufferedChatStart, bufferedChatEnd);
assert.match(bufferedChat, /catch \(conversationCreateError\)/);
assert.match(bufferedChat, /sync\.deferred = true/);

assert.match(policy, /wrap\("syncChatMessages"/);
assert.match(policy, /String\(error\?\.code \|\| ""\) !== RETENTION_CLEANUP_CODE/);
assert.match(policy, /await cleanupRemoteRetentionSlot\(conversationId\)/);
assert.match(policy, /const result = await method\(\.\.\.args\);/);
assert.match(httpErrors, /conversation_retention_artifact_cleanup_required/);
assert.match(httpErrors, /conversation_retention_cleanup_required/);
assert.match(httpErrors, /statusCode: 409/);

console.log("PASS | Deferred chat persistence -> sync retention cleanup/retry contract is intact.");
