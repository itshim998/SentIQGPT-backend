// ================================================================
// 1. Storage Manager — IndexedDB
// ================================================================
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME, STORAGE_NAMESPACE } from "../shared/brand.js";

// Keep the legacy IndexedDB name hidden for compatibility with existing local data.
const DB_NAME = LEGACY_PRODUCT_NAME;
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
let storageMode = "persistent";
let volatileReason = "";
const volatileStores = new Map(Object.values(STORES).map((storeName) => [storeName, new Map()]));

function switchToVolatileStorage(error) {
  storageMode = "volatile";
  volatileReason = String(error?.message || error || "Persistent browser storage is unavailable.");
  if (dbInstance) dbInstance.close();
  dbInstance = null;
  dbOpenPromise = null;
  window.SentIQBootstrap?.addLimitedReason?.(
    "indexed-db",
    "Browser storage is unavailable. Data won't be kept after this session."
  );
}

function getVolatileStore(storeName) {
  if (!volatileStores.has(storeName)) volatileStores.set(storeName, new Map());
  return volatileStores.get(storeName);
}

function openDB() {
  if (storageMode === "volatile") return Promise.resolve(null);
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbOpenPromise) return dbOpenPromise;
  if (typeof indexedDB === "undefined") {
    switchToVolatileStorage(new Error("IndexedDB is unavailable."));
    return Promise.resolve(null);
  }

  dbOpenPromise = new Promise((resolve) => {
    let request;
    let settled = false;
    const useVolatileStorage = (error) => {
      if (settled) return;
      settled = true;
      switchToVolatileStorage(error);
      resolve(null);
    };
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      useVolatileStorage(error);
      return;
    }
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
      if (settled || storageMode === "volatile") {
        request.result.close();
        return;
      }
      settled = true;
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance.close();
        dbInstance = null;
        dbOpenPromise = null;
      };
      resolve(dbInstance);
    };
    request.onerror = () => {
      useVolatileStorage(request.error);
    };
    request.onblocked = () => {
      useVolatileStorage(new Error("Storage is blocked by another open tab."));
    };
  });
  return dbOpenPromise;
}

async function dbPut(storeName, item) {
  const db = await openDB();
  if (!db) {
    getVolatileStore(storeName).set(item.id ?? item.key, item);
    return item.id ?? item.key;
  }
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
  if (!db) return getVolatileStore(storeName).get(key);
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
  if (!db) return Array.from(getVolatileStore(storeName).values());
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
  if (!db) {
    getVolatileStore(storeName).delete(key);
    return;
  }
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
  if (!db) return getVolatileStore(storeName).size;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function generateId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
    window.SentIQBootstrap?.addLimitedReason?.(
      "secure-random",
      "Secure IDs are unavailable in this browser. Avoid sensitive work in this session."
    );
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function getStorageStatus() {
  return {
    mode: storageMode,
    persistent: storageMode === "persistent",
    reason: volatileReason,
  };
}

function clearSentIqWebStorage(storageName) {
  try {
    const storage = window[storageName];
    if (!storage) return;
    const keysToRemove = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(`${STORAGE_NAMESPACE}:`) ||
        key?.startsWith("sentiq_") ||
        key?.startsWith("sentiq:")
      ) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => storage.removeItem(key));
  } catch {
    window.SentIQBootstrap?.addLimitedReason?.(
      "web-storage",
      "Some preferences couldn't be cleared. Browser storage is blocked."
    );
  }
}

async function clearLocalData() {
  Object.values(STORES).forEach((storeName) => getVolatileStore(storeName).clear());
  const db = await openDB();
  if (db) {
    const storeNames = Object.values(STORES).filter((storeName) => db.objectStoreNames.contains(storeName));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      storeNames.forEach((storeName) => tx.objectStore(storeName).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Clearing local data was interrupted."));
    });
  }
  clearSentIqWebStorage("localStorage");
  clearSentIqWebStorage("sessionStorage");
  return getStorageStatus();
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

function getTimestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFirstValidTimestamp(...values) {
  for (const value of values) {
    if (getTimestampMs(value) !== null) return value;
  }
  return "";
}

