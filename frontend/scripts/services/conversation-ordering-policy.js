// ================================================================
// Conversation ordering + retention policy
// ================================================================
// The sidebar is ordered by the latest USER activity only:
//   1. conversation creation, or
//   2. the latest user-authored message in that conversation.
// Reading/opening a conversation, assistant output, title changes, cache warming,
// and remote hydration must never move a conversation upward in history.
//
// Authenticated "New Chat" placeholders are intentionally local-only until the
// first user write (the existing product contract avoids empty Supabase rows).
// Such blank placeholders are transient drafts and do not consume one of the 50
// persisted-conversation slots until the user actually writes into them.

const Storage = window.SentIQStorage;
const MAX_STORED_CHATS = 50;
const LEGACY_INTERNAL_CHAT_LIMIT = 1000;
const USER_ACTIVITY_STORAGE_PREFIX = "sentiq:conversation-user-activity:";

if (Storage && !Storage.__conversationOrderingPolicyInstalled) {
  const original = {
    createChat: typeof Storage.createChat === "function" ? Storage.createChat.bind(Storage) : null,
    getChat: Storage.getChat.bind(Storage),
    getAllChats: Storage.getAllChats.bind(Storage),
    getLocalChats: Storage.getLocalChats.bind(Storage),
    addMessageToChat: Storage.addMessageToChat.bind(Storage),
    upsertMessageInChat: Storage.upsertMessageInChat.bind(Storage),
    updateMessageInChat: Storage.updateMessageInChat.bind(Storage),
    updateChatTitle: Storage.updateChatTitle.bind(Storage),
    upsertServerChat: Storage.upsertServerChat.bind(Storage),
    mergeChatMessages: Storage.mergeChatMessages.bind(Storage),
    replaceChatMessages: Storage.replaceChatMessages.bind(Storage),
    updateChatSyncState: Storage.updateChatSyncState.bind(Storage),
    deleteChat: Storage.deleteChat.bind(Storage),
    getConfig: Storage.getConfig.bind(Storage),
    setConfig: Storage.setConfig.bind(Storage),
    getAllConfig: Storage.getAllConfig.bind(Storage),
    getStorageStats: Storage.getStorageStats.bind(Storage),
  };

  const persistedUserActivityMemory = new Map();
  const retentionPreparedChatIds = new Set();
  const retentionPreparePromises = new Map();
  let apiRetentionGuardInstalled = false;

  function timestampMs(value) {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function firstValidTimestamp(...values) {
    for (const value of values) {
      if (timestampMs(value) !== null) return value;
    }
    return "";
  }

  function newestTimestamp(...values) {
    let newestValue = "";
    let newestMs = null;
    for (const value of values) {
      const parsed = timestampMs(value);
      if (parsed === null) continue;
      if (newestMs === null || parsed > newestMs) {
        newestMs = parsed;
        newestValue = value;
      }
    }
    return newestValue;
  }

  function createdTimestamp(chat) {
    return firstValidTimestamp(chat?.created, chat?.created_at);
  }

  function latestUserMessageTimestamp(chat) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    let latest = "";
    for (const message of messages) {
      if (message?.role !== "user") continue;
      latest = newestTimestamp(latest, message?.timestamp, message?.created_at);
    }
    return latest;
  }

  function hasCachedUserMessages(chat) {
    return Array.isArray(chat?.messages) && chat.messages.some((message) => message?.role === "user");
  }

  function isTransientBlankServerPlaceholder(chat) {
    if (!chat || chat.source !== "server" || !chat.pending_server_sync) return false;
    if (hasCachedUserMessages(chat)) return false;
    const messageCount = Number(chat.message_count || 0);
    if (Number.isFinite(messageCount) && messageCount > 0) return false;
    if (String(chat.first_user_message || "").trim()) return false;
    return !(Array.isArray(chat.messages) && chat.messages.length > 0);
  }

  function activeOwnerScope() {
    try {
      const owner = typeof Storage.getActiveUserId === "function" ? Storage.getActiveUserId() : "";
      return String(owner || "guest").trim() || "guest";
    } catch {
      return "guest";
    }
  }

  function userActivityStorageKey(chatId) {
    return `${USER_ACTIVITY_STORAGE_PREFIX}${activeOwnerScope()}:${String(chatId || "")}`;
  }

  function readPersistedUserActivity(chat) {
    const chatId = chat?.id;
    if (!chatId) return "";
    const key = userActivityStorageKey(chatId);
    const memoryValue = persistedUserActivityMemory.get(key);
    if (timestampMs(memoryValue) !== null) return memoryValue;
    try {
      const stored = window.localStorage?.getItem?.(key) || "";
      if (timestampMs(stored) !== null) {
        persistedUserActivityMemory.set(key, stored);
        return stored;
      }
    } catch { /* private/blocked storage falls back to in-memory activity */ }
    return "";
  }

  function persistUserActivity(chatId, activity) {
    if (!chatId || timestampMs(activity) === null) return;
    const key = userActivityStorageKey(chatId);
    persistedUserActivityMemory.set(key, activity);
    try {
      window.localStorage?.setItem?.(key, activity);
    } catch { /* IndexedDB cache remains available; in-memory shadow is enough for this session */ }
  }

  function clearPersistedUserActivity(chatId) {
    if (!chatId) return;
    const key = userActivityStorageKey(chatId);
    persistedUserActivityMemory.delete(key);
    try {
      window.localStorage?.removeItem?.(key);
    } catch { /* ignore blocked web storage */ }
  }

  function activityTimestamp(chat) {
    const created = createdTimestamp(chat);
    const latestUserMessage = latestUserMessageTimestamp(chat);

    if (chat?.source === "server") {
      // The shadow timestamp survives legacy cache writes that still mutate
      // `updated`/`last_activity_at` for assistant messages. It is populated
      // from the canonical server RPC and from verified local user messages.
      const persistedActivity = readPersistedUserActivity(chat);
      if (timestampMs(persistedActivity) !== null) return persistedActivity;

      // Before the first remote refresh, a fully hydrated cache has enough
      // evidence to recover the exact latest user-authored timestamp itself.
      if (hasCachedUserMessages(chat)) {
        return newestTimestamp(created, latestUserMessage) || created;
      }

      // Metadata-only server chats trust only the canonical field repaired by
      // the Supabase migration. Never fall back to last_message_at or updated.
      return firstValidTimestamp(
        chat?.last_activity_at,
        chat?.lastActivityAt,
        created,
      );
    }

    // Local/temporary chats retain their messages, so never use `updated` as
    // recency: older assistant writes may have polluted it.
    return newestTimestamp(created, latestUserMessage) || created;
  }

  function compareChatsByUserActivity(left, right) {
    const rightActivity = timestampMs(activityTimestamp(right)) || 0;
    const leftActivity = timestampMs(activityTimestamp(left)) || 0;
    if (rightActivity !== leftActivity) return rightActivity - leftActivity;

    const rightCreated = timestampMs(createdTimestamp(right)) || 0;
    const leftCreated = timestampMs(createdTimestamp(left)) || 0;
    if (rightCreated !== leftCreated) return rightCreated - leftCreated;

    return String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  function normalizeChatForRead(chat) {
    if (!chat) return chat;
    const activity = activityTimestamp(chat) || createdTimestamp(chat) || "";
    if (!activity) return chat;
    if (chat.source === "server") {
      return {
        ...chat,
        updated: activity,
        last_activity_at: activity,
      };
    }
    return {
      ...chat,
      updated: activity,
    };
  }

  async function restoreActivity(chatId, activity, lastMessageAt) {
    if (!chatId || !activity) return original.getChat(chatId);
    const chat = await original.getChat(chatId);
    if (!chat) return chat;
    if (chat.source === "server") persistUserActivity(chatId, activity);
    const updated = await original.updateChatSyncState(chatId, {
      updated: activity,
      ...(chat.source === "server" ? { last_activity_at: activity } : {}),
      ...(lastMessageAt ? { last_message_at: lastMessageAt } : {}),
    });
    return normalizeChatForRead(updated);
  }

  async function deleteCachedChat(chatId) {
    clearPersistedUserActivity(chatId);
    return original.deleteChat(chatId);
  }

  async function enforceClientRetention(chats) {
    const ordered = [...chats].sort(compareChatsByUserActivity);
    const committed = ordered.filter((chat) => !isTransientBlankServerPlaceholder(chat));
    if (committed.length <= MAX_STORED_CHATS) return ordered;

    // This is browser-cache cleanup only. Blank authenticated placeholders are
    // deliberately excluded until the first user write, matching the existing
    // no-empty-Supabase-row product contract.
    const overflow = committed.slice(MAX_STORED_CHATS);
    const overflowIds = new Set(overflow.map((chat) => chat.id));
    await Promise.allSettled(overflow.map((chat) => deleteCachedChat(chat.id)));
    return ordered.filter((chat) => !overflowIds.has(chat.id));
  }

  function normalizeRemoteConversation(chat) {
    if (!chat?.id) return null;
    const created = firstValidTimestamp(chat.created, chat.created_at);
    const activity = firstValidTimestamp(chat.last_activity_at, chat.lastActivityAt, created);
    return {
      id: chat.id,
      created,
      last_activity_at: activity,
      source: "server",
    };
  }

  async function ensureRemoteRetentionSlot(conversationId) {
    const chatId = typeof conversationId === "string" ? conversationId.trim() : "";
    if (!chatId || retentionPreparedChatIds.has(chatId)) return;
    if (retentionPreparePromises.has(chatId)) return retentionPreparePromises.get(chatId);

    const localChat = await original.getChat(chatId).catch(() => null);
    if (!localChat?.pending_server_sync) {
      retentionPreparedChatIds.add(chatId);
      return;
    }

    const run = (async () => {
      const API = window.SentIQAPI;
      if (!API?.getConversations || !API?.deleteConversation) {
        throw new Error("Conversation retention service is unavailable.");
      }

      const response = await API.getConversations();
      const remoteChats = (Array.isArray(response?.conversations) ? response.conversations : [])
        .map(normalizeRemoteConversation)
        .filter(Boolean)
        .sort(compareChatsByUserActivity);

      // A retry may arrive after the same client UUID has already been created.
      if (remoteChats.some((chat) => chat.id === chatId)) {
        retentionPreparedChatIds.add(chatId);
        return;
      }

      while (remoteChats.length >= MAX_STORED_CHATS) {
        const leastRecent = remoteChats.pop();
        if (!leastRecent?.id) break;
        try {
          // Important: use the normal DELETE route, not a raw Supabase delete.
          // The backend removes generated-file and generated-image objects first.
          await API.deleteConversation(leastRecent.id);
        } catch (error) {
          // Another tab/device may have removed the same row after our list read.
          // A 404 is already the desired state; any other cleanup failure blocks
          // creation so we never knowingly create a 51st chat with orphaned data.
          if (Number(error?.status) !== 404) throw error;
        }
        await deleteCachedChat(leastRecent.id).catch(() => null);
      }

      retentionPreparedChatIds.add(chatId);
    })().finally(() => {
      retentionPreparePromises.delete(chatId);
    });

    retentionPreparePromises.set(chatId, run);
    return run;
  }

  function installApiRetentionGuard() {
    if (apiRetentionGuardInstalled) return true;
    const API = window.SentIQAPI;
    if (!API) return false;

    const wrapConversationMethod = (name, getConversationId) => {
      const method = API[name];
      if (typeof method !== "function") return;
      API[name] = async function retentionGuardedApiMethod(...args) {
        const conversationId = getConversationId(...args);
        if (conversationId) await ensureRemoteRetentionSlot(conversationId);
        return method(...args);
      };
    };

    wrapConversationMethod("createConversation", (_title, conversationId) => conversationId);
    wrapConversationMethod("sendMessage", (_message, context = {}) => context?.conversationId || context?.conversation_id);
    wrapConversationMethod("sendMessageStream", (_message, context = {}) => context?.conversationId || context?.conversation_id);
    wrapConversationMethod("syncChatMessages", (payload = {}) => payload?.conversationId || payload?.conversation_id);
    wrapConversationMethod("generateImage", (_prompt, options = {}) => options?.conversationId || options?.conversation_id);

    apiRetentionGuardInstalled = true;
    return true;
  }

  function scheduleApiRetentionGuardInstall(attempt = 0) {
    if (installApiRetentionGuard()) return;
    if (attempt >= 20) return;
    setTimeout(() => scheduleApiRetentionGuardInstall(attempt + 1), 0);
  }

  if (original.createChat) {
    Storage.createChat = async function createChatWithStrictRetention(title) {
      const chat = await original.createChat(title);
      await Storage.getAllChats();
      return chat;
    };
  }

  Storage.getAllChats = async function getAllChatsWithUserActivityOrdering() {
    const chats = await original.getAllChats();
    const normalized = chats.map(normalizeChatForRead);
    return enforceClientRetention(normalized);
  };

  Storage.getLocalChats = async function getLocalChatsWithUserActivityOrdering() {
    const chats = await Storage.getAllChats();
    return chats.filter((chat) => chat?.source !== "server");
  };

  Storage.deleteChat = async function deleteChatAndActivityShadow(chatId) {
    return deleteCachedChat(chatId);
  };

  Storage.compareChatsByActivity = compareChatsByUserActivity;
  Storage.compareChatsByUserActivity = compareChatsByUserActivity;

  Storage.addMessageToChat = async function addMessageWithoutAssistantRecencyBump(
    chatId,
    role,
    content,
    meta,
    options = {},
  ) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.addMessageToChat(chatId, role, content, meta, options);
    const lastMessageAt = result?.last_message_at || result?.messages?.[result.messages.length - 1]?.timestamp || "";

    if (role === "user") {
      const userActivity = newestTimestamp(
        beforeActivity,
        options?.timestamp,
        latestUserMessageTimestamp(result),
        createdTimestamp(result),
      );
      const updated = await restoreActivity(chatId, userActivity, lastMessageAt);
      await Storage.getAllChats();
      return updated;
    }

    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.upsertMessageInChat = async function upsertMessageWithoutAssistantRecencyBump(chatId, message) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const messageId = typeof message?.id === "string" ? message.id.trim() : "";
    const existed = Boolean(
      messageId && Array.isArray(before?.messages) && before.messages.some((item) => item?.id === messageId),
    );
    const result = await original.upsertMessageInChat(chatId, message);
    const lastMessageAt = result?.last_message_at || result?.messages?.[result.messages.length - 1]?.timestamp || "";

    if (message?.role === "user" && !existed) {
      const userActivity = newestTimestamp(
        beforeActivity,
        message?.timestamp,
        latestUserMessageTimestamp(result),
        createdTimestamp(result),
      );
      const updated = await restoreActivity(chatId, userActivity, lastMessageAt);
      await Storage.getAllChats();
      return updated;
    }

    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.updateMessageInChat = async function updateMessageWithoutRecencyBump(chatId, messageId, updates = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateMessageInChat(chatId, messageId, updates);
    const lastMessageAt = result?.last_message_at || result?.messages?.[result.messages.length - 1]?.timestamp || "";
    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.updateChatTitle = async function updateTitleWithoutRecencyBump(chatId, title, options = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateChatTitle(chatId, title, { ...options, bumpUpdated: false });
    if (!result || !beforeActivity) return result;
    return restoreActivity(chatId, beforeActivity, result?.last_message_at || "");
  };

  Storage.upsertServerChat = async function upsertServerChatWithCanonicalUserActivity(chatData) {
    const canonicalActivity = firstValidTimestamp(
      chatData?.last_activity_at,
      chatData?.lastActivityAt,
      chatData?.created,
      chatData?.created_at,
    );
    const result = await original.upsertServerChat(chatData);
    if (!result) return result;

    // This intentionally allows a DOWNGRADE. Historical cache pollution must
    // not win over the repaired server's canonical user-activity timestamp.
    if (canonicalActivity) persistUserActivity(result.id, canonicalActivity);
    const normalized = normalizeChatForRead(result);
    if (!isTransientBlankServerPlaceholder(normalized)) {
      await Storage.getAllChats();
    }
    return normalized;
  };

  Storage.mergeChatMessages = async function mergeChatMessagesWithoutReadRecency(chatId, messages, options = {}) {
    const before = await original.getChat(chatId);
    const result = await original.mergeChatMessages(chatId, messages, options);
    if (!result) return result;

    const exactUserActivity = newestTimestamp(
      createdTimestamp(result),
      latestUserMessageTimestamp(result),
    );
    const fallbackActivity = activityTimestamp(before) || createdTimestamp(result);
    const activity = exactUserActivity || fallbackActivity;
    const lastMessageAt = result?.messages?.[result.messages.length - 1]?.timestamp || result?.last_message_at || "";
    return restoreActivity(chatId, activity, lastMessageAt);
  };

  Storage.replaceChatMessages = async function replaceChatMessagesWithoutReadRecency(chatId, messages) {
    return Storage.mergeChatMessages(chatId, messages, { replaceExisting: true });
  };

  Storage.getConfig = async function getConfigWithFixedChatRetention(key) {
    if (key === "chat_limit") return MAX_STORED_CHATS;
    return original.getConfig(key);
  };

  Storage.setConfig = async function setConfigWithFixedChatRetention(key, value) {
    if (key === "chat_limit") {
      // Keep the legacy internal limiter out of the ordering decision because it
      // evicts by the old `updated` field. Public/UI retention remains exactly 50
      // and is enforced immediately by the strict comparator above.
      await original.setConfig(key, LEGACY_INTERNAL_CHAT_LIMIT);
      return MAX_STORED_CHATS;
    }
    return original.setConfig(key, value);
  };

  Storage.getAllConfig = async function getAllConfigWithFixedChatRetention() {
    const config = await original.getAllConfig();
    return { ...config, chat_limit: MAX_STORED_CHATS };
  };

  Storage.getStorageStats = async function getStorageStatsWithFixedChatRetention() {
    const stats = await original.getStorageStats();
    const chats = await Storage.getAllChats();
    const committedCount = chats.filter((chat) => !isTransientBlankServerPlaceholder(chat)).length;
    return {
      ...stats,
      chats: {
        ...(stats?.chats || {}),
        count: Math.min(committedCount, MAX_STORED_CHATS),
        limit: MAX_STORED_CHATS,
      },
    };
  };

  Object.defineProperty(Storage, "__conversationOrderingPolicyInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(Storage, "MAX_STORED_CHATS", {
    value: MAX_STORED_CHATS,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  // Prevent the legacy IndexedDB limiter from making a wrong ordering decision
  // before our strict post-create pruning runs. This is intentionally internal;
  // every public settings/stat surface still reports the product limit of 50.
  original.setConfig("chat_limit", LEGACY_INTERNAL_CHAT_LIMIT).catch(() => null);
  scheduleApiRetentionGuardInstall();
}
