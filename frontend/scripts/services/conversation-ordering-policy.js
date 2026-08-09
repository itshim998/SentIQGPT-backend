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

  function activityTimestamp(chat) {
    const created = createdTimestamp(chat);
    const latestUserMessage = latestUserMessageTimestamp(chat);

    // Server last_activity_at is authoritative once the user-activity migration
    // is applied. Never fall back to last_message_at: assistant output is not
    // conversation recency under the product policy.
    if (chat?.source === "server") {
      return firstValidTimestamp(
        chat?.last_activity_at,
        chat?.lastActivityAt,
        latestUserMessage,
        created,
      );
    }

    // Local/temporary chats can derive exact recency from their user messages.
    // `updated` is retained only as a legacy fallback for metadata-only records.
    return firstValidTimestamp(
      latestUserMessage,
      chat?.updated,
      chat?.updated_at,
      created,
    );
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

    const overflow = ordered.slice(MAX_STORED_CHATS);
    await Promise.allSettled(overflow.map((chat) => original.deleteChat(chat.id)));
    return ordered.slice(0, MAX_STORED_CHATS);
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

  Storage.upsertServerChat = async function upsertServerChatWithCanonicalUserActivity(chatData) {
    const result = await original.upsertServerChat(chatData);
    if (!result?.id) return result;

    const canonicalActivity = firstValidTimestamp(
      chatData?.last_activity_at,
      chatData?.lastActivityAt,
      chatData?.created,
      chatData?.created_at,
      result?.created,
      result?.created_at,
    );
    if (!canonicalActivity) return result;

    await restoreActivity(
      result.id,
      canonicalActivity,
      firstValidTimestamp(chatData?.last_message_at, chatData?.lastMessageAt, result?.last_message_at),
    );
    return original.getChat(result.id);
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
    await restoreActivity(chatId, activity, lastMessageAt);
    return original.getChat(chatId);
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
}