function getNewestTimestampValue(...values) {
  let newestValue = "";
  let newestMs = null;
  for (const value of values) {
    const parsed = getTimestampMs(value);
    if (parsed === null) continue;
    if (newestMs === null || parsed > newestMs) {
      newestMs = parsed;
      newestValue = value;
    }
  }
  return newestValue;
}

function getChatCreatedTimestamp(chat) {
  return getFirstValidTimestamp(chat?.created, chat?.created_at);
}

function getServerChatActivityTimestamp(chat) {
  return getFirstValidTimestamp(
    chat?.last_activity_at,
    chat?.lastActivityAt,
    chat?.last_message_at,
    chat?.lastMessageAt,
    chat?.updated,
    chat?.updated_at,
    chat?.created,
    chat?.created_at,
  );
}

function getChatActivityTimestamp(chat) {
  if (chat?.source === "server") return getServerChatActivityTimestamp(chat);
  return getFirstValidTimestamp(chat?.updated, chat?.updated_at, chat?.timestamp, chat?.created, chat?.created_at);
}

export function compareChatsByActivity(left, right) {
  const rightActivity = getTimestampMs(getChatActivityTimestamp(right)) || 0;
  const leftActivity = getTimestampMs(getChatActivityTimestamp(left)) || 0;
  if (rightActivity !== leftActivity) return rightActivity - leftActivity;

  const rightCreated = getTimestampMs(getChatCreatedTimestamp(right)) || 0;
  const leftCreated = getTimestampMs(getChatCreatedTimestamp(left)) || 0;
  if (rightCreated !== leftCreated) return rightCreated - leftCreated;

  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function touchChatActivity(chat, timestamp = new Date().toISOString()) {
  const activity = getNewestTimestampValue(timestamp, chat?.updated, chat?.created) || timestamp;
  chat.updated = activity;
  if (chat.source === "server") {
    const serverActivity = getNewestTimestampValue(activity, chat.last_activity_at, chat.created) || activity;
    chat.last_activity_at = serverActivity;
    chat.updated = serverActivity;
    chat.last_message_at = getNewestTimestampValue(timestamp, chat.last_message_at) || timestamp;
  }
  return chat;
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

function isTemporaryMessageId(id) {
  if (!id || typeof id !== "string") return true;
  return /^(user-|assistant-|assistant-img-|pending-|local-|temp-)/i.test(id);
}

function resolveCanonicalMessageId(existingId, incomingId) {
  const existingIsTemp = isTemporaryMessageId(existingId);
  const incomingIsTemp = isTemporaryMessageId(incomingId);
  if (existingIsTemp && !incomingIsTemp) return incomingId;
  if (!existingIsTemp && incomingIsTemp) return existingId;
  return incomingId || existingId || generateId();
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
  const messageType = safeMessage?.meta?.type || safeMessage?.message_type || safeMessage?.messageType;
  const imageUrl = safeMessage?.meta?.imageUrl || safeMessage?.meta?.image_url || safeMessage?.image_url || safeMessage?.imageUrl;
  const storagePath = safeMessage?.meta?.storagePath || safeMessage?.meta?.storage_path || safeMessage?.storage_path || safeMessage?.storagePath;
  if ((messageType === "image" || imageUrl) && (!normalized.meta || normalized.meta.type !== "image")) {
    normalized.meta = {
      ...(normalized.meta || {}),
      type: "image",
      ...(imageUrl ? { imageUrl } : {}),
      ...(storagePath ? { storagePath } : {}),
    };
  }
  return normalized;
}

export function getMessageMergeKey(message) {
  const messageType = message?.meta?.type || message?.message_type || "text";
  if (message?.role === "assistant" && (messageType === "image" || message?.meta?.type === "image")) {
    const imageIdentity = message?.meta?.storagePath || message?.meta?.storage_path || message?.meta?.imageUrl || message?.meta?.image_url;
    if (imageIdentity) return `image:${imageIdentity}`;
  }
  const clientRequestId = getClientRequestId(message);
  if (clientRequestId) {
    return `request:${message?.role || "user"}:${messageType}:${clientRequestId}`;
  }
  if (message?.id) return `id:${message.id}`;
  const contentFingerprint = normalizeMessageContentForDedup(message?.content);
  const metaFingerprint = [
    messageType,
    message?.meta?.imageUrl || message?.meta?.image_url || "",
    message?.meta?.file_id || message?.meta?.generated_file_id || "",
    message?.meta?.storagePath || message?.meta?.storage_path || "",
  ].join(":");
  return `content:${message?.role || "user"}:${contentFingerprint}:${metaFingerprint}`;
}

export function mergeStoredMessage(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const clientRequestId = getClientRequestId(incoming) || getClientRequestId(existing);
  const resolvedId = resolveCanonicalMessageId(existing.id, incoming.id);
  const mergedMeta = {
    ...(existing.meta ? sanitizeMessageMeta(existing.meta) : {}),
    ...(incoming.meta ? sanitizeMessageMeta(incoming.meta) : {}),
  };
  if (!mergedMeta.imageUrl && (existing.meta?.imageUrl || existing.meta?.image_url)) {
    mergedMeta.imageUrl = existing.meta.imageUrl || existing.meta.image_url;
  }
  if (!mergedMeta.storagePath && (existing.meta?.storagePath || existing.meta?.storage_path)) {
    mergedMeta.storagePath = existing.meta.storagePath || existing.meta.storage_path;
  }
  const content = (typeof incoming.content === "string" && incoming.content.trim())
    ? incoming.content
    : (typeof existing.content === "string" && existing.content.trim() ? existing.content : (incoming.content || existing.content || ""));

  const existingTime = getMessageTimestampMs(existing);
  const incomingTime = getMessageTimestampMs(incoming);
  let timestamp = incoming.timestamp || incoming.created_at || existing.timestamp || existing.created_at;
  if (existingTime !== null && incomingTime !== null) {
    timestamp = existingTime <= incomingTime
      ? (existing.timestamp || existing.created_at)
      : (incoming.timestamp || incoming.created_at);
  }

  return {
    ...existing,
    ...incoming,
    id: resolvedId,
    content,
    timestamp,
    meta: Object.keys(mergedMeta).length > 0 ? mergedMeta : (incoming.meta || existing.meta),
    ...(clientRequestId ? { clientRequestId } : {}),
  };
}

export function normalizeMessageContentForDedup(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^generate\s+image:\s*/i, "")
    .trim();
}

function getMessageTimestampMs(message) {
  const rawTimestamp = message?.timestamp || message?.created_at;
  if (!rawTimestamp) return null;
  const parsed = Date.parse(rawTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function canonicalizeChatMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const canonicalList = [];
  const byId = new Map();
  const byRequest = new Map();
  const byImage = new Map();

  for (const rawMessage of messages) {
    if (!rawMessage) continue;
    const message = normalizeStoredMessage(rawMessage);
    const messageType = message.meta?.type || message.message_type || "text";
    const clientRequestId = getClientRequestId(message);
    const imageIdentity = (message.role === "assistant" && messageType === "image")
      ? (message.meta?.storagePath || message.meta?.storage_path || message.meta?.imageUrl || message.meta?.image_url || "")
      : "";
    const requestKey = clientRequestId ? `${message.role}:${messageType}:${clientRequestId}` : "";

    let matchIndex = -1;

    // 1. Exact ID match
    if (message.id && byId.has(message.id)) {
      matchIndex = byId.get(message.id);
    }

    // 2. Request Key match
    if (matchIndex === -1 && clientRequestId) {
      if (message.role === "user") {
        const userKey = `user:${clientRequestId}`;
        if (byRequest.has(userKey)) {
          matchIndex = byRequest.get(userKey);
        }
      } else if (message.role === "assistant") {
        if (messageType === "image") {
          const imageKey = `assistant:image:${clientRequestId}`;
          if (byRequest.has(imageKey)) {
            matchIndex = byRequest.get(imageKey);
          }
        } else if (messageType === "deep-research") {
          const deepKey = `assistant:deep-research:${clientRequestId}`;
          const anyAssistantKey = `assistant:${clientRequestId}`;
          if (byRequest.has(deepKey)) {
            matchIndex = byRequest.get(deepKey);
          } else if (byRequest.has(anyAssistantKey)) {
            matchIndex = byRequest.get(anyAssistantKey);
          }
        } else {
          // Assistant text
          const anyAssistantKey = `assistant:${clientRequestId}`;
          if (byRequest.has(anyAssistantKey)) {
            const candIndex = byRequest.get(anyAssistantKey);
            const existing = canonicalList[candIndex];
            const existType = existing?.meta?.type || existing?.message_type || "text";
            if (existType === "deep-research") {
              matchIndex = candIndex;
            } else if (existType === "text") {
              const existNorm = normalizeMessageContentForDedup(existing?.content);
              const candNorm = normalizeMessageContentForDedup(message.content);
              if (!existNorm || !candNorm || existNorm === candNorm) {
                matchIndex = candIndex;
              }
            }
          }
        }
      }
    }

    // 3. Image Identity match (storagePath or imageUrl for completed image)
    if (matchIndex === -1 && imageIdentity && byImage.has(imageIdentity)) {
      matchIndex = byImage.get(imageIdentity);
    }

    // 4. Optimistic User Turn match fallback (matching normalized prompt within turn window)
    if (matchIndex === -1 && message.role === "user") {
      const normContent = normalizeMessageContentForDedup(message.content);
      if (normContent) {
        const msgTime = getMessageTimestampMs(message);
        for (let i = canonicalList.length - 1; i >= 0; i--) {
          const existing = canonicalList[i];
          if (existing.role !== "user") continue;
          const existingRequestId = getClientRequestId(existing);
          // If BOTH have request IDs and they differ, they are distinct user turns!
          if (clientRequestId && existingRequestId && clientRequestId !== existingRequestId) {
            continue;
          }
          if (normalizeMessageContentForDedup(existing.content) === normContent) {
            const existTime = getMessageTimestampMs(existing);
            if (msgTime === null || existTime === null || Math.abs(msgTime - existTime) <= 90 * 1000) {
              matchIndex = i;
              break;
            }
          }
        }
      }
    }

    // 5. Assistant Image Placeholder correlation fallback
    if (matchIndex === -1 && message.role === "assistant" && messageType === "image") {
      const candImage = imageIdentity;
      const msgTime = getMessageTimestampMs(message);
      for (let i = canonicalList.length - 1; i >= 0; i--) {
        const existing = canonicalList[i];
        if (existing.role !== "assistant") continue;
        const existType = existing.meta?.type || existing.message_type || "text";
        if (existType !== "image") continue;
        const existingRequestId = getClientRequestId(existing);
        if (clientRequestId && existingRequestId && clientRequestId !== existingRequestId) {
          continue;
        }
        const existImage = existing.meta?.storagePath || existing.meta?.storage_path || existing.meta?.imageUrl || existing.meta?.image_url;
        // Exactly one must have an image and the other is a placeholder (NOT both empty!)
        const oneHasImageAndOneIsPlaceholder = Boolean((candImage && !existImage) || (!candImage && existImage));
        if (oneHasImageAndOneIsPlaceholder) {
          const existTime = getMessageTimestampMs(existing);
          if (msgTime === null || existTime === null || Math.abs(msgTime - existTime) <= 90 * 1000) {
            matchIndex = i;
            break;
          }
        }
      }
    }

    function indexMessageKeys(entry, idx) {
      if (entry.id) byId.set(entry.id, idx);
      const reqId = getClientRequestId(entry);
      const type = entry.meta?.type || entry.message_type || "text";
      if (entry.role === "user" && reqId) {
        byRequest.set(`user:${reqId}`, idx);
      } else if (entry.role === "assistant" && reqId) {
        if (type === "image") {
          byRequest.set(`assistant:image:${reqId}`, idx);
        } else if (type === "deep-research") {
          byRequest.set(`assistant:deep-research:${reqId}`, idx);
          byRequest.set(`assistant:${reqId}`, idx);
        } else {
          byRequest.set(`assistant:${reqId}`, idx);
        }
      }
      const img = (entry.role === "assistant" && type === "image")
        ? (entry.meta?.storagePath || entry.meta?.storage_path || entry.meta?.imageUrl || entry.meta?.image_url)
        : null;
      if (img) byImage.set(img, idx);
    }

    if (matchIndex >= 0) {
      const merged = mergeStoredMessage(canonicalList[matchIndex], message);
      canonicalList[matchIndex] = merged;
      indexMessageKeys(merged, matchIndex);
      if (message.id) byId.set(message.id, matchIndex);
    } else {
      const newIndex = canonicalList.length;
      canonicalList.push(message);
      indexMessageKeys(message, newIndex);
    }
  }

  if (options.sort) {
    return canonicalList.sort((a, b) => {
      const left = getMessageTimestampMs(a) ?? 0;
      const right = getMessageTimestampMs(b) ?? 0;
      if (left !== right) return left - right;
      return String(a.id).localeCompare(String(b.id));
    });
  }
  return canonicalList;
}

export function collapseAdjacentDuplicateChatMessages(messages, duplicateWindowMs = 90 * 1000) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  // First run deterministic multi-index canonicalization to resolve interleaved/non-adjacent copies
  const canonical = canonicalizeChatMessages(messages);
  const collapsed = [];
  for (const message of canonical) {
    if (!message) continue;
    const previous = collapsed[collapsed.length - 1];
    const sameRole = previous?.role === message.role;
    const sameContent = normalizeMessageContentForDedup(previous?.content) === normalizeMessageContentForDedup(message.content);
    const previousRequestId = getClientRequestId(previous);
    const currentRequestId = getClientRequestId(message);
    const sameRequest = Boolean(previousRequestId && currentRequestId && previousRequestId === currentRequestId);
    const previousIsDeepResearch = previous?.meta?.type === "deep-research";
    const currentIsDeepResearch = message?.meta?.type === "deep-research";
    if (
      previous
      && sameRole
      && previous.role === "assistant"
      && sameRequest
      && (previousIsDeepResearch || currentIsDeepResearch)
    ) {
      collapsed[collapsed.length - 1] = currentIsDeepResearch ? message : previous;
      continue;
    }

    const previousIsImage = previous?.meta?.type === "image" || previous?.message_type === "image";
    const currentIsImage = message?.meta?.type === "image" || message?.message_type === "image";
    if (previous && sameRole && previous.role === "assistant" && previousIsImage && currentIsImage) {
      const previousImageId = previous?.meta?.storagePath || previous?.meta?.storage_path || previous?.meta?.imageUrl || previous?.meta?.image_url;
      const currentImageId = message?.meta?.storagePath || message?.meta?.storage_path || message?.meta?.imageUrl || message?.meta?.image_url;
      const isSameImage = Boolean(
        sameRequest ||
        (previousImageId && currentImageId && previousImageId === currentImageId) ||
        (previous.id && message.id && previous.id === message.id)
      );
      if (isSameImage) {
        collapsed[collapsed.length - 1] = mergeStoredMessage(previous, message);
        continue;
      }
    }
    if (previousIsImage || currentIsImage) {
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
        collapsed[collapsed.length - 1] = mergeStoredMessage(previous, message);
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
    .sort(compareChatsByActivity);
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
  touchChatActivity(chat, msg.timestamp);
  chat.message_count = chat.messages.length;
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
  const clientRequestId = getClientRequestId(safeMessage);
  const targetRole = safeMessage?.role === "assistant" ? "assistant" : "user";
  const existingIndex = chat.messages.findIndex((item) => {
    if (item.id === messageId) return true;
    if (clientRequestId && getClientRequestId(item) === clientRequestId && item.role === targetRole) {
      return true;
    }
    return false;
  });
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
  touchChatActivity(chat, new Date().toISOString());
  chat.message_count = chat.messages.length;
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
  touchChatActivity(chat, new Date().toISOString());
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
  const created = getFirstValidTimestamp(chatData.created, chatData.created_at, visibleExisting?.created) || new Date().toISOString();
  const incomingLastMessageAt = getFirstValidTimestamp(
    chatData.last_message_at,
    chatData.lastMessageAt,
    visibleExisting?.last_message_at,
  );
  const incomingActivity = getFirstValidTimestamp(
    chatData.last_activity_at,
    chatData.lastActivityAt,
    incomingLastMessageAt,
    chatData.updated,
    chatData.updated_at,
    created,
  );
  const existingActivity = getServerChatActivityTimestamp(visibleExisting);
  const activity = getNewestTimestampValue(incomingActivity, existingActivity, created) || created;
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
    created,
    updated: activity,
    last_activity_at: activity,
    last_message_at: getNewestTimestampValue(incomingLastMessageAt, visibleExisting?.last_message_at) || null,
    source: "server",
    owner_user_id: normalizeCacheUserId(chatData.owner_user_id || chatData.ownerUserId || activeCacheUserId),
    pending_server_sync: Boolean(chatData.pending_server_sync),
    sync_error: chatData.sync_error || null,
    last_synced_at: chatData.last_synced_at || visibleExisting?.last_synced_at || null,
    warmed_at: chatData.warmed_at || visibleExisting?.warmed_at || null,
    message_cache_status: chatData.message_cache_status || visibleExisting?.message_cache_status || null,
    missing_remote_at: Object.prototype.hasOwnProperty.call(chatData, "missing_remote_at")
      ? (chatData.missing_remote_at || null)
      : null,
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

async function updateChatSyncState(chatId, updates = {}) {
  const chat = await getChat(chatId);
  if (!chat) return undefined;
  const allowed = [
    "pending_server_sync",
    "sync_error",
    "last_synced_at",
    "warmed_at",
    "message_cache_status",
    "missing_remote_at",
    "message_count",
    "last_activity_at",
    "last_message_at",
  ];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      chat[key] = updates[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "updated")) {
    chat.updated = updates.updated || chat.updated;
  }
  if (chat.source === "server") {
    const activity = getNewestTimestampValue(chat.last_activity_at, chat.updated, chat.created);
    if (activity) {
      chat.last_activity_at = activity;
      chat.updated = activity;
    }
  }
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

  const baseMessages = options.replaceExisting ? [] : existingMessages;
  const combined = [...baseMessages, ...incomingMessages];
  const canonical = canonicalizeChatMessages(combined);
  const normalizedMessages = collapseAdjacentDuplicateChatMessages(canonical);
  chat.messages = normalizedMessages;
  const lastMessageTimestamp = chat.messages.length > 0
    ? chat.messages[chat.messages.length - 1].timestamp
    : "";
  if (lastMessageTimestamp) {
    touchChatActivity(chat, lastMessageTimestamp);
  } else {
    chat.updated = chat.updated || new Date().toISOString();
  }
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

async function pruneServerChatMessageCache(keepChatIds = []) {
  const keepIds = new Set(Array.from(keepChatIds || []).filter(Boolean).map(String));
  const chats = await dbGetAll(STORES.chats);
  let pruned = 0;
  for (const chat of chats) {
    if (!chat?.id || chat.source !== "server" || !isServerScopedItemVisible(chat)) continue;
    if (keepIds.has(chat.id) || chat.pending_server_sync || chat.missing_remote_at) continue;
    if (!Array.isArray(chat.messages) || chat.messages.length === 0) continue;
    const cachedMessageCount = chat.messages.length;
    const knownMessageCount = Number(chat.message_count);
    chat.message_count = Number.isFinite(knownMessageCount) && knownMessageCount > 0
      ? knownMessageCount
      : cachedMessageCount;
    if (!chat.first_user_message) {
      chat.first_user_message = chat.messages.find((message) => message?.role === "user")?.content || null;
    }
    chat.messages = [];
    chat.message_cache_status = "metadata-only";
    chat.warmed_at = null;
    await dbPut(STORES.chats, chat);
    pruned += 1;
  }
  return pruned;
}

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
  createChat, getChat, getAllChats, addMessageToChat, upsertMessageInChat, updateMessageInChat, updateChatTitle, updateChatSyncState, deleteChat,
  getLocalChats, upsertServerChat, replaceChatMessages, mergeChatMessages, pruneServerChatMessageCache, compareChatsByActivity,
  storeMemory, getMemory, getAllMemories, getMemoriesByType, deleteMemory, getTopMemories,
  storeFile, getAllFiles, getFile, deleteFile,
  storeGeneratedFile, getGeneratedFile, getAllGeneratedFiles, deleteGeneratedFile,
  putSyncJob, getAllSyncJobs, deleteSyncJob,
  getConfig, setConfig, getAllConfig,
  getConversationAliases, setConversationAlias, resolveConversationAlias,
  getStorageStats, getStorageStatus, clearLocalData, generateId,
  normalizeMemoryScope, normalizeMemoryChatId,
  collapseAdjacentDuplicateChatMessages,
  canonicalizeChatMessages,
  getMessageMergeKey, normalizeMessageContentForDedup, mergeStoredMessage,
};
