import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(process.cwd());
const specialPath = path.join(root, "frontend/scripts/services/conversation-special-mode-activity.js");
const livePersistencePath = path.join(root, "backend/live/sentiqLivePersistence.ts");
const authPath = path.join(root, "frontend/scripts/services/auth.js");

const specialSource = fs.readFileSync(specialPath, "utf8");
const liveSource = fs.readFileSync(livePersistencePath, "utf8");
const authSource = fs.readFileSync(authPath, "utf8");

const clone = (value) => (value == null ? value : structuredClone(value));

assert.match(authSource, /import "\.\/conversation-special-mode-activity\.js";/);
assert.match(specialSource, /persistDeepResearchUserTurn/);
assert.match(specialSource, /API\.syncChatMessages\(/);
assert.match(specialSource, /role: "user"/);
assert.match(specialSource, /originalStartDeepResearch/);
assert.match(specialSource, /originalSendDeepResearchStream/);
assert.match(specialSource, /originalCreateLiveSessionToken/);
assert.match(specialSource, /conversation_retention_cleanup_required/);
assert.match(specialSource, /await API\.deleteConversation\(bottom\.id\)/);

assert.match(liveSource, /containsUserActivity/);
assert.match(liveSource, /turn\.role === "user"/);
assert.match(liveSource, /\.update\(\{ last_activity_at: activityAt \}\)/);
assert.doesNotMatch(
  liveSource.slice(liveSource.indexOf("const containsUserActivity"), liveSource.indexOf("return 1;")),
  /turn\.role === "assistant"[\s\S]*last_activity_at/,
  "assistant-only Live audio must not advance activity",
);

function installSpecialMode({ storage, api }) {
  const context = {
    window: { SentIQStorage: storage, SentIQAPI: api },
    setTimeout,
    clearTimeout,
    Date,
    String,
    Number,
    Array,
    Set,
    Promise,
    Object,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(specialSource, context, { filename: specialPath });
  return context.window;
}

// Deep Research must persist the user prompt BEFORE starting research. This is
// what makes an existing old conversation move to the top cross-device.
{
  const events = [];
  const storage = {
    async getChat(id) { return { id, title: "Existing chat", source: "server" }; },
    async getAllChats() { return []; },
    async upsertServerChat() {},
    async deleteChat() {},
  };
  const api = {
    async syncChatMessages(payload) {
      events.push({ type: "sync", payload: clone(payload) });
      return { sync: { persisted: true } };
    },
    async startDeepResearch(input, context) {
      events.push({ type: "research", input, context: clone(context) });
      return { report_id: "report-1" };
    },
    async getConversations() { return { conversations: [] }; },
    async deleteConversation() {},
  };
  const window = installSpecialMode({ storage, api });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await window.SentIQAPI.startDeepResearch("Investigate this", {
    conversationId: "chat-1",
    clientRequestId: "request-1",
  });

  assert.equal(events[0].type, "sync");
  assert.equal(events[0].payload.conversationId, "chat-1");
  assert.equal(events[0].payload.title, "Existing chat");
  assert.deepEqual(events[0].payload.messages, [{
    role: "user",
    content: "Investigate this",
    clientRequestId: "request-1",
  }]);
  assert.equal(events[1].type, "research");
}

// If that sync is the 51st persisted conversation and the exact oldest chat has
// external artifacts, cleanup happens only AFTER the safe rollback code, then the
// exact bottom by user activity is deleted and the sync is retried once.
{
  const events = [];
  let syncAttempts = 0;
  let remote = Array.from({ length: 50 }, (_, index) => ({
    id: `remote-${index + 1}`,
    created_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    last_activity_at: index === 0
      ? "2026-07-01T00:00:00.000Z"
      : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
    last_message_at: index === 0 ? "2026-08-09T23:00:00.000Z" : undefined,
  }));
  const storage = {
    async getChat(id) { return { id, title: "Research", source: "server" }; },
    async getAllChats() { return []; },
    async upsertServerChat() {},
    async deleteChat(id) { events.push(`cache-delete:${id}`); },
  };
  const api = {
    async syncChatMessages() {
      syncAttempts += 1;
      events.push(`sync:${syncAttempts}`);
      if (syncAttempts === 1) {
        const error = new Error("rolled back");
        error.status = 409;
        error.code = "conversation_retention_cleanup_required";
        throw error;
      }
      return { sync: { persisted: true } };
    },
    async startDeepResearch() {
      events.push("research");
      return { report_id: "report-2" };
    },
    async getConversations() {
      events.push("list");
      return { conversations: clone(remote) };
    },
    async deleteConversation(id) {
      events.push(`delete:${id}`);
      remote = remote.filter((chat) => chat.id !== id);
      return { success: true };
    },
  };
  const window = installSpecialMode({ storage, api });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await window.SentIQAPI.startDeepResearch("Research query", {
    conversationId: "pending-51",
    clientRequestId: "request-51",
  });

  assert.deepEqual(events.slice(0, 6), [
    "sync:1",
    "list",
    "delete:remote-1",
    "cache-delete:remote-1",
    "sync:2",
    "research",
  ]);
}

// A brand-new Live conversation also honors the same transactional 51st-chat
// cleanup path: try first, delete only on safe rollback, retry exactly once.
{
  const events = [];
  let attempts = 0;
  let remote = Array.from({ length: 50 }, (_, index) => ({
    id: `live-remote-${index + 1}`,
    created_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    last_activity_at: index === 0
      ? "2026-07-01T00:00:00.000Z"
      : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  }));
  const storage = {
    async getAllChats() { return []; },
    async upsertServerChat() {},
    async deleteChat(id) { events.push(`cache-delete:${id}`); },
  };
  const api = {
    async createLiveSessionToken() {
      attempts += 1;
      events.push(`live:${attempts}`);
      if (attempts === 1) {
        const error = new Error("rolled back");
        error.code = "conversation_retention_cleanup_required";
        error.status = 409;
        throw error;
      }
      remote.push({
        id: "live-new",
        created_at: "2026-08-09T12:00:00.000Z",
        last_activity_at: "2026-08-09T12:00:00.000Z",
      });
      return { session_id: "session-1", conversation_id: "live-new" };
    },
    async getConversations() {
      events.push("list");
      return { conversations: clone(remote) };
    },
    async deleteConversation(id) {
      events.push(`delete:${id}`);
      remote = remote.filter((chat) => chat.id !== id);
      return { success: true };
    },
  };
  const window = installSpecialMode({ storage, api });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await window.SentIQAPI.createLiveSessionToken();

  assert.equal(events[0], "live:1");
  assert.ok(events.includes("delete:live-remote-1"));
  assert.ok(events.includes("live:2"));
  assert.equal(attempts, 2);
}

console.log("PASS | Deep Research and SentIQ Live conversation activity/retention regressions passed.");
