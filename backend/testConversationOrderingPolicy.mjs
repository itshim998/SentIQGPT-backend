import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(process.cwd());
const policyPath = path.join(root, "frontend/scripts/services/conversation-ordering-policy.js");
const migrationPath = path.join(root, "supabase/migrations/20260809123000_conversation_user_activity_ordering.sql");
const authPath = path.join(root, "frontend/scripts/services/auth.js");
const mainPath = path.join(root, "frontend/scripts/main.js");

const policySource = fs.readFileSync(policyPath, "utf8");
const migrationSource = fs.readFileSync(migrationPath, "utf8");
const authSource = fs.readFileSync(authPath, "utf8");
const mainSource = fs.readFileSync(mainPath, "utf8");

const clone = (value) => (value == null ? value : structuredClone(value));
const ids = (items) => Array.from(items, (item) => item.id);
const ms = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (day, hour = 0) => `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;

function makeLegacyStorage(initialChats = []) {
  const chats = new Map(initialChats.map((chat) => [chat.id, clone(chat)]));
  const config = new Map([["chat_limit", 100], ["memory_limit", 500]]);
  const syncJobs = new Map();
  const generatedFiles = new Map();
  let aliases = {};
  let newChatSequence = 0;

  function legacyActivity(chat) {
    return chat?.last_activity_at || chat?.last_message_at || chat?.updated || chat?.created || chat?.created_at || "";
  }

  function legacyTouch(chat, timestamp) {
    if (ms(timestamp) >= ms(chat.updated || chat.created)) chat.updated = timestamp;
    if (chat.source === "server") {
      if (ms(timestamp) >= ms(chat.last_activity_at || chat.created)) chat.last_activity_at = timestamp;
      if (ms(timestamp) >= ms(chat.last_message_at)) chat.last_message_at = timestamp;
    }
  }

  return {
    __chats: chats,
    __syncJobs: syncJobs,
    __generatedFiles: generatedFiles,
    get __aliases() { return aliases; },
    getActiveUserId() { return "test-user"; },
    async createChat(title = "New Chat") {
      newChatSequence += 1;
      const id = `created-${newChatSequence}`;
      const timestamp = iso(9, 12 + newChatSequence);
      const chat = { id, title, source: "local", created: timestamp, updated: timestamp, messages: [] };
      chats.set(id, chat);
      return clone(chat);
    },
    async getChat(id) { return clone(chats.get(id)); },
    async getAllChats() {
      return [...chats.values()]
        .map(clone)
        .sort((left, right) => ms(legacyActivity(right)) - ms(legacyActivity(left)));
    },
    async getLocalChats() {
      return (await this.getAllChats()).filter((chat) => chat.source !== "server");
    },
    async addMessageToChat(chatId, role, content, meta, options = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const timestamp = options.timestamp || iso(9, 12);
      chat.messages ||= [];
      chat.messages.push({
        id: `${chatId}-${chat.messages.length + 1}`,
        role,
        content,
        timestamp,
        ...(meta ? { meta } : {}),
      });
      chat.message_count = chat.messages.length;
      legacyTouch(chat, timestamp);
      chats.set(chatId, chat);
      return clone(chat);
    },
    async upsertMessageInChat(chatId, message) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      chat.messages ||= [];
      const index = chat.messages.findIndex((item) => item.id === message.id);
      if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...message };
      else chat.messages.push({ ...message });
      chat.message_count = chat.messages.length;
      legacyTouch(chat, iso(9, 12));
      chats.set(chatId, chat);
      return clone(chat);
    },
    async updateMessageInChat(chatId, messageId, updates = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const index = (chat.messages || []).findIndex((message) => message.id === messageId);
      if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...updates };
      legacyTouch(chat, iso(9, 13));
      chats.set(chatId, chat);
      return clone(chat);
    },
    async updateChatTitle(chatId, title, options = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      chat.title = title;
      if (options.bumpUpdated) legacyTouch(chat, iso(9, 14));
      chats.set(chatId, chat);
      return clone(chat);
    },
    async upsertServerChat(chatData) {
      const existing = chats.get(chatData.id);
      const created = chatData.created || chatData.created_at || existing?.created || iso(1);
      const incomingActivity = chatData.last_activity_at
        || chatData.lastActivityAt
        || chatData.last_message_at
        || chatData.updated
        || created;
      const existingActivity = existing ? legacyActivity(existing) : "";
      const activity = ms(existingActivity) > ms(incomingActivity) ? existingActivity : incomingActivity;
      const chat = {
        ...(existing || {}),
        ...clone(chatData),
        id: chatData.id,
        title: chatData.title || existing?.title || "New Chat",
        messages: existing?.messages || [],
        created,
        source: "server",
        updated: activity,
        last_activity_at: activity,
        last_message_at: chatData.last_message_at || existing?.last_message_at || null,
        pending_server_sync: Boolean(chatData.pending_server_sync),
      };
      chats.set(chat.id, chat);
      return clone(chat);
    },
    async mergeChatMessages(chatId, messages, options = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      chat.messages = options.replaceExisting
        ? clone(messages)
        : [...(chat.messages || []), ...clone(messages)];
      chat.messages.sort((left, right) => ms(left.timestamp || left.created_at) - ms(right.timestamp || right.created_at));
      chat.message_count = chat.messages.length;
      const lastMessage = chat.messages.at(-1);
      if (lastMessage) legacyTouch(chat, lastMessage.timestamp || lastMessage.created_at);
      chats.set(chatId, chat);
      return clone(chat);
    },
    async replaceChatMessages(chatId, messages) {
      return this.mergeChatMessages(chatId, messages, { replaceExisting: true });
    },
    async updateChatSyncState(chatId, updates = {}) {
      const chat = chats.get(chatId);
      if (!chat) return undefined;
      Object.assign(chat, clone(updates));
      if (chat.source === "server") {
        const activity = [chat.last_activity_at, chat.updated, chat.created]
          .filter(Boolean)
          .sort((left, right) => ms(right) - ms(left))[0];
        if (activity) {
          chat.last_activity_at = activity;
          chat.updated = activity;
        }
      }
      chats.set(chatId, chat);
      return clone(chat);
    },
    async deleteChat(id) { chats.delete(id); },
    async getConfig(key) { return config.get(key); },
    async setConfig(key, value) {
      config.set(key, clone(value));
      if (String(key).startsWith("conversation_aliases:")) aliases = clone(value || {});
      return value;
    },
    async getAllConfig() { return Object.fromEntries(config); },
    async getStorageStats() {
      return {
        chats: { count: chats.size, limit: config.get("chat_limit") },
        memories: { count: 0, limit: 500 },
        files: { count: 0, limit_mb: 100 },
      };
    },
    async getAllSyncJobs() { return [...syncJobs.values()].map(clone); },
    async deleteSyncJob(id) { syncJobs.delete(id); },
    async getAllGeneratedFiles() { return [...generatedFiles.values()].map(clone); },
    async deleteGeneratedFile(id) { generatedFiles.delete(id); },
    async getConversationAliases() { return clone(aliases); },
  };
}

function makeLocalStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function installPolicy(storage, api = null, localStorage = makeLocalStorage()) {
  const context = {
    window: { SentIQStorage: storage, SentIQAPI: api, localStorage },
    setTimeout,
    clearTimeout,
    console,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Map,
    Set,
    Promise,
  };
  context.globalThis = context;
  vm.runInNewContext(policySource, context, { filename: policyPath });
  return { window: context.window, localStorage };
}

// Static invariants.
assert.match(authSource, /^import "\.\/conversation-ordering-policy\.js";/m);
assert.ok(mainSource.indexOf('import "./services/storage.js";') < mainSource.indexOf('import "./services/auth.js";'));
assert.match(policySource, /const MAX_STORED_CHATS = 50;/);
assert.doesNotMatch(
  policySource.slice(policySource.indexOf("function activityTimestamp"), policySource.indexOf("function compareChatsByUserActivity")),
  /last_message_at|lastMessageAt|updated_at|chat\?\.updated,/,
);
assert.match(policySource, /persistUserActivity/);
assert.match(policySource, /isTransientBlankServerPlaceholder/);
assert.match(policySource, /purgeLocalConversationResidue/);
assert.match(policySource, /updateTitleWithoutRecencyBump/);
assert.match(policySource, /mergeChatMessagesWithoutReadRecency/);
assert.match(policySource, /API\.deleteConversation\(leastRecent\.id\)/);

assert.match(migrationSource, /m\.role = 'user'/);
assert.match(migrationSource, /if new\.role = 'user' then/i);
assert.match(migrationSource, /max_conversations constant integer := 50/i);
assert.match(migrationSource, /get_conversation_user_activity_schema_version/);
assert.match(
  migrationSource,
  /order by\s+coalesce\(c\.last_activity_at, c\.created_at\) desc,\s+c\.created_at desc,\s+c\.id desc;/i,
);
assert.match(
  migrationSource,
  /order by\s+coalesce\(c\.last_activity_at, c\.created_at\) asc,\s+c\.created_at asc,\s+c\.id asc/i,
);
assert.match(migrationSource, /conversation_retention_artifact_cleanup_required/);
assert.match(migrationSource, /public\.generated_files[\s\S]*public\.chat_images/);

// 1) Repair polluted historical cache, including a downgrade.
const storage = makeLegacyStorage([
  {
    id: "old",
    title: "Formula 1 Car Overview",
    source: "server",
    created: iso(1),
    updated: iso(8),
    last_activity_at: iso(8),
    messages: [],
    pending_server_sync: false,
  },
  {
    id: "today",
    title: "Today's real chat",
    source: "server",
    created: iso(7),
    updated: iso(7, 10),
    last_activity_at: iso(7, 10),
    messages: [
      { id: "today-u", role: "user", timestamp: iso(7, 10), content: "today" },
      { id: "today-a", role: "assistant", timestamp: iso(7, 10), content: "reply" },
    ],
    pending_server_sync: false,
  },
]);
const sharedLocalStorage = makeLocalStorage();
installPolicy(storage, null, sharedLocalStorage);
await storage.upsertServerChat({
  id: "old",
  title: "Formula 1 Car Overview",
  created_at: iso(1),
  last_activity_at: iso(2, 9),
  last_message_at: iso(8),
  message_count: 2,
});
let ordered = await storage.getAllChats();
assert.deepEqual(ids(ordered), ["today", "old"]);
assert.equal(ordered[1].last_activity_at, iso(2, 9));
assert.equal(
  [...sharedLocalStorage.values.values()].includes(iso(2, 9)),
  true,
  "canonical server activity must persist outside polluted legacy cache fields",
);

// 2) Opening/hydrating an old chat with a newer assistant message does not move it.
await storage.mergeChatMessages("old", [
  { id: "old-u", role: "user", timestamp: iso(2, 9), content: "old question" },
  { id: "old-a", role: "assistant", timestamp: iso(9, 9), content: "assistant reply read today" },
], { replaceExisting: true });
ordered = await storage.getAllChats();
assert.deepEqual(ids(ordered), ["today", "old"]);
assert.equal(ordered[1].updated, iso(2, 9));

// 3) Assistant output and title edits do not move a chat; a new user query does.
await storage.addMessageToChat("old", "assistant", "late assistant-only event", null, { timestamp: iso(9, 10) });
assert.deepEqual(ids(await storage.getAllChats()), ["today", "old"]);
await storage.addMessageToChat("old", "user", "new user question", null, { timestamp: iso(9, 11) });
assert.deepEqual(ids(await storage.getAllChats()), ["old", "today"]);
await storage.updateChatTitle("today", "Renamed", { bumpUpdated: true });
assert.deepEqual(ids(await storage.getAllChats()), ["old", "today"]);
assert.equal(await storage.getConfig("chat_limit"), 50);
assert.equal((await storage.getAllConfig()).chat_limit, 50);

// 4) Browser cache physically returns to 50 after creating the 51st committed
// local chat, using strict user activity rather than legacy `updated` pollution.
const fiftyChats = Array.from({ length: 50 }, (_, index) => ({
  id: `local-${index + 1}`,
  title: `Local ${index + 1}`,
  source: "local",
  created: `2026-06-${String(Math.min(index + 1, 30)).padStart(2, "0")}T00:00:00.000Z`,
  updated: index === 0 ? iso(9, 23) : `2026-06-${String(Math.min(index + 1, 30)).padStart(2, "0")}T00:00:00.000Z`,
  messages: index === 0
    ? [{ id: "local-1-u", role: "user", timestamp: "2026-06-01T00:00:00.000Z", content: "old" }]
    : [],
}));
const retentionStorage = makeLegacyStorage(fiftyChats);
retentionStorage.__syncJobs.set("stale-message-job", {
  id: "stale-message-job",
  type: "chat_message",
  payload: { conversationId: "local-1", messages: [{ role: "user", content: "must never recreate" }] },
});
retentionStorage.__generatedFiles.set("stale-generated-file", {
  id: "stale-generated-file",
  chat_id: "local-1",
  file_name: "old.txt",
});
await retentionStorage.setConfig("conversation_aliases:test-user", {
  "local-1": "local-2",
  "keep-from": "local-1",
  "keep-alias": "local-3",
});
installPolicy(retentionStorage);
const created = await retentionStorage.createChat("51st chat");
assert.equal(retentionStorage.__chats.size, 50);
assert.equal(retentionStorage.__chats.has("local-1"), false);
assert.equal(retentionStorage.__chats.has(created.id), true);
assert.equal(retentionStorage.__syncJobs.has("stale-message-job"), false, "retention must remove sync jobs that could recreate the evicted chat");
assert.equal(retentionStorage.__generatedFiles.has("stale-generated-file"), false, "retention must remove local generated-file cache rows for the evicted chat");
assert.deepEqual(retentionStorage.__aliases, { "keep-alias": "local-3" }, "retention must remove local aliases that reference the evicted chat");

// 5) An authenticated blank New Chat is an existing transient draft by design,
// not a persisted conversation. It must not evict a real chat until first write.
const committedServerChats = Array.from({ length: 50 }, (_, index) => ({
  id: `committed-${index + 1}`,
  title: `Committed ${index + 1}`,
  source: "server",
  created: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  updated: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  last_activity_at: index === 0
    ? "2026-07-01T00:00:00.000Z"
    : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  message_count: 1,
  first_user_message: `question ${index + 1}`,
  messages: [],
  pending_server_sync: false,
}));
const blankDraftStorage = makeLegacyStorage(committedServerChats);
installPolicy(blankDraftStorage);
await blankDraftStorage.upsertServerChat({
  id: "blank-draft",
  title: "New Chat",
  created: iso(9, 12),
  updated: iso(9, 12),
  source: "server",
  pending_server_sync: true,
  message_count: 0,
});
assert.equal(blankDraftStorage.__chats.size, 51, "a local-only blank draft must not evict persisted history");
assert.equal((await blankDraftStorage.getStorageStats()).chats.count, 50, "blank draft must not count toward the persisted 50-chat quota");
await blankDraftStorage.addMessageToChat("blank-draft", "user", "first real query", null, { timestamp: iso(9, 13) });
assert.equal(blankDraftStorage.__chats.size, 50, "first user write turns the draft into a committed chat and triggers eviction");
assert.equal(blankDraftStorage.__chats.has("committed-1"), false, "the bottom committed chat must be evicted on first write");
assert.equal(blankDraftStorage.__chats.has("blank-draft"), true);

// 6) First write of a pending 51st remote chat prepares a slot through the full
// backend DELETE route. A recent assistant last_message_at must not save the
// genuinely least-recent conversation.
const pendingId = "pending-51";
const remoteLocalStorage = makeLegacyStorage([
  {
    id: pendingId,
    title: "New Chat",
    source: "server",
    created: iso(9, 12),
    updated: iso(9, 12),
    last_activity_at: iso(9, 12),
    messages: [],
    pending_server_sync: true,
  },
]);
const remoteChats = Array.from({ length: 50 }, (_, index) => ({
  id: `remote-${index + 1}`,
  title: `Remote ${index + 1}`,
  created_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  last_activity_at: index === 0
    ? "2026-07-01T00:00:00.000Z"
    : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  last_message_at: index === 0 ? iso(9, 23) : undefined,
}));
const deletedRemoteIds = [];
const api = {
  async getConversations() { return { conversations: clone(remoteChats) }; },
  async deleteConversation(id) {
    deletedRemoteIds.push(id);
    const index = remoteChats.findIndex((chat) => chat.id === id);
    if (index >= 0) remoteChats.splice(index, 1);
    return { success: true };
  },
  async sendMessageStream() { return { tokensReceived: true }; },
  async sendMessage() { return { reply: "ok" }; },
  async syncChatMessages() { return { sync: { persisted: true } }; },
  async generateImage() { return { image: {} }; },
  async createConversation() { return { conversation: { id: pendingId } }; },
};
const { window: remoteWindow } = installPolicy(remoteLocalStorage, api);
await remoteWindow.SentIQAPI.sendMessageStream("first question", { conversationId: pendingId }, {});
assert.deepEqual(deletedRemoteIds, ["remote-1"]);
assert.equal(remoteChats.length, 49);

console.log("PASS | Conversation ordering and 50-chat retention policy regression checks passed.");
