// ================================================================
// Conversation ordering + retention policy
// ================================================================
// The sidebar is ordered by the latest USER activity only:
//   1. conversation creation, or
//   2. the latest user-authored message in that conversation.
// Reading/opening a conversation, assistant output, title changes, cache warming,
// and remote hydration must never move a conversation upward in history.

const Storage = window.SentIQStorage;
const MAX_STORED_CHATS = 50;

if (Storage && !Storage.__conversationOrderingPolicyInstalled) {
  const original = {
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

  function activityTimestamp(chat) {
    const created = createdTimestamp(chat);
    const latestUserMessage = latestUserMessageTimestamp(chat);

    if (chat?.source === "server") {
      // A hydrated chat contains enough evidence to derive exact user activity
      // without trusting older cached metadata that may have been polluted by an
      // assistant message. Metadata-only server chats use the canonical
      // last_activity_at returned by the repaired Supabase RPC.
      if (hasCachedUserMessages(chat)) {
        return newestTimestamp(created, latestUserMessage) || created;
      }
      return firstValidTimestamp(
        chat?.last_activity_at,
        chat?.lastActivityAt,
        created,
      );
    }

    // Local/temporary chats always retain their messages, so never use `updated`
    // as recency: legacy assistant writes may have changed it.
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
    return original.updateChatSyncState(chatId, {
      updated: activity,
      ...(chat.source === "server" ? { last_activity_at: activity } : {}),
      ...(lastMessageAt ? { last_message_at: lastMessageAt } : {}),
    });
  }

  async function enforceClientRetention(chats) {
    const ordered = [...chats].sort(compareChatsByUserActivity);
    if (ordered.length <= MAX_STORED_CHATS) return ordered;

    // This is browser-cache cleanup only. Authenticated remote retention is
    // prepared through the API guard below so the backend can delete stored
    // image/file artifacts before the Supabase conversation row disappears.
    const overflow = ordered.slice(MAX_STORED_CHATS);
    await Promise.allSettled(overflow.map((chat) => original.deleteChat(chat.id)));
    return ordered.slice(0, MAX_STORED_CHATS);
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
        await original.deleteChat(leastRecent.id).catch(() => null);
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

  Storage.getAllChats = async function getAllChatsWithUserActivityOrdering() {
    const chats = await original.getAllChats();
    const normalized = chats.map(normalizeChatForRead);
    return enforceClientRetention(normalized);
  };

  Storage.getLocalChats = async function getLocalChatsWithUserActivityOrdering() {
    const chats = await Storage.getAllChats();
    return chats.filter((chat) => chat?.source !== "server");
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
      return restoreActivity(chatId, userActivity, lastMessageAt);
    }

    return restoreActivity(
      chatId,
      beforeActivity || createdTimestamp(result),
      lastMessageAt,
    );
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
      return restoreActivity(chatId, userActivity, lastMessageAt);
    }

    return restoreActivity(
      chatId,
      beforeActivity || createdTimestamp(result),
      lastMessageAt,
    );
  };

  Storage.updateMessageInChat = async function updateMessageWithoutRecencyBump(chatId, messageId, updates = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateMessageInChat(chatId, messageId, updates);
    const lastMessageAt = result?.last_message_at || result?.messages?.[result.messages.length - 1]?.timestamp || "";
    return restoreActivity(
      chatId,
      beforeActivity || createdTimestamp(result),
      lastMessageAt,
    );
  };

  Storage.updateChatTitle = async function updateTitleWithoutRecencyBump(chatId, title, options = {}) {
    const before = await original.getChat(chatId);
    const beforeActivity = activityTimestamp(before) || createdTimestamp(before);
    const result = await original.updateChatTitle(chatId, title, { ...options, bumpUpdated: false });
    if (!result || !beforeActivity) return result;
    return restoreActivity(chatId, beforeActivity, result?.last_message_at || "");
  };

  Storage.upsertServerChat = async function upsertServerChatWithCanonicalUserActivity(chatData) {
    const existing = await original.getChat(chatData?.id).catch(() => null);
    const canonicalActivity = firstValidTimestamp(
      chatData?.last_activity_at,
      chatData?.lastActivityAt,
      chatData?.created,
      chatData?.created_at,
    );

    // Older versions preserved the newest cached activity forever. If the
    // repaired server now returns an earlier canonical timestamp, rebuild this
    // metadata row so historical assistant/read pollution is actually removed
    // from IndexedDB rather than merely hidden for one render.
    const existingActivityMs = timestampMs(firstValidTimestamp(existing?.last_activity_at, existing?.updated));
    const canonicalActivityMs = timestampMs(canonicalActivity);
    const canRepairPollutedServerCache = Boolean(
      existing
      && existing.source === "server"
      && !existing.pending_server_sync
      && canonicalActivityMs !== null
      && existingActivityMs !== null
      && canonicalActivityMs < existingActivityMs,
    );

    if (canRepairPollutedServerCache) {
      await original.deleteChat(existing.id);
      return original.upsertServerChat({
        ...chatData,
        id: existing.id,
        title: chatData?.title || existing.title,
        created: firstValidTimestamp(chatData?.created, chatData?.created_at, existing.created),
        last_activity_at: canonicalActivity,
        updated: canonicalActivity,
        message_count: Number.isFinite(Number(chatData?.message_count))
          ? Number(chatData.message_count)
          : Number(existing?.message_count || existing?.messages?.length || 0),
        first_user_message: chatData?.first_user_message || existing?.first_user_message || null,
        last_message_at: firstValidTimestamp(chatData?.last_message_at, chatData?.lastMessageAt, existing?.last_message_at),
        message_cache_status: "metadata-only",
        warmed_at: null,
      });
    }

    const result = await original.upsertServerChat(chatData);
    return result ? normalizeChatForRead(result) : result;
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

    // updateChatSyncState is monotonic in the legacy storage implementation.
    // For hydrated server chats, normalizeChatForRead supplies the strict
    // user-derived timestamp to every caller even if the compatibility field
    // inside the underlying row was touched by the final assistant message.
    await restoreActivity(chatId, activity, lastMessageAt);
    const stored = await original.getChat(chatId);
    return normalizeChatForRead(stored);
  };

  Storage.replaceChatMessages = async function replaceChatMessagesWithoutReadRecency(chatId, messages) {
    return Storage.mergeChatMessages(chatId, messages, { replaceExisting: true });
  };

  Storage.getConfig = async function getConfigWithFixedChatRetention(key) {
    if (key === "chat_limit") return MAX_STORED_CHATS;
    return original.getConfig(key);
  };

  Storage.setConfig = async function setConfigWithFixedChatRetention(key, value) {
    if (key === "chat_limit") return original.setConfig(key, MAX_STORED_CHATS);
    return original.setConfig(key, value);
  };

  Storage.getAllConfig = async function getAllConfigWithFixedChatRetention() {
    const config = await original.getAllConfig();
    return { ...config, chat_limit: MAX_STORED_CHATS };
  };

  Storage.getStorageStats = async function getStorageStatsWithFixedChatRetention() {
    const stats = await original.getStorageStats();
    return {
      ...stats,
      chats: {
        ...(stats?.chats || {}),
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

  scheduleApiRetentionGuardInstall();
}
