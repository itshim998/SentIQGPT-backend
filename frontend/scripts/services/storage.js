// ================================================================
// 1. Storage Manager — IndexedDB
// ================================================================
const DB_NAME = "SentIQGPT";
const DB_VERSION = 5;

const STORES = {
  chats: "chats",
  memories: "memories",
  files: "files",
  generatedFiles: "generated_files",
  config: "config",
  syncQueue: "sync_queue",
};

const DEFAULT_LIMITS = {
  chat_limit: 100,
  memory_limit: 500,
  file_storage_mb: 100,
  message_window: 20,
  execution_mode: "fast",
};

let dbInstance = null;
let dbOpenPromise = null;
let activeCacheUserId = "";

function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbOpenPromise) return dbOpenPromise;

  dbOpenPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORES.chats)) {
        const chatStore = db.createObjectStore(STORES.chats, { keyPath: "id" });
        chatStore.createIndex("updated", "updated", { unique: false });
        chatStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
      } else {
        const chatStore = event.target.transaction.objectStore(STORES.chats);
        if (!chatStore.indexNames.contains("owner_user_id")) {
          chatStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORES.memories)) {
        const memStore = db.createObjectStore(STORES.memories, { keyPath: "id" });
        memStore.createIndex("type", "type", { unique: false });
        memStore.createIndex("timestamp", "timestamp", { unique: false });
        memStore.createIndex("importance", "importance", { unique: false });
        memStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
      } else {
        const memStore = event.target.transaction.objectStore(STORES.memories);
        if (!memStore.indexNames.contains("owner_user_id")) {
          memStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORES.files)) {
        const fileStore = db.createObjectStore(STORES.files, { keyPath: "id" });
        fileStore.createIndex("timestamp", "timestamp", { unique: false });
        fileStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
      } else {
        const fileStore = event.target.transaction.objectStore(STORES.files);
        if (!fileStore.indexNames.contains("owner_user_id")) {
          fileStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORES.generatedFiles)) {
        const generatedFileStore = db.createObjectStore(STORES.generatedFiles, { keyPath: "id" });
        generatedFileStore.createIndex("chat_id", "chat_id", { unique: false });
        generatedFileStore.createIndex("storage_path", "storage_path", { unique: false });
        generatedFileStore.createIndex("created_at", "created_at", { unique: false });
        generatedFileStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
      } else {
        const generatedFileStore = event.target.transaction.objectStore(STORES.generatedFiles);
        if (!generatedFileStore.indexNames.contains("owner_user_id")) {
          generatedFileStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(STORES.config)) {
        db.createObjectStore(STORES.config, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORES.syncQueue)) {
        const syncStore = db.createObjectStore(STORES.syncQueue, { keyPath: "id" });
        syncStore.createIndex("type", "type", { unique: false });
        syncStore.createIndex("status", "status", { unique: false });
        syncStore.createIndex("next_retry_at", "next_retry_at", { unique: false });
        syncStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
      } else {
        const syncStore = event.target.transaction.objectStore(STORES.syncQueue);
        if (!syncStore.indexNames.contains("owner_user_id")) {
          syncStore.createIndex("owner_user_id", "owner_user_id", { unique: false });
        }
      }
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
        dbOpenPromise = null;
      };
      resolve(dbInstance);
    };
    request.onerror = () => {
      dbOpenPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      dbOpenPromise = null;
      reject(new Error("SentIQGPT storage is blocked by another open tab. Close other tabs and retry."));
    };
  });
  return dbOpenPromise;
}

async function dbPut(storeName, item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.put(item);
    let requestResult;
    req.onsuccess = () => { requestResult = req.result; };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(requestResult);
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error(`IndexedDB ${storeName} write transaction aborted`));
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || req.error);
    tx.onabort = () => reject(tx.error || new Error(`IndexedDB ${storeName} delete transaction aborted`));
  });
}

