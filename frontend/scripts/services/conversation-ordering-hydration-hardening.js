// ================================================================
// Conversation ordering — hydration hardening
// ================================================================
// The main ordering policy stores a canonical user-activity shadow. This small
// final wrapper closes the remaining legacy-cache edge case: a user can click an
// old, already-cached conversation before the first cloud list refresh finishes.
// In that case the old IndexedDB row may still contain a polluted assistant-time
// `last_activity_at`. Once the full message history is hydrated, the message list
// itself is authoritative, so recompute activity from USER messages only.

const Storage = window.SentIQStorage;

if (Storage && !Storage.__conversationOrderingHydrationHardeningInstalled) {
  const innerMergeChatMessages = Storage.mergeChatMessages.bind(Storage);
  const innerUpsertServerChat = Storage.upsertServerChat.bind(Storage);

  function timestampMs(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : null;
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

  function exactUserActivity(chat) {
    const created = chat?.created || chat?.created_at || "";
    let latestUser = "";
    for (const message of Array.isArray(chat?.messages) ? chat.messages : []) {
      if (message?.role !== "user") continue;
      latestUser = newestTimestamp(latestUser, message?.timestamp, message?.created_at);
    }
    return newestTimestamp(created, latestUser);
  }

  function hasUserMessages(chat) {
    return Array.isArray(chat?.messages) && chat.messages.some((message) => message?.role === "user");
  }

  async function forceExactHydratedActivity(chat) {
    if (!chat?.id || !hasUserMessages(chat)) return chat;
    const activity = exactUserActivity(chat);
    if (!activity) return chat;
    return Storage.updateChatSyncState(chat.id, {
      updated: activity,
      ...(chat.source === "server" ? { last_activity_at: activity } : {}),
    });
  }

  Storage.mergeChatMessages = async function mergeChatMessagesWithExactHydratedActivity(chatId, messages, options = {}) {
    const result = await innerMergeChatMessages(chatId, messages, options);
    return forceExactHydratedActivity(result);
  };

  Storage.replaceChatMessages = async function replaceChatMessagesWithExactHydratedActivity(chatId, messages) {
    return Storage.mergeChatMessages(chatId, messages, { replaceExisting: true });
  };

  Storage.upsertServerChat = async function upsertServerChatWithoutLocalActivityRegression(chatData) {
    const result = await innerUpsertServerChat(chatData);
    if (!result) return result;

    // Server list responses include canonical last_activity_at and therefore the
    // main policy already owns them. For local/pending upserts without that field,
    // do not let a legacy metadata merge overwrite activity derived from messages.
    const hasCanonicalServerActivity = timestampMs(chatData?.last_activity_at || chatData?.lastActivityAt) !== null;
    if (!hasCanonicalServerActivity && hasUserMessages(result)) {
      return forceExactHydratedActivity(result);
    }
    return result;
  };

  Object.defineProperty(Storage, "__conversationOrderingHydrationHardeningInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
