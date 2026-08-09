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

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function iso(day, hour = 0) {
  return `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function makeLegacyStorage(initialChats = []) {
  const chats = new Map(initialChats.map((chat) => [chat.id, clone(chat)]));
  const config = new Map([["chat_limit", 100], ["memory_limit", 500]]);

  function legacyActivity(chat) {
    return chat?.last_activity_at || chat?.last_message_at || chat?.updated || chat?.created || chat?.created_at || "";
  }

  function legacyTouch(chat, timestamp) {
    const current = timestampMs(chat.updated || chat.created);
    const incoming = timestampMs(timestamp);
    if (incoming >= current) chat.updated = timestamp;
    if (chat.source === "server") {
      const serverCurrent = timestampMs(chat.last_activity_at || chat.created);
      if (incoming >= serverCurrent) chat.last_activity_at = timestamp;
      if (incoming >= timestampMs(chat.last_message_at)) chat.last_message_at = timestamp;
    }
  }

  return {
    __chats: chats,
    async getChat(id) {
      return clone(chats.get(id));
    },
    async getAllChats() {
      return [...chats.values()].map(clone).sort((a, b) => timestampMs(legacyActivity(b)) - timestampMs(legacyActivity(a)));
    },
    async getLocalChats() {
      return (await this.getAllChats()).filter((chat) => chat.source !== "server");
    },
    async addMessageToChat(chatId, role, content, meta, options = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const timestamp = options.timestamp || iso(9, 12);
      chat.messages ||= [];
      chat.messages.push({ id: `${chatId}-${chat.messages.length + 1}`, role, content, timestamp, ...(meta ? { meta } : {}) });
      legacyTouch(chat, timestamp);
      chats.set(chatId, chat);
      return clone(chat);
    },
    async upsertMessageInChat(chatId, message) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      chat.messages ||= [];
      const index = chat.messages.findIndex((item) => item.id === message.id);
      const next = { ...message, timestamp: message.timestamp || iso(9, 12) };
      if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...next };
      else chat.messages.push(next);
      legacyTouch(chat, iso(9, 12));
      chats.set(chatId, chat);
      return clone(chat);
    },
    async updateMessageInChat(chatId, messageId, updates = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const index = (chat.messages || []).findIndex((item) => item.id === messageId);
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
      const incomingActivity = chatData.last_activity_at || chatData.lastActivityAt || chatData.last_message_at || chatData.updated || created;
      const existingActivity = existing ? legacyActivity(existing) : "";
      const activity = timestampMs(existingActivity) > timestampMs(incomingActivity) ? existingActivity : incomingActivity;
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
      chat.messages = options.replaceExisting ? clone(messages) : [...(chat.messages || []), ...clone(messages)];
      chat.messages.sort((a, b) => timestampMs(a.timestamp || a.created_at) - timestampMs(b.timestamp || b.created_at));
      const last = chat.messages.at(-1);
      if (last) legacyTouch(chat, last.timestamp || last.created_at);
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
        // Mirrors the legacy monotonic behavior that would otherwise preserve a
        // polluted later cache timestamp.
        const candidates = [chat.last_activity_at, chat.updated, chat.created]
          .filter(Boolean)
          .sort((a, b) => timestampMs(b) - timestampMs(a));
        if (candidates[0]) {
          chat.last_activity_at = candidates[0];
          chat.updated = candidates[0];
        }
      }
      chats.set(chatId, chat);
      return clone(chat);
    },
    async deleteChat(id) {
      chats.delete(id);
    },
    async getConfig(key) {
      return config.get(key);
    },
    async setConfig(key, value) {
      config.set(key, value);
      return value;
    },
    async getAllConfig() {
      return Object.fromEntries(config);
    },
    async getStorageStats() {
      return { chats: { count: chats.size, limit: config.get("chat_limit") }, memories: { count: 0, limit: 500 }, files: { count: 0, limit_mb: 100 } };
    },
  };
}

function installPolicy(storage, api = null) {
  const context = {
    window: { SentIQStorage: storage, SentIQAPI: api },
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
  return context.window;
}

// ---------------------------------------------------------------------------
// Static contract checks
// ---------------------------------------------------------------------------
assert.match(authSource, /^import "\.\/conversation-ordering-policy\.js";/m, "ordering policy must load before auth/API/controller initialization");
assert.ok(
  mainSource.indexOf('import "./services/storage.js";') < mainSource.indexOf('import "./services/auth.js";'),
  "storage must initialize before auth imports the ordering policy",
);
assert.match(policySource, /const MAX_STORED_CHATS = 50;/, "browser retention cap must be fixed at 50");
assert.doesNotMatch(
  policySource.slice(policySource.indexOf("function activityTimestamp"), policySource.indexOf("function compareChatsByUserActivity")),
  /last_message_at|lastMessageAt|updated_at|chat\?\.updated,/,
  "canonical recency must not depend on assistant/legacy last-message or update timestamps",
);
assert.match(policySource, /role === "user"/, "only user-authored writes may advance local recency");
assert.match(policySource, /updateTitleWithoutRecencyBump/, "renaming a conversation must not advance recency");
assert.match(policySource, /mergeChatMessagesWithoutReadRecency/, "message hydration must be explicitly guarded against read-time recency changes");
assert.match(policySource, /API\.deleteConversation\(leastRecent\.id\)/, "51st-chat preparation must use the backend delete route for artifact cleanup");

assert.match(migrationSource, /m\.role = 'user'/, "historical activity repair must use user messages only");
assert.match(migrationSource, /if new\.role = 'user' then/i, "Supabase trigger must ignore assistant messages");
assert.match(migrationSource, /max_conversations constant integer := 50/i, "Supabase retention cap must be 50");
assert.match(
  migrationSource,
  /order by\s+coalesce\(c\.last_activity_at, c\.created_at\) desc,\s+c\.created_at desc,\s+c\.id desc;/i,
  "server list must sort newest user activity first with deterministic tie-breaks",
);
assert.match(
  migrationSource,
  /order by\s+coalesce\(c\.last_activity_at, c\.created_at\) asc,\s+c\.created_at asc,\s+c\.id asc/i,
  "retention must evict the exact bottom conversation by the same activity key",
);
assert.match(migrationSource, /conversation_retention_artifact_cleanup_required/, "DB race fallback must refuse unsafe artifact-bearing cascade deletion");
assert.match(migrationSource, /public\.generated_files[\s\S]*public\.chat_images/, "race fallback must protect both generated files and generated images");

// ---------------------------------------------------------------------------
// Behavioral ordering checks
// ---------------------------------------------------------------------------
const storage = makeLegacyStorage([
  {
    id: "a",
    title: "Old Formula chat",
    source: "server",
    created: iso(1),
    updated: iso(8),
    last_activity_at: iso(8), // intentionally polluted legacy activity
    messages: [],
    pending_server_sync: false,
  },
  {
    id: "b",
    title: "Today's real chat",
    source: "server",
    created: iso(7),
    updated: iso(7, 10),
    last_activity_at: iso(7, 10),
    messages: [
      { id: "b-u1", role: "user", content: "today", timestamp: iso(7, 10) },
      { id: "b-a1", role: "assistant", content: "reply", timestamp: iso(7, 10) },
    ],
    pending_server_sync: false,
  },
]);
installPolicy(storage);

// Remote list repair must be able to DOWNGRADE a polluted cache timestamp.
await storage.upsertServerChat({
  id: "a",
  title: "Old Formula chat",
  created_at: iso(1),
  last_activity_at: iso(2, 9),
  message_count: 2,
  first_user_message: "old question",
  last_message_at: iso(8),
});
let ordered = await storage.getAllChats();
assert.deepEqual(ordered.map((chat) => chat.id), ["b", "a"], "corrected server activity must restore the real ordering");
assert.equal(ordered.find((chat) => chat.id === "a")?.last_activity_at, iso(2, 9), "polluted cache timestamp must be repaired, not preserved");

// Opening/hydrating A includes a much newer assistant message. That must NOT
// promote A because its last user write is still Aug 2.
await storage.mergeChatMessages("a", [
  { id: "a-u1", role: "user", content: "old question", timestamp: iso(2, 9) },
  { id: "a-a1", role: "assistant", content: "assistant reply read today", timestamp: iso(9, 9) },
], { replaceExisting: true });
ordered = await storage.getAllChats();
assert.deepEqual(ordered.map((chat) => chat.id), ["b", "a"], "opening/hydrating an old chat must not move it upward");
assert.equal(ordered.find((chat) => chat.id === "a")?.updated, iso(2, 9), "read hydration must expose user-derived recency");

// Assistant writes/stream updates also must not advance recency.
await storage.addMessageToChat("a", "assistant", "late assistant-only event", null, { timestamp: iso(9, 10) });
ordered = await storage.getAllChats();
assert.deepEqual(ordered.map((chat) => chat.id), ["b", "a"], "assistant-only activity must not reorder history");

// A genuine new user query does promote A.
await storage.addMessageToChat("a", "user", "new question today", null, { timestamp: iso(9, 11) });
ordered = await storage.getAllChats();
assert.deepEqual(ordered.map((chat) => chat.id), ["a", "b"], "a new user query must promote the conversation");

// Renaming B with a legacy bump flag still must not change its position.
await storage.updateChatTitle("b", "Renamed", { bumpUpdated: true });
ordered = await storage.getAllChats();
assert.deepEqual(ordered.map((chat) => chat.id), ["a", "b"], "title edits must not count as written-in activity");
assert.equal(await storage.getConfig("chat_limit"), 50, "chat limit setting must be fixed at 50");
assert.equal((await storage.getAllConfig()).chat_limit, 50, "full config must report the fixed 50-chat cap");

// ---------------------------------------------------------------------------
// Browser cache retention: 51st local chat removes the least-recent one.
// ---------------------------------------------------------------------------
const manyChats = [];
for (let index = 1; index <= 51; index += 1) {
  manyChats.push({
    id: `local-${index}`,
    title: `Chat ${index}`,
    source: "local",
    created: `2026-06-${String(Math.min(index, 30)).padStart(2, "0")}T00:00:00.000Z`,
    updated: index === 1 ? iso(9, 23) : `2026-06-${String(Math.min(index, 30)).padStart(2, "0")}T00:00:00.000Z`,
    messages: index === 1
      ? [{ id: "local-1-user", role: "user", content: "old user activity", timestamp: "2026-06-01T00:00:00.000Z" }]
      : [],
  });
}
const retentionStorage = makeLegacyStorage(manyChats);
installPolicy(retentionStorage);
const retained = await retentionStorage.getAllChats();
assert.equal(retained.length, 50, "browser cache must retain exactly 50 chats");
assert.equal(retentionStorage.__chats.size, 50, "overflow cache row must be physically deleted");
assert.equal(retentionStorage.__chats.has("local-1"), false, "legacy updated pollution must not save the genuinely oldest local chat");

// ---------------------------------------------------------------------------
// Remote retention: before first write of the 51st pending chat, the policy uses
// the full backend DELETE path and chooses the oldest USER activity, ignoring a
// misleading newer assistant last_message_at.
// ---------------------------------------------------------------------------
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
  last_activity_at: index === 0 ? "2026-07-01T00:00:00.000Z" : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  // remote-1 looks recently answered by the assistant, but this field must be ignored.
  last_message_at: index === 0 ? iso(9, 23) : undefined,
}));
const deletedRemoteIds = [];
const api = {
  async getConversations() {
    return { conversations: clone(remoteChats) };
  },
  async deleteConversation(id) {
    deletedRemoteIds.push(id);
    const index = remoteChats.findIndex((chat) => chat.id === id);
    if (index >= 0) remoteChats.splice(index, 1);
    return { success: true };
  },
  async sendMessageStream() {
    return { tokensReceived: true };
  },
  async sendMessage() {
    return { reply: "ok" };
  },
  async syncChatMessages() {
    return { sync: { persisted: true } };
  },
  async generateImage() {
    return { image: {} };
  },
  async createConversation() {
    return { conversation: { id: pendingId } };
  },
};
const remoteWindow = installPolicy(remoteLocalStorage, api);
await remoteWindow.SentIQAPI.sendMessageStream("first question", { conversationId: pendingId }, {});
assert.deepEqual(deletedRemoteIds, ["remote-1"], "51st-chat preparation must delete the bottom user-activity chat through the API");
assert.equal(remoteChats.length, 49, "one full remote slot must be prepared before creating the new conversation");

console.log("PASS | Conversation ordering and 50-chat retention policy regression checks passed.");