async function dbCount(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function normalizeCacheUserId(value) {
  return String(value || "").trim();
}

function setActiveUserId(userId) {
  activeCacheUserId = normalizeCacheUserId(userId);
}

function getActiveUserId() {
  return activeCacheUserId;
}

function getConversationAliasConfigKey() {
  return `conversation_aliases:${activeCacheUserId || "guest"}`;
}

function isServerScopedItemVisible(item) {
  if (!item || item.source !== "server") return true;
  if (!activeCacheUserId) return false;
  return item.owner_user_id === activeCacheUserId;
}

function isOwnedCacheItemVisible(item) {
  if (!activeCacheUserId) return !item?.owner_user_id;
  return item?.owner_user_id === activeCacheUserId;
}

function sanitizeMessageMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const nextMeta = { ...meta };
  if (nextMeta.type === "image") {
    if (/^data:image\//i.test(String(nextMeta.imageUrl || nextMeta.image_url || ""))) {
      delete nextMeta.imageUrl;
      delete nextMeta.image_url;
    }
    delete nextMeta.imageBase64;
    delete nextMeta.image_base64;
    delete nextMeta.base64;
    delete nextMeta.imageData;
    delete nextMeta.image_data;
    delete nextMeta.blob;
  }
  return nextMeta;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    ...(message.meta ? { meta: sanitizeMessageMeta(message.meta) } : {}),
  };
}

function normalizeComparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericChatTitle(title) {
  const normalized = normalizeComparableText(title);
  return !normalized || normalized === "new chat" || normalized === "untitled chat" || normalized === "untitled conversation";
}

function isFirstMessageFallbackTitle(title, firstUserMessage) {
  const normalizedTitle = normalizeComparableText(title);
  const normalizedFirstUserMessage = normalizeComparableText(firstUserMessage);
  if (!normalizedTitle || !normalizedFirstUserMessage || isGenericChatTitle(normalizedTitle)) return false;
  if (normalizedTitle.length < 8) return false;
  return normalizedFirstUserMessage.startsWith(normalizedTitle)
    || normalizedTitle.startsWith(normalizedFirstUserMessage.slice(0, Math.min(normalizedFirstUserMessage.length, normalizedTitle.length)));
}

function getClientRequestId(message) {
  return message?.clientRequestId
    || message?.client_request_id
    || message?.clientRequestID
    || message?.meta?.clientRequestId
    || message?.meta?.client_request_id
    || "";
}

function normalizeStoredMessage(message) {
  const safeMessage = sanitizeMessage(message || {});
  const clientRequestId = getClientRequestId(safeMessage);
  const normalized = {
    id: typeof safeMessage?.id === "string" && safeMessage.id.trim() ? safeMessage.id.trim() : generateId(),
    role: safeMessage?.role === "assistant" ? "assistant" : "user",
    content: typeof safeMessage?.content === "string" ? safeMessage.content : "",
    timestamp: safeMessage?.timestamp || safeMessage?.created_at || new Date().toISOString(),
    ...(safeMessage?.meta ? { meta: safeMessage.meta } : {}),
  };
  if (clientRequestId) normalized.clientRequestId = String(clientRequestId);
  return normalized;
}

function getMessageMergeKey(message) {
  const clientRequestId = getClientRequestId(message);
  const messageType = message?.meta?.type || message?.message_type || "text";
  if (clientRequestId) return `request:${message.role}:${messageType}:${clientRequestId}`;
  if (message?.id) return `id:${message.id}`;
  const contentFingerprint = normalizeMessageContentForDedup(message?.content);
  const metaFingerprint = [
    message?.meta?.type || "",
    message?.meta?.imageUrl || message?.meta?.image_url || "",
    message?.meta?.file_id || message?.meta?.generated_file_id || "",
    message?.meta?.storagePath || message?.meta?.storage_path || "",
  ].join(":");
  return `content:${message?.role || "user"}:${contentFingerprint}:${metaFingerprint}`;
}

function mergeStoredMessage(existing, incoming) {
  if (!existing) return incoming;
  const clientRequestId = getClientRequestId(incoming) || getClientRequestId(existing);
  return {
    ...existing,
    ...incoming,
    meta: incoming.meta ? sanitizeMessageMeta(incoming.meta) : existing.meta,
    ...(clientRequestId ? { clientRequestId } : {}),
  };
}

