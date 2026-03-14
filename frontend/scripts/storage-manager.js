// SentIQGPT — Storage Manager
// IndexedDB abstraction for persisting sessions and memories.

const DB_NAME = "sentiqgpt";
const DB_VERSION = 2;

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("updatedAt", "updatedAt");
      }

      if (!db.objectStoreNames.contains("memories")) {
        const memories = db.createObjectStore("memories", { keyPath: "id" });
        memories.createIndex("type", "type");
        memories.createIndex("importance", "importance");
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = "readonly") {
  return openDB().then((db) => {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  });
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function saveSession(session) {
  const store = await tx("sessions", "readwrite");
  return promisify(store.put({ ...session, updatedAt: Date.now() }));
}

async function getSession(id) {
  const store = await tx("sessions");
  return promisify(store.get(id));
}

async function getAllSessions() {
  const store = await tx("sessions");
  return new Promise((resolve, reject) => {
    const req = store.index("updatedAt").openCursor(null, "prev");
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteSession(id) {
  const store = await tx("sessions", "readwrite");
  return promisify(store.delete(id));
}

// ── Memories ─────────────────────────────────────────────────────────────────

async function saveMemory(memory) {
  const store = await tx("memories", "readwrite");
  return promisify(store.put(memory));
}

async function getAllMemories() {
  const store = await tx("memories");
  return promisify(store.getAll());
}

async function deleteMemory(id) {
  const store = await tx("memories", "readwrite");
  return promisify(store.delete(id));
}

window.SentIQStorage = {
  saveSession,
  getSession,
  getAllSessions,
  deleteSession,
  saveMemory,
  getAllMemories,
  deleteMemory,
};
