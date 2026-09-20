import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(process.cwd());
const policyPath = path.join(root, "frontend/scripts/services/conversation-ordering-policy.js");
const hardeningPath = path.join(root, "frontend/scripts/services/conversation-ordering-hydration-hardening.js");
const migrationPath = path.join(root, "supabase/migrations/20260809123000_conversation_user_activity_ordering.sql");
const verificationPath = path.join(root, "supabase/verification/verify_conversation_user_activity_ordering.sql");
const httpErrorsPath = path.join(root, "backend/httpErrors.ts");
const authPath = path.join(root, "frontend/scripts/services/auth.js");
const mainPath = path.join(root, "frontend/scripts/main.js");

const policySource = fs.readFileSync(policyPath, "utf8");
const hardeningSource = fs.readFileSync(hardeningPath, "utf8");
const migrationSource = fs.readFileSync(migrationPath, "utf8");
const verificationSource = fs.readFileSync(verificationPath, "utf8");
const httpErrorsSource = fs.readFileSync(httpErrorsPath, "utf8");
const authSource = fs.readFileSync(authPath, "utf8");
const mainSource = fs.readFileSync(mainPath, "utf8");

const clone = (value) => (value == null ? value : structuredClone(value));
const ids = (items) => Array.from(items, (item) => item.id);
const iso = (day, hour = 0) => `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const ms = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

function makeLocalStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function makeLegacyStorage(initialChats = []) {
  const chats = new Map(initialChats.map((chat) => [chat.id, clone(chat)]));
  const config = new Map([["chat_limit", 100], ["memory_limit", 500]]);
  const syncJobs = new Map();
  const generatedFiles = new Map();
  let aliases = {};
  let createSequence = 0;

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

  const storage = {
    __chats: chats,
    __syncJobs: syncJobs,
    __generatedFiles: generatedFiles,
    get __aliases() { return aliases; },

    getActiveUserId() { return "test-user"; },

    async createChat(title = "New Chat") {
      createSequence += 1;
      const timestamp = iso(9, 12 + createSequence);
      const chat = {
        id: `created-${createSequence}`,
        title,
        source: "local",
        created: timestamp,
        updated: timestamp,
        messages: [],
      };
      chats.set(chat.id, chat);
      return clone(chat);
    },

    async getChat(id) {
      return clone(chats.get(id));
    },

    async getAllChats() {
      return [...chats.values()]
        .map(clone)
        .sort((left, right) => ms(legacyActivity(right)) - ms(legacyActivity(left)));
    },

    async getLocalChats() {
      return (await storage.getAllChats()).filter((chat) => chat.source !== "server");
    },

    async addMessageToChat(chatId, role, content, meta, options = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const timestamp = options.timestamp || iso(9, 12);
      chat.messages ||= [];
      chat.messages.push({
        id: `${chatId}-message-${chat.messages.length + 1}`,
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
      if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...clone(message) };
      else chat.messages.push(clone(message));
      chat.message_count = chat.messages.length;
      legacyTouch(chat, message.timestamp || iso(9, 12));
      chats.set(chatId, chat);
      return clone(chat);
    },

    async updateMessageInChat(chatId, messageId, updates = {}) {
      const chat = chats.get(chatId);
      assert(chat, `chat ${chatId} should exist`);
      const index = (chat.messages || []).findIndex((message) => message.id === messageId);
      if (index >= 0) chat.messages[index] = { ...chat.messages[index], ...clone(updates) };
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

    async updateChatSyncState(chatId, updates = {}) {
      const chat = chats.get(chatId);
      if (!chat) return undefined;
      Object.assign(chat, clone(updates));
      if (chat.source === "server") {
        // Deliberately simulate the legacy monotonic bug: a corrected older
        // activity cannot directly overwrite a later polluted cache value.
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
      const last = chat.messages.at(-1);
      if (last) legacyTouch(chat, last.timestamp || last.created_at);
      chats.set(chatId, chat);
      return clone(chat);
    },

    async replaceChatMessages(chatId, messages) {
      return storage.mergeChatMessages(chatId, messages, { replaceExisting: true });
    },

    async deleteChat(id) {
      chats.delete(id);
    },

    async getConfig(key) {
      return clone(config.get(key));
    },

    async setConfig(key, value) {
      config.set(key, clone(value));
      if (String(key).startsWith("conversation_aliases:")) aliases = clone(value || {});
      return value;
    },

    async getAllConfig() {
      return Object.fromEntries(config);
    },

    async getStorageStats() {
      return {
        chats: { count: chats.size, limit: config.get("chat_limit") },
        memories: { count: 0, limit: 500 },
        files: { count: 0, limit_mb: 100 },
      };
    },

    async getAllSyncJobs() {
      return [...syncJobs.values()].map(clone);
    },

    async deleteSyncJob(id) {
      syncJobs.delete(id);
    },

    async getAllGeneratedFiles() {
      return [...generatedFiles.values()].map(clone);
    },

    async deleteGeneratedFile(id) {
      generatedFiles.delete(id);
    },

    async getConversationAliases() {
      return clone(aliases);
    },
  };

  return storage;
}

function installPolicies(storage, api = null, localStorage = makeLocalStorage()) {
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
  vm.runInNewContext(`(() => {\n${policySource}\n})();`, context, { filename: policyPath });
  vm.runInNewContext(`(() => {\n${hardeningSource}\n})();`, context, { filename: hardeningPath });
  return { window: context.window, localStorage };
}

// ---------------------------------------------------------------------------
// Static contracts
// ---------------------------------------------------------------------------
assert.match(authSource, /^import "\.\/conversation-ordering-policy\.js";\nimport "\.\/conversation-ordering-hydration-hardening\.js";/m);
assert.ok(
  mainSource.indexOf('import "./services/storage.js";') < mainSource.indexOf('import "./services/auth.js";'),
  "storage must initialize before ordering policies",
);
assert.match(policySource, /const MAX_STORED_CHATS = 50;/);
assert.match(policySource, /const RETENTION_CLEANUP_CODE = "conversation_retention_cleanup_required";/);
assert.match(policySource, /isUnconfirmedServerChat/);
assert.match(policySource, /purgeLocalConversationResidue/);
assert.match(policySource, /updateTitleWithoutRecency/);
assert.match(policySource, /hydrateMessagesWithoutReadRecency/);
assert.match(policySource, /const result = await method\(\.\.\.args\);[\s\S]*catch \(error\)[\s\S]*RETENTION_CLEANUP_CODE/);
assert.match(policySource, /await cleanupRemoteRetentionSlot\(conversationId\);[\s\S]*const result = await method\(\.\.\.args\);/);
assert.doesNotMatch(
  policySource.slice(policySource.indexOf("function activityTimestamp"), policySource.indexOf("function compareChatsByUserActivity")),
  /last_message_at|lastMessageAt|updated_at|chat\?\.updated,/,
  "canonical activity must never depend on assistant/legacy update timestamps",
);
assert.match(hardeningSource, /exactUserActivity/);
assert.match(hardeningSource, /message\?\.role !== "user"/);
assert.match(hardeningSource, /replaceChatMessagesWithExactHydratedActivity/);

assert.match(httpErrorsSource, /conversation_retention_artifact_cleanup_required/);
assert.match(httpErrorsSource, /CONVERSATION_RETENTION_CLEANUP_CODE = "conversation_retention_cleanup_required"/);
assert.match(httpErrorsSource, /statusCode: 409/);
assert.match(httpErrorsSource, /The raw Postgres marker and[\s\S]*remain private/);

assert.match(migrationSource, /m\.role = 'user'/);

// Verify touch_conversation_last_activity trigger function structure
assert.match(
  migrationSource,
  /create\s+or\s+replace\s+function\s+public\.touch_conversation_last_activity\(\)/i,
  "touch_conversation_last_activity trigger function must be defined",
);
assert.match(
  migrationSource,
  /new\.role\s*=\s*'user'/i,
  "user role messages must advance conversation recency",
);
assert.match(
  migrationSource,
  /new\.role\s*=\s*'assistant'\s+and\s+new\.message_type\s*=\s*'live_transcript'/i,
  "live_transcript assistant messages must be checked for qualifying speech",
);
assert.match(
  migrationSource,
  /update\s+public\.conversations\s+set\s+last_activity_at\s*=\s*greatest\(/i,
  "last_activity_at must be updated on qualifying messages",
);

// Semantic invariant verification for touch_conversation_last_activity:
// 1. normal user messages update last_activity_at;
// 2. assistant messages do not;
// 3. qualifying live_transcript assistant messages containing user speech do;
// 4. unrelated assistant messages do not.
const liveTranscriptRegexMatch = migrationSource.match(/new\.message_type\s*=\s*'live_transcript'[\s\S]*?~[\s\S]*?E'([^']+)'/);
assert.ok(liveTranscriptRegexMatch, "live transcript user speech regex pattern must be present in migration");

const liveTranscriptPattern = new RegExp(
  liveTranscriptRegexMatch[1]
    .replace(/\\\\n/g, "\n")
    .replace(/\[\^\[:space:\]\]/g, "\\S")
    .replace(/\[\[:space:\]\]/g, "\\s"),
  "m",
);

function shouldAdvanceConversationActivity(msg) {
  if (msg.role === "user") return true;
  if (msg.role === "assistant" && msg.message_type === "live_transcript") {
    return liveTranscriptPattern.test(msg.content || "");
  }
  return false;
}

// 1. Normal user messages update last_activity_at
assert.equal(shouldAdvanceConversationActivity({ role: "user", content: "Tell me about space" }), true);
assert.equal(shouldAdvanceConversationActivity({ role: "user", content: "" }), true);

// 2. Assistant messages do not update last_activity_at
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", content: "Space is vast...", message_type: "chat" }), false);
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", content: "Here are the details." }), false);

// 3. Qualifying live_transcript assistant messages containing user speech do update activity
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", message_type: "live_transcript", content: "You: Hello\nAI: Hi there!" }), true);
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", message_type: "live_transcript", content: "AI: Connected\nYou: What is the plan?" }), true);

// 4. Unrelated assistant messages do not (e.g. live transcript without user speech or non-live messages mentioning 'You:')
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", message_type: "live_transcript", content: "AI: Hello and welcome." }), false);
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", message_type: "live_transcript", content: "You:    " }), false);
assert.equal(shouldAdvanceConversationActivity({ role: "assistant", message_type: "chat", content: "You: this was typed by assistant" }), false);

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
assert.match(verificationSource, /conversation_activity_mismatches/);
assert.match(verificationSource, /users_over_50_conversations/);
assert.match(verificationSource, /artifact_safe_fallback/);

// ---------------------------------------------------------------------------
// 1. Historical server refresh can DOWNGRADE polluted browser activity.
// ---------------------------------------------------------------------------
const refreshedStorage = makeLegacyStorage([
  {
    id: "formula",
    title: "Formula 1 Car Overview",
    source: "server",
    created: iso(1),
    updated: iso(8),
    last_activity_at: iso(8), // legacy pollution
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
    messages: [{ id: "today-u", role: "user", content: "today", timestamp: iso(7, 10) }],
    pending_server_sync: false,
  },
]);
const refreshedLocalStorage = makeLocalStorage();
installPolicies(refreshedStorage, null, refreshedLocalStorage);
await refreshedStorage.upsertServerChat({
  id: "formula",
  title: "Formula 1 Car Overview",
  created_at: iso(1),
  last_activity_at: iso(2, 9),
  last_message_at: iso(8),
  message_count: 2,
});
let ordered = await refreshedStorage.getAllChats();
assert.deepEqual(ids(ordered), ["today", "formula"]);
assert.equal(ordered[1].last_activity_at, iso(2, 9));
assert.equal([...refreshedLocalStorage.values.values()].includes(iso(2, 9)), true);

// ---------------------------------------------------------------------------
// 2. User's reported case: opening an old chat must not promote it, EVEN if the
// click happens before the first repaired cloud-list refresh has completed.
// ---------------------------------------------------------------------------
const earlyClickStorage = makeLegacyStorage([
  {
    id: "formula",
    title: "Formula 1 Car Overview",
    source: "server",
    created: iso(1),
    updated: iso(9, 8),
    last_activity_at: iso(9, 8), // stale polluted cache from an old build
    messages: [],
    pending_server_sync: false,
  },
  {
    id: "today",
    title: "What are the benefits of gu...",
    source: "server",
    created: iso(8, 12),
    updated: iso(8, 12),
    last_activity_at: iso(8, 12),
    messages: [{ id: "today-u", role: "user", content: "new question", timestamp: iso(8, 12) }],
    pending_server_sync: false,
  },
]);
installPolicies(earlyClickStorage);
await earlyClickStorage.mergeChatMessages("formula", [
  { id: "formula-u", role: "user", content: "old F1 question", timestamp: iso(2, 9) },
  { id: "formula-a", role: "assistant", content: "reply read today", timestamp: iso(9, 9) },
], { replaceExisting: true });
ordered = await earlyClickStorage.getAllChats();
assert.deepEqual(ids(ordered), ["today", "formula"], "read-only hydration must not promote the old chat");
assert.equal(ordered[1].last_activity_at, iso(2, 9));

// ---------------------------------------------------------------------------
// 3. Assistant output and rename do not move a chat; a new USER query does.
// ---------------------------------------------------------------------------
await earlyClickStorage.addMessageToChat("formula", "assistant", "late assistant event", null, { timestamp: iso(9, 10) });
assert.deepEqual(ids(await earlyClickStorage.getAllChats()), ["today", "formula"]);
await earlyClickStorage.updateChatTitle("formula", "Renamed Formula chat", { bumpUpdated: true });
assert.deepEqual(ids(await earlyClickStorage.getAllChats()), ["today", "formula"]);
await earlyClickStorage.addMessageToChat("formula", "user", "new user query", null, { timestamp: iso(9, 11) });
assert.deepEqual(ids(await earlyClickStorage.getAllChats()), ["formula", "today"]);
assert.equal(await earlyClickStorage.getConfig("chat_limit"), 50);
assert.equal((await earlyClickStorage.getAllConfig()).chat_limit, 50);

// ---------------------------------------------------------------------------
// 4. Local/guest 51st committed chat evicts exact bottom and leaves no local
// recreation residue (sync queue, generated-file cache, aliases).
// ---------------------------------------------------------------------------
const localFifty = Array.from({ length: 50 }, (_, index) => ({
  id: `local-${index + 1}`,
  title: `Local ${index + 1}`,
  source: "local",
  created: `2026-06-${String(Math.min(index + 1, 30)).padStart(2, "0")}T00:00:00.000Z`,
  // Deliberately pollute the oldest chat's legacy update timestamp.
  updated: index === 0 ? iso(9, 23) : `2026-06-${String(Math.min(index + 1, 30)).padStart(2, "0")}T00:00:00.000Z`,
  messages: index === 0
    ? [{ id: "local-1-u", role: "user", content: "old", timestamp: "2026-06-01T00:00:00.000Z" }]
    : [],
}));
const localRetentionStorage = makeLegacyStorage(localFifty);
localRetentionStorage.__syncJobs.set("stale-sync", {
  id: "stale-sync",
  type: "chat_message",
  payload: { conversationId: "local-1" },
});
localRetentionStorage.__generatedFiles.set("stale-file", {
  id: "stale-file",
  chat_id: "local-1",
});
await localRetentionStorage.setConfig("conversation_aliases:test-user", {
  "local-1": "local-2",
  "points-to-old": "local-1",
  "keep": "local-3",
});
installPolicies(localRetentionStorage);
const createdLocal = await localRetentionStorage.createChat("51st chat");
assert.equal(localRetentionStorage.__chats.size, 50);
assert.equal(localRetentionStorage.__chats.has("local-1"), false);
assert.equal(localRetentionStorage.__chats.has(createdLocal.id), true);
assert.equal(localRetentionStorage.__syncJobs.has("stale-sync"), false);
assert.equal(localRetentionStorage.__generatedFiles.has("stale-file"), false);
assert.deepEqual(localRetentionStorage.__aliases, { keep: "local-3" });

// ---------------------------------------------------------------------------
// 5. Authenticated first user write is not destructive before server ACK.
// The pending 51st row is transient; once acknowledged it becomes confirmed and
// exact bottom pruning occurs.
// ---------------------------------------------------------------------------
const confirmedFifty = Array.from({ length: 50 }, (_, index) => ({
  id: `confirmed-${index + 1}`,
  title: `Confirmed ${index + 1}`,
  source: "server",
  created: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  last_activity_at: index === 0
    ? "2026-07-01T00:00:00.000Z"
    : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  updated: index === 0
    ? "2026-07-01T00:00:00.000Z"
    : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  message_count: 1,
  first_user_message: `question ${index + 1}`,
  messages: [],
  pending_server_sync: false,
}));
confirmedFifty.push({
  id: "pending-51",
  title: "New Chat",
  source: "server",
  created: iso(9, 12),
  updated: iso(9, 12),
  last_activity_at: iso(9, 12),
  message_count: 0,
  messages: [],
  pending_server_sync: true,
});
const pendingStorage = makeLegacyStorage(confirmedFifty);
installPolicies(pendingStorage);
await pendingStorage.addMessageToChat("pending-51", "user", "first real query", null, { timestamp: iso(9, 13) });
assert.equal(pendingStorage.__chats.size, 51, "unconfirmed request must not pre-delete old history");
assert.equal((await pendingStorage.getStorageStats()).chats.count, 50, "only confirmed stored chats count toward the public cap");
await pendingStorage.updateChatSyncState("pending-51", {
  pending_server_sync: false,
  last_activity_at: iso(9, 13),
});
assert.equal(pendingStorage.__chats.size, 50);
assert.equal(pendingStorage.__chats.has("confirmed-1"), false);
assert.equal(pendingStorage.__chats.has("pending-51"), true);

// ---------------------------------------------------------------------------
// 6. No eager remote deletion: if the raw 51st request succeeds because the DB
// atomically evicted an artifact-free bottom chat, the browser never calls the
// destructive DELETE endpoint before that request.
// ---------------------------------------------------------------------------
const atomicPendingId = "atomic-pending";
const atomicLocal = makeLegacyStorage([{
  id: atomicPendingId,
  title: "New Chat",
  source: "server",
  created: iso(9, 12),
  updated: iso(9, 12),
  last_activity_at: iso(9, 12),
  messages: [{ id: "atomic-u", role: "user", content: "query", timestamp: iso(9, 12) }],
  pending_server_sync: true,
}]);
let atomicRemote = Array.from({ length: 50 }, (_, index) => ({
  id: `atomic-remote-${index + 1}`,
  created_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  last_activity_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
}));
const atomicEvents = [];
const atomicApi = {
  async getConversations() {
    atomicEvents.push("list");
    return { conversations: clone(atomicRemote) };
  },
  async deleteConversation(id) {
    atomicEvents.push(`delete:${id}`);
    atomicRemote = atomicRemote.filter((chat) => chat.id !== id);
    return { success: true };
  },
  async sendMessageStream() {
    atomicEvents.push("send");
    // Simulate DB trigger: artifact-free oldest is removed in the same successful
    // transaction that creates the new conversation.
    atomicRemote = atomicRemote.slice(1);
    atomicRemote.push({ id: atomicPendingId, created_at: iso(9, 12), last_activity_at: iso(9, 12) });
    return { tokensReceived: true };
  },
};
const { window: atomicWindow } = installPolicies(atomicLocal, atomicApi);
await atomicWindow.SentIQAPI.sendMessageStream("query", { conversationId: atomicPendingId }, {});
assert.equal(atomicEvents[0], "send", "remote DELETE must never happen before the new request is attempted");
assert.equal(atomicEvents.some((event) => event.startsWith("delete:")), false);

// ---------------------------------------------------------------------------
// 7. Artifact-bearing bottom chat: first insert is rolled back with the safe
// public code; only THEN delete exact bottom through the full API and retry once.
// ---------------------------------------------------------------------------
const retryPendingId = "retry-pending";
const retryLocal = makeLegacyStorage([{
  id: retryPendingId,
  title: "New Chat",
  source: "server",
  created: iso(9, 12),
  updated: iso(9, 12),
  last_activity_at: iso(9, 12),
  messages: [{ id: "retry-u", role: "user", content: "query", timestamp: iso(9, 12) }],
  pending_server_sync: true,
}]);
let retryRemote = Array.from({ length: 50 }, (_, index) => ({
  id: `remote-${index + 1}`,
  created_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
  last_activity_at: index === 0
    ? "2026-07-01T00:00:00.000Z"
    : `2026-07-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  // Must be ignored for ordering even though the assistant answered recently.
  last_message_at: index === 0 ? iso(9, 23) : undefined,
}));
const retryEvents = [];
let retryAttempts = 0;
const retryApi = {
  async getConversations() {
    retryEvents.push("list");
    return { conversations: clone(retryRemote) };
  },
  async deleteConversation(id) {
    retryEvents.push(`delete:${id}`);
    retryRemote = retryRemote.filter((chat) => chat.id !== id);
    return { success: true };
  },
  async sendMessageStream() {
    retryAttempts += 1;
    retryEvents.push(`send:${retryAttempts}`);
    if (retryAttempts === 1) {
      const error = new Error("safe public retention response");
      error.status = 409;
      error.code = "conversation_retention_cleanup_required";
      throw error;
    }
    retryRemote.push({ id: retryPendingId, created_at: iso(9, 12), last_activity_at: iso(9, 12) });
    return { tokensReceived: true };
  },
};
const { window: retryWindow } = installPolicies(retryLocal, retryApi);
await retryWindow.SentIQAPI.sendMessageStream("query", { conversationId: retryPendingId }, {});
assert.deepEqual(retryEvents.slice(0, 4), ["send:1", "list", "delete:remote-1", "send:2"]);
assert.equal(retryAttempts, 2);
assert.equal(retryRemote.length, 50);
assert.equal(retryRemote.some((chat) => chat.id === "remote-1"), false);
assert.equal(retryRemote.some((chat) => chat.id === retryPendingId), true);

console.log("PASS | Conversation ordering, read-only hydration, transactional 50-chat retention, and residue cleanup regressions passed.");