function normalizeMessageContentForDedup(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getMessageTimestampMs(message) {
  const rawTimestamp = message?.timestamp || message?.created_at;
  if (!rawTimestamp) return null;
  const parsed = Date.parse(rawTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function collapseAdjacentDuplicateChatMessages(messages, duplicateWindowMs = 90 * 1000) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const collapsed = [];
  for (const message of messages) {
    if (!message) continue;
    const previous = collapsed[collapsed.length - 1];
    const sameRole = previous?.role === message.role;
    const sameContent = normalizeMessageContentForDedup(previous?.content) === normalizeMessageContentForDedup(message.content);
    const isImage = previous?.meta?.type === "image" || message?.meta?.type === "image";
    if (isImage) {
      collapsed.push(message);
      continue;
    }
    if (previous && sameRole && sameContent) {
      const previousTimestampMs = getMessageTimestampMs(previous);
      const currentTimestampMs = getMessageTimestampMs(message);
      if (
        previousTimestampMs === null ||
        currentTimestampMs === null ||
        Math.abs(currentTimestampMs - previousTimestampMs) <= duplicateWindowMs
      ) {
        continue;
      }
    }
    collapsed.push(message);
  }
  return collapsed;
}

async function createChat(title) {
  const chat = {
    id: generateId(),
    title: title || "New Chat",
    messages: [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    source: "local",
  };
  await enforceLimit(STORES.chats, "chat_limit");
  await dbPut(STORES.chats, chat);
  return chat;
}

async function getChat(id) {
  const chat = await dbGet(STORES.chats, id);
  return isServerScopedItemVisible(chat) ? chat : undefined;
}

async function getAllChats() {
  const chats = await dbGetAll(STORES.chats);
  return chats
    .filter((chat) => isServerScopedItemVisible(chat))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

async function getLocalChats() {
  const chats = await getAllChats();
  return chats.filter((chat) => chat.source !== "server");
}

async function addMessageToChat(chatId, role, content, meta, options = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const clientRequestId = options.clientRequestId || getClientRequestId({ meta });
  const msg = {
    id: options.id || generateId(),
    role,
    content,
    timestamp: options.timestamp || new Date().toISOString(),
    ...(clientRequestId ? { clientRequestId } : {}),
  };
  if (meta) msg.meta = sanitizeMessageMeta(meta);
  chat.messages.push(msg);
  chat.updated = new Date().toISOString();
  if (!chat.title || chat.title === "New Chat") {
    const firstUser = chat.messages.find((m) => m.role === "user");
    if (firstUser) {
      chat.title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
    }
  }
  await dbPut(STORES.chats, chat);
  return chat;
}

async function upsertMessageInChat(chatId, message) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const safeMessage = sanitizeMessage(message);
  const messageId = typeof message?.id === "string" && message.id.trim()
    ? message.id.trim()
    : generateId();
  const existingIndex = chat.messages.findIndex((item) => item.id === messageId);
  const nextMessage = {
    ...(existingIndex >= 0 ? chat.messages[existingIndex] : {}),
    id: messageId,
    role: safeMessage?.role === "assistant" ? "assistant" : "user",
    content: typeof safeMessage?.content === "string" ? safeMessage.content : "",
    timestamp: safeMessage?.timestamp || (existingIndex >= 0 ? chat.messages[existingIndex].timestamp : new Date().toISOString()),
    ...(getClientRequestId(safeMessage) ? { clientRequestId: getClientRequestId(safeMessage) } : {}),
    ...(safeMessage?.meta ? { meta: safeMessage.meta } : {}),
  };
  if (existingIndex >= 0) {
    chat.messages[existingIndex] = nextMessage;
  } else {
    chat.messages.push(nextMessage);
  }
  chat.updated = new Date().toISOString();
  if (!chat.title || chat.title === "New Chat") {
    const firstUser = chat.messages.find((m) => m.role === "user");
    if (firstUser) {
      chat.title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
    }
  }
  await dbPut(STORES.chats, chat);
  return chat;
}

async function updateMessageInChat(chatId, messageId, updates = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const index = chat.messages.findIndex((message) => message.id === messageId);
  if (index < 0) return chat;
  const safeUpdates = sanitizeMessage(updates);
  chat.messages[index] = {
    ...chat.messages[index],
    ...safeUpdates,
    id: messageId,
    ...(safeUpdates.meta ? { meta: sanitizeMessageMeta({ ...(chat.messages[index].meta || {}), ...safeUpdates.meta }) } : {}),
  };
  chat.updated = new Date().toISOString();
  await dbPut(STORES.chats, chat);
  return chat;
}

async function upsertServerChat(chatData) {
  const existing = await dbGet(STORES.chats, chatData.id);
  if (existing && existing.source === "server" && !isServerScopedItemVisible(existing)) {
    await dbDelete(STORES.chats, chatData.id);
  }
  const visibleExisting = existing && isServerScopedItemVisible(existing) ? existing : null;
  const incomingTitle = chatData.title || "";
  const incomingFirstUserMessage = chatData.first_user_message || chatData.firstUserMessage || visibleExisting?.first_user_message || "";
  const shouldKeepPendingLocalTitle = Boolean(
    visibleExisting?.pending_title_sync
    && typeof visibleExisting?.title === "string"
    && visibleExisting.title.trim()
    && incomingTitle
    && incomingTitle !== visibleExisting.title,
  );
  const titleWasSynced = Boolean(
    visibleExisting?.pending_title_sync
    && incomingTitle
    && incomingTitle === visibleExisting?.title,
  );
  const shouldKeepBetterExistingTitle = Boolean(
    visibleExisting?.title
    && incomingTitle
    && visibleExisting.title !== incomingTitle
    && !isGenericChatTitle(visibleExisting.title)
    && (isGenericChatTitle(incomingTitle) || isFirstMessageFallbackTitle(incomingTitle, incomingFirstUserMessage)),
  );
  const chat = {
    id: chatData.id,
    title: (shouldKeepPendingLocalTitle || shouldKeepBetterExistingTitle)
      ? visibleExisting.title
      : (incomingTitle || visibleExisting?.title || "New Chat"),
    messages: visibleExisting?.messages || [],
    created: chatData.created || chatData.created_at || visibleExisting?.created || new Date().toISOString(),
    updated: chatData.updated || chatData.updated_at || chatData.created_at || visibleExisting?.updated || new Date().toISOString(),
    source: "server",
    owner_user_id: normalizeCacheUserId(chatData.owner_user_id || chatData.ownerUserId || activeCacheUserId),
    pending_server_sync: Boolean(chatData.pending_server_sync),
    sync_error: chatData.sync_error || null,
    last_synced_at: chatData.last_synced_at || visibleExisting?.last_synced_at || null,
    warmed_at: chatData.warmed_at || visibleExisting?.warmed_at || null,
    message_cache_status: chatData.message_cache_status || visibleExisting?.message_cache_status || null,
    message_count: Number.isFinite(Number(chatData.message_count)) ? Number(chatData.message_count) : (visibleExisting?.message_count || 0),
    first_user_message: incomingFirstUserMessage || visibleExisting?.first_user_message || null,
    pending_title_sync: shouldKeepPendingLocalTitle
      ? true
      : Boolean(chatData.pending_title_sync || (visibleExisting?.pending_title_sync && !titleWasSynced)),
    title_sync_error: shouldKeepPendingLocalTitle ? (visibleExisting?.title_sync_error || null) : (chatData.title_sync_error || null),
    last_title_synced_at: titleWasSynced
      ? (chatData.last_title_synced_at || new Date().toISOString())
      : (chatData.last_title_synced_at || visibleExisting?.last_title_synced_at || null),
  };
  await dbPut(STORES.chats, chat);
  return chat;
}

async function mergeChatMessages(chatId, messages, options = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const existingMessages = Array.isArray(chat.messages) ? chat.messages.map(normalizeStoredMessage) : [];
  const incomingMessages = Array.isArray(messages) ? messages.map(normalizeStoredMessage) : [];
  if (incomingMessages.length === 0 && existingMessages.length > 0 && !options.allowEmptyRemoteReplace) {
    chat.message_cache_status = "local-preserved";
    chat.warmed_at = new Date().toISOString();
    await dbPut(STORES.chats, chat);
    return chat;
  }

  const mergedByKey = new Map();
  const baseMessages = options.replaceExisting ? [] : existingMessages;
  for (const message of baseMessages) {
    mergedByKey.set(getMessageMergeKey(message), message);
  }
  for (const message of incomingMessages) {
    const key = getMessageMergeKey(message);
    mergedByKey.set(key, mergeStoredMessage(mergedByKey.get(key), message));
  }
  const normalizedMessages = collapseAdjacentDuplicateChatMessages(
    [...mergedByKey.values()].sort((a, b) => {
      const left = getMessageTimestampMs(a) ?? 0;
      const right = getMessageTimestampMs(b) ?? 0;
      if (left !== right) return left - right;
      return String(a.id).localeCompare(String(b.id));
    }),
  );
  chat.messages = normalizedMessages;
  chat.updated = chat.messages.length > 0
    ? chat.messages[chat.messages.length - 1].timestamp
    : (chat.updated || new Date().toISOString());
  chat.message_cache_status = "complete";
  chat.warmed_at = new Date().toISOString();
  chat.message_count = chat.messages.length;
  const firstUserMessage = chat.messages.find((message) => message.role === "user")?.content || "";
  if (firstUserMessage) chat.first_user_message = firstUserMessage;
  await dbPut(STORES.chats, chat);
  return chat;
}

async function replaceChatMessages(chatId, messages) {
  return mergeChatMessages(chatId, messages, { replaceExisting: true });
}

async function deleteChat(id) { return dbDelete(STORES.chats, id); }

async function updateChatTitle(chatId, title, options = {}) {
  const chat = await getChat(chatId);
  if (!chat) return;
  chat.title = title;
  if (options.bumpUpdated) {
    chat.updated = new Date().toISOString();
  }
  if (Object.prototype.hasOwnProperty.call(options, "pendingTitleSync")) {
    chat.pending_title_sync = Boolean(options.pendingTitleSync);
  }
  if (Object.prototype.hasOwnProperty.call(options, "titleSyncError")) {
    chat.title_sync_error = options.titleSyncError || null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "lastTitleSyncedAt")) {
    chat.last_title_synced_at = options.lastTitleSyncedAt || null;
  }
  await dbPut(STORES.chats, chat);
  return chat;
}

export function normalizeMemoryScope(memory) {
  if (memory?.scope === "global" || memory?.scope === "chat") {
    return memory.scope;
  }
  return "global";
}

export function normalizeMemoryChatId(memory, scope) {
  if (scope !== "chat") return null;
  if (typeof memory?.chat_id === "string" && memory.chat_id.trim()) {
    return memory.chat_id.trim();
  }
  return null;
}

async function storeMemory(memory) {
  const scope = normalizeMemoryScope(memory);
  const chatId = normalizeMemoryChatId(memory, scope);
  const memoryId = typeof memory?.id === "string" && memory.id.trim()
    ? memory.id.trim()
    : generateId();
  const existing = await dbGet(STORES.memories, memoryId);
  const item = {
    ...(existing || {}),
    id: memoryId,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance || 5,
    embedding: Array.isArray(memory.embedding) ? memory.embedding : existing?.embedding,
    timestamp: memory.timestamp || memory.created_at || existing?.timestamp || new Date().toISOString(),
    owner_user_id: normalizeCacheUserId(memory.owner_user_id || memory.ownerUserId || existing?.owner_user_id || activeCacheUserId),
    source_message_id: memory.source_message_id || existing?.source_message_id || null,
    scope,
    chat_id: chatId,
    source: memory.source || existing?.source || "local",
    persisted: Object.prototype.hasOwnProperty.call(memory, "persisted")
      ? Boolean(memory.persisted)
      : Boolean(existing?.persisted || memory.source === "server"),
    source_conversation_id: memory.source_conversation_id || existing?.source_conversation_id || null,
    failure_reason: memory.failure_reason || existing?.failure_reason || null,
    pending_server_sync: Boolean(memory.pending_server_sync),
    last_synced_at: memory.last_synced_at || existing?.last_synced_at || null,
    sync_error: memory.sync_error || null,
  };
  await enforceLimit(STORES.memories, "memory_limit");
  await dbPut(STORES.memories, item);
  return item;
}

async function getAllMemories() {
  const memories = await dbGetAll(STORES.memories);
  return memories
    .filter((memory) => isOwnedCacheItemVisible(memory))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function getMemory(id) {
  const memory = await dbGet(STORES.memories, id);
  return isOwnedCacheItemVisible(memory) ? memory : undefined;
}

async function getMemoriesByType(type) {
  const all = await getAllMemories();
  return all.filter((m) => m.type === type);
}

async function deleteMemory(id) { return dbDelete(STORES.memories, id); }

async function putSyncJob(job) {
  const existing = job?.id ? await dbGet(STORES.syncQueue, job.id) : null;
  const item = {
    ...(existing || {}),
    ...job,
    id: job?.id || generateId(),
    owner_user_id: normalizeCacheUserId(job?.owner_user_id || job?.ownerUserId || existing?.owner_user_id || activeCacheUserId),
    status: job?.status || existing?.status || "pending",
    attempt_count: typeof job?.attempt_count === "number" ? job.attempt_count : (existing?.attempt_count || 0),
    next_retry_at: job?.next_retry_at || existing?.next_retry_at || new Date().toISOString(),
    created_at: job?.created_at || existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await dbPut(STORES.syncQueue, item);
  return item;
}

async function getAllSyncJobs() {
  const jobs = await dbGetAll(STORES.syncQueue);
  return jobs
    .filter((job) => isOwnedCacheItemVisible(job))
    .sort((a, b) => new Date(a.next_retry_at || a.created_at) - new Date(b.next_retry_at || b.created_at));
}

async function deleteSyncJob(id) { return dbDelete(STORES.syncQueue, id); }

async function getTopMemories(limit, chatId = null) {
  const all = await getAllMemories();
  return all
    .filter((memory) => {
      const scope = normalizeMemoryScope(memory);
      return scope === "global" || (scope === "chat" && !!chatId && memory.chat_id === chatId);
    })
    .sort((a, b) => b.importance - a.importance || new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit || 20);
}

async function storeFile(fileData) {
  const item = {
    id: generateId(),
    filename: fileData.filename,
    type: fileData.type,
    extracted_text: fileData.extracted_text || "",
    blob: fileData.blob || null,
    size_bytes: fileData.size_bytes || 0,
    owner_user_id: normalizeCacheUserId(fileData.owner_user_id || fileData.ownerUserId || activeCacheUserId),
    timestamp: new Date().toISOString(),
  };
  await dbPut(STORES.files, item);
  return item;
}

async function getAllFiles() {
  const files = await dbGetAll(STORES.files);
  return files.filter((file) => isOwnedCacheItemVisible(file));
}
async function getFile(id) {
  const file = await dbGet(STORES.files, id);
  return isOwnedCacheItemVisible(file) ? file : undefined;
}
async function deleteFile(id) { return dbDelete(STORES.files, id); }

function normalizeGeneratedFileCacheId(fileData) {
  return String(
    fileData?.id ||
    fileData?.file_id ||
    fileData?.storage_path ||
    fileData?.storagePath ||
    fileData?.file_url ||
    fileData?.fileUrl ||
    generateId()
  );
}

async function storeGeneratedFile(fileData) {
  const id = normalizeGeneratedFileCacheId(fileData);
  const item = {
    ...(fileData || {}),
    id,
    owner_user_id: normalizeCacheUserId(fileData?.owner_user_id || fileData?.ownerUserId || activeCacheUserId),
    file_id: fileData?.file_id || fileData?.fileId || id,
    file_name: fileData?.file_name || fileData?.fileName || `doc.${fileData?.format || "txt"}`,
    mime_type: fileData?.mime_type || fileData?.mimeType || "application/octet-stream",
    storage_path: fileData?.storage_path || fileData?.storagePath || "",
    storage_bucket: fileData?.storage_bucket || fileData?.storageBucket || "",
    file_url: fileData?.file_url || fileData?.fileUrl || "",
    chat_id: fileData?.chat_id || fileData?.chatId || null,
    preview: fileData?.preview || null,
    version: fileData?.version || 1,
    content_sha256: fileData?.content_sha256 || fileData?.contentSha256 || "",
    created_at: fileData?.created_at || fileData?.createdAt || new Date().toISOString(),
    updated_at: fileData?.updated_at || fileData?.updatedAt || null,
  };
  await dbPut(STORES.generatedFiles, item);
  return item;
}

async function getGeneratedFile(id) {
  const item = await dbGet(STORES.generatedFiles, id);
  return isOwnedCacheItemVisible(item) ? item : undefined;
}
async function getAllGeneratedFiles() {
  const files = await dbGetAll(STORES.generatedFiles);
  return files.filter((file) => isOwnedCacheItemVisible(file));
}
async function deleteGeneratedFile(id) { return dbDelete(STORES.generatedFiles, id); }

async function getConfig(key) {
  const item = await dbGet(STORES.config, key);
  return item ? item.value : DEFAULT_LIMITS[key] ?? null;
}

async function setConfig(key, value) {
  return dbPut(STORES.config, { key, value });
}

async function getConversationAliases() {
  const aliases = await getConfig(getConversationAliasConfigKey());
  return aliases && typeof aliases === "object" ? aliases : {};
}

async function setConversationAlias(fromChatId, toChatId) {
  const from = String(fromChatId || "").trim();
  const to = String(toChatId || "").trim();
  if (!from || !to || from === to) return null;
  const aliases = await getConversationAliases();
  aliases[from] = to;
  await setConfig(getConversationAliasConfigKey(), aliases);
  return aliases;
}

async function resolveConversationAlias(chatId) {
  let current = String(chatId || "").trim();
  if (!current) return "";
  const aliases = await getConversationAliases();
  const seen = new Set();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current];
  }
  return current;
}

async function getAllConfig() {
  const items = await dbGetAll(STORES.config);
  const config = { ...DEFAULT_LIMITS };
  for (const item of items) config[item.key] = item.value;
  return config;
}

async function enforceLimit(storeName, limitKey) {
  const limit = await getConfig(limitKey);
  if (!limit) return;
  const all = await dbGetAll(storeName);
  const scopedStores = new Set([STORES.memories, STORES.files]);
  const candidates = scopedStores.has(storeName)
    ? all.filter((item) => isOwnedCacheItemVisible(item))
    : all;
  const count = candidates.length;
  if (count >= limit) {
    const sorted = candidates.sort((a, b) => new Date(a.updated || a.timestamp) - new Date(b.updated || b.timestamp));
    const toDelete = sorted.slice(0, count - limit + 1);
    for (const item of toDelete) await dbDelete(storeName, item.id);
  }
}

async function getStorageStats() {
  const chatCount = await dbCount(STORES.chats);
  const memoryCount = await dbCount(STORES.memories);
  const fileCount = await dbCount(STORES.files);
  const config = await getAllConfig();
  return {
    chats: { count: chatCount, limit: config.chat_limit },
    memories: { count: memoryCount, limit: config.memory_limit },
    files: { count: fileCount, limit_mb: config.file_storage_mb },
  };
}

window.SentIQStorage = {
  setActiveUserId, getActiveUserId,
  createChat, getChat, getAllChats, addMessageToChat, upsertMessageInChat, updateMessageInChat, updateChatTitle, deleteChat,
  getLocalChats, upsertServerChat, replaceChatMessages, mergeChatMessages,
  storeMemory, getMemory, getAllMemories, getMemoriesByType, deleteMemory, getTopMemories,
  storeFile, getAllFiles, getFile, deleteFile,
  storeGeneratedFile, getGeneratedFile, getAllGeneratedFiles, deleteGeneratedFile,
  putSyncJob, getAllSyncJobs, deleteSyncJob,
  getConfig, setConfig, getAllConfig,
  getConversationAliases, setConversationAlias, resolveConversationAlias,
  getStorageStats, generateId,
  normalizeMemoryScope, normalizeMemoryChatId,
  collapseAdjacentDuplicateChatMessages,
};
