// ================================================================
// Conversation ordering + 50-chat retention policy
// ================================================================
// Recency is USER activity only:
//   1. conversation creation, or
//   2. the latest user-authored message in that conversation.
//
// Opening/reading, assistant output, title changes, hydration, cache warming,
// and background synchronization must never promote a conversation.

const Storage = window.SentIQStorage;
const MAX_STORED_CHATS = 50;
const LEGACY_INTERNAL_CHAT_LIMIT = 1000;
const USER_ACTIVITY_STORAGE_PREFIX = "sentiq:conversation-user-activity:";
const RETENTION_CLEANUP_CODE = "conversation_retention_cleanup_required";

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
    updateChatSyncState: Storage.updateChatSyncState.bind(Storage),
    upsertServerChat: Storage.upsertServerChat.bind(Storage),
    mergeChatMessages: Storage.mergeChatMessages.bind(Storage),
    replaceChatMessages: Storage.replaceChatMessages.bind(Storage),
    deleteChat: Storage.deleteChat.bind(Storage),
    getConfig: Storage.getConfig.bind(Storage),
    setConfig: Storage.setConfig.bind(Storage),
    getAllConfig: Storage.getAllConfig.bind(Storage),
    getStorageStats: Storage.getStorageStats.bind(Storage),
    getAllSyncJobs: typeof Storage.getAllSyncJobs === "function" ? Storage.getAllSyncJobs.bind(Storage) : null,
    deleteSyncJob: typeof Storage.deleteSyncJob === "function" ? Storage.deleteSyncJob.bind(Storage) : null,
    getAllGeneratedFiles: typeof Storage.getAllGeneratedFiles === "function" ? Storage.getAllGeneratedFiles.bind(Storage) : null,
    deleteGeneratedFile: typeof Storage.deleteGeneratedFile === "function" ? Storage.deleteGeneratedFile.bind(Storage) : null,
    getConversationAliases: typeof Storage.getConversationAliases === "function" ? Storage.getConversationAliases.bind(Storage) : null,
  };

  const activityShadow = new Map();
  const retentionCleanupPromises = new Map();
  const reconciledPendingConversationIds = new Set();
  let apiGuardInstalled = false;

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
    let newest = "";
    let newestMs = null;
    for (const value of values) {
      const parsed = timestampMs(value);
      if (parsed === null) continue;
      if (newestMs === null || parsed > newestMs) {
        newestMs = parsed;
        newest = value;
      }
    }
    return newest;
  }

  function createdTimestamp(chat) {
    return firstValidTimestamp(chat?.created, chat?.created_at);
  }

  function latestUserMessageTimestamp(chat) {
    let latest = "";
    for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
      if (message?.role !== "user") continue;
      latest = newestTimestamp(latest, message?.timestamp, message?.created_at);
    }
    return latest;
  }

  function hasCachedUserMessages(chat) {
    return Array.isArray(chat?.messages) && chat.messages.some((message) => message?.role === "user");
  }

  function isUnconfirmedServerChat(chat) {
    return Boolean(chat?.source === "server" && chat?.pending_server_sync);
  }

  function activeOwnerScope() {
    try {
      const owner = typeof Storage.getActiveUserId === "function" ? Storage.getActiveUserId() : "";
      return String(owner || "guest").trim() || "guest";
    } catch {
      return "guest";
    }
  }

  function activityStorageKey(chatId) {
    return `${USER_ACTIVITY_STORAGE_PREFIX}${activeOwnerScope()}:${String(chatId || "")}`;
  }

  function readActivityShadow(chatId) {
    if (!chatId) return "";
    const key = activityStorageKey(chatId);
    const memoryValue = activityShadow.get(key);
    if (timestampMs(memoryValue) !== null) return memoryValue;
    try {
      const stored = window.localStorage?.getItem?.(key) || "";
      if (timestampMs(stored) !== null) {
        activityShadow.set(key, stored);
        return stored;
      }
    } catch { /* private/blocked storage falls back to memory */ }
    return "";
  }

  function writeActivityShadow(chatId, activity) {
    if (!chatId || timestampMs(activity) === null) return;
    const key = activityStorageKey(chatId);
    activityShadow.set(key, activity);
    try {
      window.localStorage?.setItem?.(key, activity);
    } catch { /* memory shadow still protects this session */ }
  }

  function clearActivityShadow(chatId) {
    if (!chatId) return;
    const key = activityStorageKey(chatId);
    activityShadow.delete(key);
    try {
      window.localStorage?.removeItem?.(key);
    } catch { /* ignore blocked web storage */ }
  }

  function activityTimestamp(chat) {
    const created = createdTimestamp(chat);
    const latestUserMessage = latestUserMessageTimestamp(chat);

    if (chat?.source === "server") {
      const shadow = readActivityShadow(chat?.id);
      if (timestampMs(shadow) !== null) return shadow;

      // A hydrated server cache contains enough evidence to recover exact user
      // activity even if a legacy assistant write polluted `updated`.
      if (hasCachedUserMessages(chat)) {
        return newestTimestamp(created, latestUserMessage) || created;
      }

      // Metadata-only server rows trust only the canonical RPC field.
      return firstValidTimestamp(chat?.last_activity_at, chat?.lastActivityAt, created);
    }

    // Guest/local history derives activity from user messages and creation only.
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
    const activity = activityTimestamp(chat) || createdTimestamp(chat);
    if (!activity) return chat;
    return {
      ...chat,
      updated: activity,
      ...(chat.source === "server" ? { last_activity_at: activity } : {}),
    };
  }

  async function restoreActivity(chatId, activity, lastMessageAt = "") {
    if (!chatId || !activity) return original.getChat(chatId);
    const chat = await original.getChat(chatId);
    if (!chat) return chat;
    if (chat.source === "server") writeActivityShadow(chatId, activity);
    const updated = await original.updateChatSyncState(chatId, {
      updated: activity,
      ...(chat.source === "server" ? { last_activity_at: activity } : {}),
      ...(lastMessageAt ? { last_message_at: lastMessageAt } : {}),
    });
    return normalizeChatForRead(updated);
  }

  function syncJobReferencesChat(job, chatId) {
    const payload = job?.payload && typeof job.payload === "object" ? job.payload : {};
    return [
      payload.conversationId,
      payload.conversation_id,
      payload.localChatId,
      payload.local_chat_id,
      payload.pendingChatId,
      payload.pending_chat_id,
      payload.chatId,
      payload.chat_id,
    ].some((value) => String(value || "").trim() === chatId);
  }

  async function purgeLocalConversationResidue(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;

    if (original.getAllSyncJobs && original.deleteSyncJob) {
      for (const job of await original.getAllSyncJobs()) {
        if (job?.id && syncJobReferencesChat(job, id)) {
          await original.deleteSyncJob(job.id);
        }
      }
    }

    if (original.getAllGeneratedFiles && original.deleteGeneratedFile) {
      for (const file of await original.getAllGeneratedFiles()) {
        if (file?.id && String(file?.chat_id || file?.chatId || "").trim() === id) {
          await original.deleteGeneratedFile(file.id);
        }
      }
    }

    if (original.getConversationAliases) {
      const aliases = await original.getConversationAliases();
      if (aliases && typeof aliases === "object") {
        const nextAliases = {};
        let changed = false;
        for (const [fromChatId, toChatId] of Object.entries(aliases)) {
          if (fromChatId === id || String(toChatId || "") === id) {
            changed = true;
            continue;
          }
          nextAliases[fromChatId] = toChatId;
        }
        if (changed) {
          await original.setConfig(`conversation_aliases:${activeOwnerScope()}`, nextAliases);
        }
      }
    }
  }

  async function deleteCachedChat(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return;
    await purgeLocalConversationResidue(id);
    clearActivityShadow(id);
    reconciledPendingConversationIds.delete(id);
    await original.deleteChat(id);
  }

  async function enforceConfirmedClientRetention(chats) {
    const ordered = [...chats].sort(compareChatsByUserActivity);

    // Never destructively prune an authenticated conversation whose server write
    // has not been acknowledged. This avoids losing the previous oldest chat if
    // the new request fails before the conversation is actually persisted.
    const confirmed = ordered.filter((chat) => !isUnconfirmedServerChat(chat));
    if (confirmed.length <= MAX_STORED_CHATS) return ordered;

    const overflow = confirmed.slice(MAX_STORED_CHATS);
    const overflowIds = new Set(overflow.map((chat) => chat.id));
    for (const chat of overflow) {
      await deleteCachedChat(chat.id);
    }
    return ordered.filter((chat) => !overflowIds.has(chat.id));
  }

  function normalizeRemoteConversation(chat) {
    if (!chat?.id) return null;
    return {
      id: String(chat.id),
      created: firstValidTimestamp(chat?.created, chat?.created_at),
      last_activity_at: firstValidTimestamp(chat?.last_activity_at, chat?.lastActivityAt, chat?.created, chat?.created_at),
      source: "server",
    };
  }

  function compareRemoteByUserActivity(left, right) {
    const rightActivity = timestampMs(right?.last_activity_at || right?.created) || 0;
    const leftActivity = timestampMs(left?.last_activity_at || left?.created) || 0;
    if (rightActivity !== leftActivity) return rightActivity - leftActivity;
    const rightCreated = timestampMs(right?.created) || 0;
    const leftCreated = timestampMs(left?.created) || 0;
    if (rightCreated !== leftCreated) return rightCreated - leftCreated;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  }

  async function cleanupRemoteRetentionSlot(requestedConversationId = "") {
    const key = String(requestedConversationId || "unscoped").trim() || "unscoped";
    if (retentionCleanupPromises.has(key)) return retentionCleanupPromises.get(key);

    const run = (async () => {
      const API = window.SentIQAPI;
      if (!API?.getConversations || !API?.deleteConversation) {
        throw new Error("Conversation retention service is unavailable.");
      }

      const response = await API.getConversations();
      const remoteChats = (Array.isArray(response?.conversations) ? response.conversations : [])
        .map(normalizeRemoteConversation)
        .filter(Boolean)
        .sort(compareRemoteByUserActivity);

      // A concurrent retry/device may already have created this exact client ID.
      if (requestedConversationId && remoteChats.some((chat) => chat.id === requestedConversationId)) {
        return;
      }

      while (remoteChats.length >= MAX_STORED_CHATS) {
        const leastRecent = remoteChats.pop();
        if (!leastRecent?.id) break;
        try {
          // Full API deletion removes generated-file/image Storage objects before
          // deleting the relational conversation row.
          await API.deleteConversation(leastRecent.id);
        } catch (error) {
          if (Number(error?.status) !== 404) throw error;
        }
        await deleteCachedChat(leastRecent.id);
      }
    })().finally(() => {
      retentionCleanupPromises.delete(key);
    });

    retentionCleanupPromises.set(key, run);
    return run;
  }

  async function reconcilePendingConversationAfterSuccess(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id || reconciledPendingConversationIds.has(id)) return;
    const localBefore = await original.getChat(id).catch(() => null);
    if (!localBefore?.pending_server_sync) return;

    const API = window.SentIQAPI;
    if (!API?.getConversations) return;
    const response = await API.getConversations();
    const remoteRows = Array.isArray(response?.conversations) ? response.conversations : [];
    const remoteIds = new Set(remoteRows.map((chat) => String(chat?.id || "").trim()).filter(Boolean));
    if (!remoteIds.has(id)) return;

    // Refresh canonical activity shadows from the authoritative list. This also
    // repairs historical browser cache timestamps that were polluted before this
    // fix shipped.
    for (const remote of remoteRows) {
      const remoteId = String(remote?.id || "").trim();
      if (!remoteId) continue;
      const canonicalActivity = firstValidTimestamp(
        remote?.last_activity_at,
        remote?.lastActivityAt,
        remote?.created_at,
        remote?.created,
      );
      if (canonicalActivity) writeActivityShadow(remoteId, canonicalActivity);
    }

    const createdRemote = remoteRows.find((chat) => String(chat?.id || "").trim() === id);
    await original.updateChatSyncState(id, {
      pending_server_sync: false,
      sync_error: null,
      ...(createdRemote?.last_activity_at ? { last_activity_at: createdRemote.last_activity_at } : {}),
    });

    // If the database atomically evicted an artifact-free bottom conversation,
    // remove that exact missing server row from the browser cache instead of
    // guessing from potentially stale local metadata.
    for (const local of await original.getAllChats()) {
      if (local?.source !== "server" || local?.pending_server_sync) continue;
      const localId = String(local?.id || "").trim();
      if (localId && !remoteIds.has(localId)) {
        await deleteCachedChat(localId);
      }
    }

    reconciledPendingConversationIds.add(id);
    await Storage.getAllChats();
  }

  function installApiRetentionGuard() {
    if (apiGuardInstalled) return true;
    const API = window.SentIQAPI;
    if (!API) return false;

    const wrap = (name, getConversationId) => {
      const method = API[name];
      if (typeof method !== "function") return;
      API[name] = async function retentionTransactionGuard(...args) {
        const conversationId = String(getConversationId(...args) || "").trim();
        try {
          const result = await method(...args);
          await reconcilePendingConversationAfterSuccess(conversationId).catch(() => {});
          return result;
        } catch (error) {
          if (String(error?.code || "") !== RETENTION_CLEANUP_CODE) throw error;

          // The first insert was rolled back by the database, so no old chat has
          // been deleted yet. Clean the exact bottom chat through the full API,
          // then retry the original idempotent request once.
          await cleanupRemoteRetentionSlot(conversationId);
          const result = await method(...args);
          await reconcilePendingConversationAfterSuccess(conversationId).catch(() => {});
          return result;
        }
      };
    };

    wrap("createConversation", (_title, conversationId) => conversationId);
    wrap("sendMessage", (_message, context = {}) => context?.conversationId || context?.conversation_id);
    wrap("sendMessageStream", (_message, context = {}) => context?.conversationId || context?.conversation_id);
    wrap("syncChatMessages", (payload = {}) => payload?.conversationId || payload?.conversation_id);
    wrap("generateImage", (_prompt, options = {}) => options?.conversationId || options?.conversation_id);

    apiGuardInstalled = true;
    return true;
  }

  function scheduleApiGuard(attempt = 0) {
    if (installApiRetentionGuard()) return;
    if (attempt >= 20) return;
    setTimeout(() => scheduleApiGuard(attempt + 1), 0);
  }

  if (original.createChat) {
    Storage.createChat = async function createChatWithStrictRetention(title) {
      const chat = await original.createChat(title);
      await Storage.getAllChats();
      return chat;
    };
  }

  Storage.getAllChats = async function getAllChatsStrictlyOrdered() {
    const chats = (await original.getAllChats()).map(normalizeChatForRead);
    return enforceConfirmedClientRetention(chats);
  };

  Storage.getLocalChats = async function getLocalChatsStrictlyOrdered() {
    return (await Storage.getAllChats()).filter((chat) => chat?.source !== "server");
  };

  Storage.deleteChat = async function deleteChatWithLocalResidueCleanup(chatId) {
    return deleteCachedChat(chatId);
  };

  Storage.compareChatsByActivity = compareChatsByUserActivity;
  Storage.compareChatsByUserActivity = compareChatsByUserActivity;

  Storage.addMessageToChat = async function addMessageWithoutAssistantRecency(
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
      if (!isUnconfirmedServerChat(updated)) await Storage.getAllChats();
      return updated;
    }

    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.upsertMessageInChat = async function upsertMessageWithoutAssistantRecency(chatId, message) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const messageId = typeof message?.id === "string" ? message.id.trim() : "";
    const existed = Boolean(messageId && Array.isArray(before?.messages) && before.messages.some((item) => item?.id === messageId));
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
      if (!isUnconfirmedServerChat(updated)) await Storage.getAllChats();
      return updated;
    }

    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.updateMessageInChat = async function updateMessageWithoutRecency(chatId, messageId, updates = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateMessageInChat(chatId, messageId, updates);
    const lastMessageAt = result?.last_message_at || result?.messages?.[result.messages.length - 1]?.timestamp || "";
    return restoreActivity(chatId, beforeActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.updateChatTitle = async function updateTitleWithoutRecency(chatId, title, options = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateChatTitle(chatId, title, { ...options, bumpUpdated: false });
    if (!result || !beforeActivity) return result;
    return restoreActivity(chatId, beforeActivity, result?.last_message_at || "");
  };

  Storage.updateChatSyncState = async function updateSyncStateAndFinalizeRetention(chatId, updates = {}) {
    const result = await original.updateChatSyncState(chatId, updates);
    if (!result) return result;
    const canonicalActivity = firstValidTimestamp(updates?.last_activity_at, updates?.lastActivityAt);
    if (result.source === "server" && canonicalActivity) {
      writeActivityShadow(result.id, canonicalActivity);
    }
    const normalized = normalizeChatForRead(result);
    if (updates?.pending_server_sync === false) {
      await Storage.getAllChats();
    }
    return normalized;
  };

  Storage.upsertServerChat = async function upsertServerChatWithCanonicalActivity(chatData) {
    const result = await original.upsertServerChat(chatData);
    if (!result) return result;
    const canonicalActivity = firstValidTimestamp(
      chatData?.last_activity_at,
      chatData?.lastActivityAt,
      chatData?.created_at,
      chatData?.created,
    );
    // Deliberately allow a DOWNGRADE: the server migration repairs historical
    // activity that old browser versions incorrectly promoted.
    if (canonicalActivity) writeActivityShadow(result.id, canonicalActivity);
    const normalized = normalizeChatForRead(result);
    if (!isUnconfirmedServerChat(normalized)) await Storage.getAllChats();
    return normalized;
  };

  Storage.mergeChatMessages = async function hydrateMessagesWithoutReadRecency(chatId, messages, options = {}) {
    const before = await original.getChat(chatId);
    const result = await original.mergeChatMessages(chatId, messages, options);
    if (!result) return result;
    const userActivity = newestTimestamp(
      createdTimestamp(result),
      latestUserMessageTimestamp(result),
      activityTimestamp(before),
    );
    const lastMessageAt = result?.messages?.[result.messages.length - 1]?.timestamp || result?.last_message_at || "";
    return restoreActivity(chatId, userActivity || createdTimestamp(result), lastMessageAt);
  };

  Storage.replaceChatMessages = async function replaceMessagesWithoutReadRecency(chatId, messages) {
    return Storage.mergeChatMessages(chatId, messages, { replaceExisting: true });
  };

  Storage.getConfig = async function getConfigWithFixedChatLimit(key) {
    if (key === "chat_limit") return MAX_STORED_CHATS;
    return original.getConfig(key);
  };

  Storage.setConfig = async function setConfigWithFixedChatLimit(key, value) {
    if (key === "chat_limit") {
      await original.setConfig(key, LEGACY_INTERNAL_CHAT_LIMIT);
      return MAX_STORED_CHATS;
    }
    return original.setConfig(key, value);
  };

  Storage.getAllConfig = async function getAllConfigWithFixedChatLimit() {
    return { ...(await original.getAllConfig()), chat_limit: MAX_STORED_CHATS };
  };

  Storage.getStorageStats = async function getStorageStatsWithFixedChatLimit() {
    const stats = await original.getStorageStats();
    const chats = await Storage.getAllChats();
    const confirmedCount = chats.filter((chat) => !isUnconfirmedServerChat(chat)).length;
    return {
      ...stats,
      chats: {
        ...(stats?.chats || {}),
        count: Math.min(confirmedCount, MAX_STORED_CHATS),
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

  // The legacy IndexedDB limiter sorts by `updated`, which old versions allowed
  // assistant messages to mutate. Keep it out of the decision path; the strict
  // policy above owns the public 50-chat limit and immediately prunes confirmed
  // overflow with the correct user-activity comparator.
  original.setConfig("chat_limit", LEGACY_INTERNAL_CHAT_LIMIT).catch(() => null);
  scheduleApiGuard();
}
