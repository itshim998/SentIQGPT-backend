// ================================================================
// Conversation creation persistence
// ================================================================
// Product contract: creating a chat counts as conversation activity immediately,
// even before the first typed message. Authenticated "New Chat" rows therefore
// must be persisted at creation time so the 50-chat limit is enforced on CREATE,
// not deferred until the first later message.

const Storage = window.SentIQStorage;
const API = window.SentIQAPI;

if (Storage && API && !Storage.__conversationCreationPersistenceInstalled) {
  const innerUpsertServerChat = Storage.upsertServerChat.bind(Storage);
  const pendingCreates = new Map();

  function isBlankPendingServerChat(chatData, storedChat) {
    if (!storedChat?.id || storedChat.source !== "server") return false;
    if (!storedChat.pending_server_sync) return false;

    const explicitMessages = Array.isArray(chatData?.messages) ? chatData.messages : [];
    const storedMessages = Array.isArray(storedChat?.messages) ? storedChat.messages : [];
    if (explicitMessages.length > 0 || storedMessages.length > 0) return false;

    const messageCount = Number(chatData?.message_count ?? storedChat?.message_count ?? 0);
    if (Number.isFinite(messageCount) && messageCount > 0) return false;
    if (String(chatData?.first_user_message || storedChat?.first_user_message || "").trim()) return false;
    return true;
  }

  async function persistCreatedConversation(chat) {
    const chatId = String(chat?.id || "").trim();
    if (!chatId) return chat;
    if (pendingCreates.has(chatId)) return pendingCreates.get(chatId);

    const task = (async () => {
      try {
        // createConversation is already wrapped by the main retention policy.
        // On the 51st persisted chat it either succeeds with atomic DB eviction,
        // or follows the safe artifact-cleanup 409 -> exact-bottom DELETE ->
        // one-retry path before resolving.
        await API.createConversation(chat?.title || "New Chat", chatId);
        const confirmed = await Storage.updateChatSyncState(chatId, {
          pending_server_sync: false,
          sync_error: null,
        });
        await Storage.getAllChats();
        return confirmed || chat;
      } catch (error) {
        // Do not pre-delete an old conversation when creation itself failed.
        // Keep the local draft pending; the existing first-message/sync recovery
        // paths can persist the same stable conversation ID later.
        await Storage.updateChatSyncState(chatId, {
          pending_server_sync: true,
          sync_error: error instanceof Error ? error.message : "Conversation could not be saved yet.",
        }).catch(() => null);
        return Storage.getChat(chatId).catch(() => chat);
      } finally {
        pendingCreates.delete(chatId);
      }
    })();

    pendingCreates.set(chatId, task);
    return task;
  }

  Storage.upsertServerChat = async function upsertServerChatAndPersistCreation(chatData) {
    const stored = await innerUpsertServerChat(chatData);
    if (!isBlankPendingServerChat(chatData, stored)) return stored;
    return persistCreatedConversation(stored);
  };

  Object.defineProperty(Storage, "__conversationCreationPersistenceInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}
