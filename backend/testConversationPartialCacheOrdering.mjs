import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(process.cwd());
const source = fs.readFileSync(
  path.join(root, "frontend/scripts/services/conversation-ordering-hydration-hardening.js"),
  "utf8",
);

assert.match(source, /function isCompleteMessageCache/);
assert.match(source, /chat\.messages\.length === messageCount/);
assert.match(source, /explicitReplace: options\?\.replaceExisting === true/);

function install(storage) {
  const context = {
    window: { SentIQStorage: storage },
    Date,
    Number,
    String,
    Array,
    Object,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.window.SentIQStorage;
}

// A partial cache containing only an older user turn must NOT downgrade the
// canonical server activity that says the user wrote more recently.
{
  const chat = {
    id: "partial",
    source: "server",
    created: "2026-08-01T00:00:00.000Z",
    updated: "2026-08-08T12:00:00.000Z",
    last_activity_at: "2026-08-08T12:00:00.000Z",
    message_count: 4,
    messages: [
      { role: "user", content: "older cached turn", timestamp: "2026-08-02T09:00:00.000Z" },
      { role: "assistant", content: "older cached reply", timestamp: "2026-08-02T09:01:00.000Z" },
    ],
  };
  let writes = 0;
  const storage = {
    compareChatsByUserActivity: () => 0,
    async getAllChats() { return [{ ...chat, messages: chat.messages.map((message) => ({ ...message })) }]; },
    async getLocalChats() { return []; },
    async mergeChatMessages(_id, messages) { return { ...chat, messages }; },
    async replaceChatMessages(_id, messages) { return { ...chat, messages }; },
    async upsertServerChat(input) { return { ...chat, ...input }; },
    async updateChatSyncState(_id, updates) {
      writes += 1;
      return { ...chat, ...updates };
    },
  };
  const wrapped = install(storage);
  const [result] = await wrapped.getAllChats();
  assert.equal(writes, 0, "partial cache must not rewrite canonical activity");
  assert.equal(result.last_activity_at, "2026-08-08T12:00:00.000Z");
}

// Full replace hydration is authoritative even when legacy metadata was polluted
// by a newer assistant timestamp.
{
  const base = {
    id: "full",
    source: "server",
    created: "2026-08-01T00:00:00.000Z",
    updated: "2026-08-09T12:00:00.000Z",
    last_activity_at: "2026-08-09T12:00:00.000Z",
    message_count: 2,
    messages: [],
  };
  let lastUpdate = null;
  const storage = {
    compareChatsByUserActivity: () => 0,
    async getAllChats() { return [base]; },
    async getLocalChats() { return []; },
    async mergeChatMessages(_id, messages) { return { ...base, messages, message_count: messages.length }; },
    async replaceChatMessages(_id, messages) { return { ...base, messages, message_count: messages.length }; },
    async upsertServerChat(input) { return { ...base, ...input }; },
    async updateChatSyncState(_id, updates) {
      lastUpdate = updates;
      return { ...base, ...updates };
    },
  };
  const wrapped = install(storage);
  await wrapped.replaceChatMessages("full", [
    { role: "user", content: "old user turn", timestamp: "2026-08-02T10:00:00.000Z" },
    { role: "assistant", content: "reply opened today", timestamp: "2026-08-09T12:00:00.000Z" },
  ]);
  assert.equal(lastUpdate.last_activity_at, "2026-08-02T10:00:00.000Z");
}

console.log("PASS | Partial caches cannot demote canonical recency; full hydration can repair legacy pollution.");
