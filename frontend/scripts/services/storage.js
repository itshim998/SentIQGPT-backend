// ================================================================
// 1. Storage Manager — IndexedDB
// ================================================================
const DB_NAME = "SentIQGPT";
const DB_VERSION = 3;

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
};

let dbInstance = null;
let dbOpenPromise = null;

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
      }
      if (!db.objectStoreNames.contains(STORES.memories)) {
        const memStore = db.createObjectStore(STORES.memories, { keyPath: "id" });
        memStore.createIndex("type", "type", { unique: false });
        memStore.createIndex("timestamp", "timestamp", { unique: false });
        memStore.createIndex("importance", "importance", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.files)) {
        const fileStore = db.createObjectStore(STORES.files, { keyPath: "id" });
        fileStore.createIndex("timestamp", "timestamp", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.generatedFiles)) {
        const generatedFileStore = db.createObjectStore(STORES.generatedFiles, { keyPath: "id" });
        generatedFileStore.createIndex("chat_id", "chat_id", { unique: false });
        generatedFileStore.createIndex("storage_path", "storage_path", { unique: false });
        generatedFileStore.createIndex("created_at", "created_at", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.config)) {
        db.createObjectStore(STORES.config, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORES.syncQueue)) {
        const syncStore = db.createObjectStore(STORES.syncQueue, { keyPath: "id" });
        syncStore.createIndex("type", "type", { unique: false });
        syncStore.createIndex("status", "status", { unique: false });
        syncStore.createIndex("next_retry_at", "next_retry_at", { unique: false });
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
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

async function getChat(id) { return dbGet(STORES.chats, id); }

async function getAllChats() {
  const chats = await dbGetAll(STORES.chats);
  return chats.sort((a, b) => new Date(b.updated) - new Date(a.updated));
}

async function getLocalChats() {
  const chats = await getAllChats();
  return chats.filter((chat) => chat.source !== "server");
}

async function addMessageToChat(chatId, role, content, meta) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const msg = { id: generateId(), role, content, timestamp: new Date().toISOString() };
  if (meta) msg.meta = meta;
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

async function upsertServerChat(chatData) {
  const existing = await getChat(chatData.id);
  const incomingTitle = chatData.title || "";
  const shouldKeepPendingLocalTitle = Boolean(
    existing?.pending_title_sync
    && typeof existing?.title === "string"
    && existing.title.trim()
    && incomingTitle
    && incomingTitle !== existing.title,
  );
  const titleWasSynced = Boolean(
    existing?.pending_title_sync
    && incomingTitle
    && incomingTitle === existing?.title,
  );
  const chat = {
    id: chatData.id,
    title: shouldKeepPendingLocalTitle
      ? existing.title
      : (incomingTitle || existing?.title || "New Chat"),
    messages: existing?.messages || [],
    created: chatData.created || chatData.created_at || existing?.created || new Date().toISOString(),
    updated: chatData.updated || chatData.updated_at || chatData.created_at || existing?.updated || new Date().toISOString(),
    source: "server",
    pending_server_sync: Boolean(chatData.pending_server_sync),
    sync_error: chatData.sync_error || null,
    last_synced_at: chatData.last_synced_at || existing?.last_synced_at || null,
    pending_title_sync: shouldKeepPendingLocalTitle
      ? true
      : Boolean(chatData.pending_title_sync || (existing?.pending_title_sync && !titleWasSynced)),
    title_sync_error: shouldKeepPendingLocalTitle ? (existing?.title_sync_error || null) : (chatData.title_sync_error || null),
    last_title_synced_at: titleWasSynced
      ? (chatData.last_title_synced_at || new Date().toISOString())
      : (chatData.last_title_synced_at || existing?.last_title_synced_at || null),
  };
  await dbPut(STORES.chats, chat);
  return chat;
}

async function replaceChatMessages(chatId, messages) {
  const chat = await getChat(chatId);
  if (!chat) throw new Error("Chat not found");
  const normalizedMessages = collapseAdjacentDuplicateChatMessages(messages.map((message) => ({
    id: message.id || generateId(),
    role: message.role,
    content: message.content || "",
    timestamp: message.timestamp || message.created_at || new Date().toISOString(),
    ...(message.meta ? { meta: message.meta } : {}),
  })));
  chat.messages = normalizedMessages;
  chat.updated = chat.messages.length > 0
    ? chat.messages[chat.messages.length - 1].timestamp
    : (chat.updated || new Date().toISOString());
  await dbPut(STORES.chats, chat);
  return chat;
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
    timestamp: memory.timestamp || memory.created_at || existing?.timestamp || new Date().toISOString(),
    source_message_id: memory.source_message_id || existing?.source_message_id || null,
    scope,
    chat_id: chatId,
    source: memory.source || existing?.source || "local",
    persisted: Object.prototype.hasOwnProperty.call(memory, "persisted")
      ? Boolean(memory.persisted)
      : Boolean(existing?.persisted || memory.source === "server"),
    source_conversation_id: memory.source_conversation_id || existing?.source_conversation_id || null,
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
  return memories.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function getMemory(id) { return dbGet(STORES.memories, id); }

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
  return jobs.sort((a, b) => new Date(a.next_retry_at || a.created_at) - new Date(b.next_retry_at || b.created_at));
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
    timestamp: new Date().toISOString(),
  };
  await dbPut(STORES.files, item);
  return item;
}

async function getAllFiles() { return dbGetAll(STORES.files); }
async function getFile(id) { return dbGet(STORES.files, id); }
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

async function getGeneratedFile(id) { return dbGet(STORES.generatedFiles, id); }
async function deleteGeneratedFile(id) { return dbDelete(STORES.generatedFiles, id); }

async function getConfig(key) {
  const item = await dbGet(STORES.config, key);
  return item ? item.value : DEFAULT_LIMITS[key] ?? null;
}

async function setConfig(key, value) {
  return dbPut(STORES.config, { key, value });
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
  const count = await dbCount(storeName);
  if (count >= limit) {
    const all = await dbGetAll(storeName);
    const sorted = all.sort((a, b) => new Date(a.updated || a.timestamp) - new Date(b.updated || b.timestamp));
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
  createChat, getChat, getAllChats, addMessageToChat, updateChatTitle, deleteChat,
  getLocalChats, upsertServerChat, replaceChatMessages,
  storeMemory, getMemory, getAllMemories, getMemoriesByType, deleteMemory, getTopMemories,
  storeFile, getAllFiles, getFile, deleteFile,
  storeGeneratedFile, getGeneratedFile, deleteGeneratedFile,
  putSyncJob, getAllSyncJobs, deleteSyncJob,
  getConfig, setConfig, getAllConfig,
  getStorageStats, generateId,
  normalizeMemoryScope, normalizeMemoryChatId,
  collapseAdjacentDuplicateChatMessages,
};
