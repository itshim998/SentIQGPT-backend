// ================================================================
// Conversation activity — special modes
// ================================================================
// Normal chat/image requests already persist a user-authored message. Deep
// Research historically persisted only its research artifact on the server, and
// SentIQ Live creates/commits through separate endpoints. This adapter keeps the
// universal history contract intact without teaching the sidebar about tools:
// every mode that represents a user query must leave authoritative user activity
// before/when it persists its work.

const Storage = window.SentIQStorage;
const RETENTION_CLEANUP_CODE = "conversation_retention_cleanup_required";
let installed = false;

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRemoteByUserActivity(left, right) {
  const rightActivity = timestampMs(right?.last_activity_at || right?.lastActivityAt || right?.created_at || right?.created);
  const leftActivity = timestampMs(left?.last_activity_at || left?.lastActivityAt || left?.created_at || left?.created);
  if (rightActivity !== leftActivity) return rightActivity - leftActivity;

  const rightCreated = timestampMs(right?.created_at || right?.created);
  const leftCreated = timestampMs(left?.created_at || left?.created);
  if (rightCreated !== leftCreated) return rightCreated - leftCreated;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

async function deleteExactRemoteBottom(API) {
  const response = await API.getConversations();
  const conversations = (Array.isArray(response?.conversations) ? response.conversations : [])
    .filter((chat) => chat?.id)
    .sort(compareRemoteByUserActivity);
  if (conversations.length < 50) return;

  const bottom = conversations[conversations.length - 1];
  try {
    // Always use the product DELETE route. It removes generated image/file
    // objects before the relational conversation row, preserving the no-traces
    // retention contract.
    await API.deleteConversation(bottom.id);
  } catch (error) {
    if (Number(error?.status) !== 404) throw error;
  }
  await Storage?.deleteChat?.(bottom.id).catch(() => null);
}

async function retryOnceAfterRetentionCleanup(operation, API) {
  try {
    return await operation();
  } catch (error) {
    if (String(error?.code || "") !== RETENTION_CLEANUP_CODE) throw error;
    // The database aborts the original 51st insert when the exact bottom chat
    // owns external artifacts, so cleanup here cannot delete a chat for a failed
    // insert that already committed. Remove the exact bottom, then retry once.
    await deleteExactRemoteBottom(API);
    return operation();
  }
}

async function reconcileRemoteConversationCache(API) {
  if (!Storage?.getAllChats || !Storage?.upsertServerChat) return;
  const response = await API.getConversations();
  const remote = Array.isArray(response?.conversations) ? response.conversations : [];
  const remoteIds = new Set(remote.map((chat) => String(chat?.id || "").trim()).filter(Boolean));

  for (const chat of remote) {
    if (!chat?.id) continue;
    await Storage.upsertServerChat({
      id: chat.id,
      title: chat.title || "New Chat",
      created_at: chat.created_at,
      last_activity_at: chat.last_activity_at,
      last_message_at: chat.last_message_at,
      message_count: chat.message_count,
      first_user_message: chat.first_user_message,
      source: "server",
      pending_server_sync: false,
    });
  }

  for (const local of await Storage.getAllChats()) {
    if (local?.source !== "server" || local?.pending_server_sync) continue;
    const id = String(local?.id || "").trim();
    if (id && !remoteIds.has(id)) {
      await Storage.deleteChat(id);
    }
  }
}

async function persistDeepResearchUserTurn(API, input, context = {}) {
  const prompt = String(input || "").trim();
  const conversationId = String(context?.conversationId || context?.conversation_id || "").trim();
  if (!prompt || !conversationId || typeof API.syncChatMessages !== "function") return;

  const localChat = await Storage?.getChat?.(conversationId).catch(() => null);
  const clientRequestId = String(context?.clientRequestId || context?.client_request_id || "").trim();
  await retryOnceAfterRetentionCleanup(
    () => API.syncChatMessages({
      conversationId,
      title: localChat?.title || "New Chat",
      ...(clientRequestId ? { clientRequestId } : {}),
      messages: [{
        role: "user",
        content: prompt,
        ...(clientRequestId ? { clientRequestId } : {}),
      }],
    }),
    API,
  );
}

function installSpecialModeActivity() {
  if (installed) return true;
  const API = window.SentIQAPI;
  if (!API) return false;

  if (typeof API.startDeepResearch === "function") {
    const originalStartDeepResearch = API.startDeepResearch.bind(API);
    API.startDeepResearch = async function startDeepResearchWithUserActivity(input, context = {}) {
      await persistDeepResearchUserTurn(API, input, context);
      const result = await retryOnceAfterRetentionCleanup(
        () => originalStartDeepResearch(input, context),
        API,
      );
      await reconcileRemoteConversationCache(API).catch(() => null);
      return result;
    };
  }

  if (typeof API.sendDeepResearchStream === "function") {
    const originalSendDeepResearchStream = API.sendDeepResearchStream.bind(API);
    API.sendDeepResearchStream = async function sendDeepResearchStreamWithUserActivity(input, context = {}, callbacks = {}, signal = null) {
      await persistDeepResearchUserTurn(API, input, context);
      const result = await retryOnceAfterRetentionCleanup(
        () => originalSendDeepResearchStream(input, context, callbacks, signal),
        API,
      );
      await reconcileRemoteConversationCache(API).catch(() => null);
      return result;
    };
  }

  if (typeof API.createLiveSessionToken === "function") {
    const originalCreateLiveSessionToken = API.createLiveSessionToken.bind(API);
    API.createLiveSessionToken = async function createLiveSessionTokenWithRetention(conversationId) {
      const result = await retryOnceAfterRetentionCleanup(
        () => originalCreateLiveSessionToken(conversationId),
        API,
      );
      // A brand-new Live conversation can be the 51st persisted conversation.
      // Reconcile immediately so an atomically evicted bottom row disappears from
      // the sidebar/cache rather than surviving until a later refresh.
      await reconcileRemoteConversationCache(API).catch(() => null);
      return result;
    };
  }

  installed = true;
  Object.defineProperty(API, "__conversationSpecialModeActivityInstalled", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return true;
}

(function scheduleInstall(attempt = 0) {
  if (installSpecialModeActivity()) return;
  if (attempt >= 30) return;
  setTimeout(() => scheduleInstall(attempt + 1), 0);
})();
