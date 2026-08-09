import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(process.cwd());
const source = fs.readFileSync(
  path.join(root, "frontend/scripts/services/conversation-creation-persistence.js"),
  "utf8",
);
const auth = fs.readFileSync(
  path.join(root, "frontend/scripts/services/auth.js"),
  "utf8",
);

assert.match(auth, /import "\.\/conversation-creation-persistence\.js";/);
assert.match(source, /await API\.createConversation\(chat\?\.title \|\| "New Chat", chatId\)/);
assert.match(source, /pending_server_sync: false/);
assert.match(source, /Do not pre-delete an old conversation when creation itself failed/);

function install(storage, api) {
  const context = {
    window: { SentIQStorage: storage, SentIQAPI: api },
    Map,
    Number,
    String,
    Promise,
    Object,
    Error,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.window;
}

// Creating a blank authenticated chat must persist it immediately — it is a real
// created conversation and therefore counts toward the 50-chat retention rule.
{
  const events = [];
  const chats = new Map();
  const storage = {
    async upsertServerChat(chat) {
      const stored = { ...chat, source: "server", messages: chat.messages || [] };
      chats.set(stored.id, stored);
      events.push(`cache:${stored.id}`);
      return { ...stored };
    },
    async updateChatSyncState(id, updates) {
      const chat = { ...(chats.get(id) || { id }), ...updates };
      chats.set(id, chat);
      events.push(`state:${String(updates.pending_server_sync)}`);
      return { ...chat };
    },
    async getAllChats() {
      events.push("prune");
      return [...chats.values()];
    },
    async getChat(id) {
      return chats.get(id) ? { ...chats.get(id) } : undefined;
    },
  };
  const api = {
    async createConversation(title, id) {
      events.push(`remote:${id}:${title}`);
      return { conversation: { id, title } };
    },
  };

  const window = install(storage, api);
  const result = await window.SentIQStorage.upsertServerChat({
    id: "new-51",
    title: "New Chat",
    source: "server",
    messages: [],
    message_count: 0,
    pending_server_sync: true,
  });

  assert.deepEqual(events, [
    "cache:new-51",
    "remote:new-51:New Chat",
    "state:false",
    "prune",
  ]);
  assert.equal(result.pending_server_sync, false);
}

// If creation fails, the old history must not be pruned merely because a local
// placeholder exists. Keep the draft pending for existing recovery paths.
{
  const events = [];
  const chats = new Map();
  const storage = {
    async upsertServerChat(chat) {
      const stored = { ...chat, source: "server", messages: [] };
      chats.set(stored.id, stored);
      events.push("cache");
      return { ...stored };
    },
    async updateChatSyncState(id, updates) {
      const chat = { ...(chats.get(id) || { id }), ...updates };
      chats.set(id, chat);
      events.push(`state:${String(updates.pending_server_sync)}`);
      return { ...chat };
    },
    async getAllChats() {
      events.push("prune");
      return [...chats.values()];
    },
    async getChat(id) {
      return chats.get(id) ? { ...chats.get(id) } : undefined;
    },
  };
  const api = {
    async createConversation() {
      events.push("remote-failed");
      throw new Error("offline");
    },
  };

  const window = install(storage, api);
  const result = await window.SentIQStorage.upsertServerChat({
    id: "pending",
    title: "New Chat",
    source: "server",
    messages: [],
    pending_server_sync: true,
  });

  assert.deepEqual(events, ["cache", "remote-failed", "state:true"]);
  assert.equal(result.pending_server_sync, true);
}

console.log("PASS | Authenticated chat creation is persisted immediately without destructive failure-side pruning.");
