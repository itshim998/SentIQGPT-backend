import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFrontendSources } from "./frontendSource";

const root = resolve(__dirname, "..");
const frontend = readFrontendSources(root);
const chatController = frontend.scripts["scripts/features/chat-controller.js"] || "";
const apiClient = frontend.scripts["scripts/services/api.js"] || "";
const storageService = frontend.scripts["scripts/services/storage.js"] || "";
const memoryPanel = frontend.scripts["scripts/panels/memory-panel.js"] || "";

function importsFromStorage(source: string, symbolName: string): boolean {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `import\\s+\\{[\\s\\S]*\\b${escaped}\\b[\\s\\S]*\\}\\s+from\\s+["']\\.\\.\\/services\\/storage\\.js["']`,
  ).test(source);
}

assert.match(
  chatController,
  /import\s+\{\s*PROFILE_NAME_REQUIRED_EVENT\s*\}\s+from\s+["']\.\.\/shared\/events\.js["']/,
  "chat controller should import profile-name event contract",
);
assert.match(
  apiClient,
  /import\s+\{\s*PROFILE_NAME_REQUIRED_EVENT\s*\}\s+from\s+["']\.\.\/shared\/events\.js["']/,
  "API client should import profile-name event contract",
);
assert.doesNotMatch(
  apiClient,
  /const\s+PROFILE_NAME_REQUIRED_EVENT\s*=/,
  "API client should not keep a private profile-name event constant",
);
assert.match(storageService, /export\s+function\s+normalizeMemoryScope/, "storage should export memory scope normalizer");
assert.match(storageService, /export\s+function\s+normalizeMemoryChatId/, "storage should export memory chat-id normalizer");
assert.match(storageService, /export\s+function\s+collapseAdjacentDuplicateChatMessages/, "storage should export chat-message dedupe helper");
assert(importsFromStorage(chatController, "normalizeMemoryScope"), "chat controller should import memory scope helper");
assert(importsFromStorage(chatController, "collapseAdjacentDuplicateChatMessages"), "chat controller should import chat-message dedupe helper");
assert.match(
  memoryPanel,
  /import\s+\{\s*normalizeMemoryScope\s*\}\s+from\s+["']\.\.\/services\/storage\.js["']/,
  "memory panel should import memory scope helper",
);
assert.match(
  storageService,
  /window\.SentIQStorage\s*=\s*\{[\s\S]*collapseAdjacentDuplicateChatMessages/,
  "SentIQStorage compatibility global should expose chat-message dedupe helper",
);
assert.match(storageService, /execution_mode:\s*["']fast["']/, "storage defaults execution mode to fast");
assert.match(storageService, /const DB_VERSION = 5;/, "storage migration version should include owner-scoped memories and files");
assert.match(storageService, /memStore\.createIndex\(["']owner_user_id["']/, "memory cache should index owner_user_id");
assert.match(storageService, /fileStore\.createIndex\(["']owner_user_id["']/, "file cache should index owner_user_id");
assert.match(storageService, /owner_user_id:\s*normalizeCacheUserId\(memory\.owner_user_id/, "stored memories should carry owner_user_id");
assert.match(storageService, /owner_user_id:\s*normalizeCacheUserId\(fileData\.owner_user_id/, "stored uploaded files should carry owner_user_id");
assert.match(storageService, /filter\(\(memory\) => isOwnedCacheItemVisible\(memory\)\)/, "memory reads should be scoped to the active owner");
assert.match(storageService, /filter\(\(file\) => isOwnedCacheItemVisible\(file\)\)/, "file reads should be scoped to the active owner");
assert.match(storageService, /tx\.oncomplete\s*=\s*\(\)\s*=>\s*resolve\(requestResult\)/, "IndexedDB put helper should resolve after transaction completion");
assert.match(storageService, /tx\.onabort\s*=\s*\(\)\s*=>\s*reject\(tx\.error \|\| new Error\(`IndexedDB \$\{storeName\} write transaction aborted`\)\)/, "IndexedDB put helper should reject aborted transactions");
assert.match(storageService, /tx\.oncomplete\s*=\s*\(\)\s*=>\s*resolve\(\)/, "IndexedDB delete helper should resolve after transaction completion");
assert.match(storageService, /window\.SentIQStorage\s*=\s*\{[\s\S]*upsertMessageInChat/, "storage should expose streaming message upsert helper");
assert.match(storageService, /window\.SentIQStorage\s*=\s*\{[\s\S]*mergeChatMessages/, "storage should expose safe server-message merge helper");
assert.match(storageService, /incomingMessages\.length === 0 && existingMessages\.length > 0/, "remote hydration should preserve non-empty local chats on empty snapshots");
assert.match(apiClient, /execution_mode:\s*executionMode/, "chat API payload should include execution_mode");
assert.match(chatController, /executionModeToggle/, "chat controller should wire execution mode selector refs");
assert.match(chatController, /createStreamingDraftPersister/, "chat controller should persist streaming drafts locally");
assert.doesNotMatch(chatController, /id:\s*`pending-\$\{Storage\.generateId\(\)\}`/, "authenticated new chats should use canonical UUID ids, not pending-* ids");

for (const helperName of ["normalizeMemoryScope", "collapseAdjacentDuplicateChatMessages"]) {
  for (const file of frontend.scriptFiles) {
    if (!file.content.includes(`${helperName}(`) || file.relativePath === "scripts/services/storage.js") {
      continue;
    }
    assert(
      importsFromStorage(file.content, helperName) || new RegExp(`SentIQStorage\\.${helperName}`).test(file.content),
      `${file.relativePath} should not rely on a bare ${helperName} global`,
    );
  }
}

const globalsIndex = chatController.indexOf("window.SentIQChat = {");
const startupIndex = chatController.indexOf("document.addEventListener(\"DOMContentLoaded\", startChatUi)");
assert(globalsIndex > 0, "chat controller should expose SentIQChat");
assert(startupIndex > globalsIndex, "SentIQChat should be exposed before chat startup is registered");

const harness = String.raw`
const ids = new Map();
const domListeners = new Map();

class FakeClassList {
  add() {}
  remove() {}
  toggle() { return false; }
  contains() { return false; }
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.type = "password";
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.dataset = {};
    this.files = [];
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 500;
    this.offsetWidth = 200;
    this.offsetHeight = 40;
    this.className = "";
    this.classList = new FakeClassList();
    this.style = { display: "none", setProperty() {}, removeProperty() {} };
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  prepend(child) { this.children.unshift(child); child.parentElement = this; return child; }
  remove() {}
  replaceChildren(...children) { this.children = children; }
  querySelector() { return new FakeElement(); }
  querySelectorAll() { return []; }
  closest() { return new FakeElement(); }
  matches() { return false; }
  contains() { return false; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }
  focus() { document.activeElement = this; }
  blur() {}
  click() {}
  reset() { this.value = ""; }
  cloneNode() { return new FakeElement(this.id + "-clone"); }
  insertAdjacentHTML() {}
  insertBefore(child) { return this.appendChild(child); }
  getBoundingClientRect() { return { top: 0, left: 0, bottom: 40, right: 200, width: 200, height: 40 }; }
}

const getEl = (id) => {
  if (!ids.has(id)) ids.set(id, new FakeElement(id));
  return ids.get(id);
};

const document = {
  readyState: "loading",
  body: getEl("body"),
  documentElement: getEl("html"),
  activeElement: null,
  addEventListener(type, fn) {
    if (!domListeners.has(type)) domListeners.set(type, []);
    domListeners.get(type).push(fn);
  },
  removeEventListener() {},
  getElementById: getEl,
  querySelector() { return new FakeElement(); },
  querySelectorAll() { return []; },
  createElement(tag) { const el = new FakeElement(); el.tagName = tag.toUpperCase(); return el; },
  createTextNode(text) { const el = new FakeElement(); el.textContent = text; return el; },
  execCommand() { return true; }
};

const localStorageStore = new Map();
const localStorage = {
  getItem(key) { return localStorageStore.has(key) ? localStorageStore.get(key) : null; },
  setItem(key, value) { localStorageStore.set(key, String(value)); },
  removeItem(key) { localStorageStore.delete(key); },
  clear() { localStorageStore.clear(); }
};

const locationObj = {
  protocol: "http:",
  hostname: "127.0.0.1",
  origin: "http://127.0.0.1:5500",
  href: "http://127.0.0.1:5500/",
  search: "",
  hash: ""
};

class FakeMutationObserver {
  constructor(fn) { this.fn = fn; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

const windowObj = {
  document,
  localStorage,
  location: locationObj,
  history: { replaceState() {} },
  navigator: { userAgent: "node-bootstrap-test", clipboard: { writeText: async () => {} } },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
  requestAnimationFrame(fn) { return setTimeout(fn, 0); },
  cancelAnimationFrame(id) { clearTimeout(id); },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  URLSearchParams,
  Blob,
  crypto: globalThis.crypto,
  fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }),
  marked: { parse: (value) => value, setOptions() {}, Renderer: class {} },
  katex: { renderToString: (value) => value },
  getComputedStyle() { return { getPropertyValue: () => "" }; },
  MutationObserver: FakeMutationObserver
};

for (const [key, value] of Object.entries({
  window: windowObj,
  document,
  localStorage,
  location: locationObj,
  history: windowObj.history,
  navigator: windowObj.navigator,
  Element: FakeElement,
  HTMLElement: FakeElement,
  Node: FakeElement,
  getComputedStyle: windowObj.getComputedStyle,
  requestAnimationFrame: windowObj.requestAnimationFrame,
  cancelAnimationFrame: windowObj.cancelAnimationFrame,
  fetch: windowObj.fetch,
  MutationObserver: FakeMutationObserver,
  FileReader: class { readAsDataURL() { this.result = "data:"; this.onload?.(); } },
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
windowObj.window = windowObj;

const moduleUrl = new URL("frontend/scripts/main.js", "file:///" + process.cwd().replace(/\\/g, "/") + "/");
await import(moduleUrl.href + "?bootstrapTest=" + Date.now());

const domReadyListeners = domListeners.get("DOMContentLoaded") || [];
if (domReadyListeners.length < 1) {
  console.error("No DOMContentLoaded startup listener was registered.");
  process.exit(1);
}

domReadyListeners[0]();

const requiredClickIds = [
  "auth-login-btn",
  "auth-signup-btn",
  "new-chat-btn",
  "settings-btn",
  "send-btn",
  "execution-mode-toggle",
  "composer-plus-btn",
  "file-attach-btn",
  "image-gen-btn",
  "websurf-basic-btn"
];

const missing = [];
for (const id of requiredClickIds) {
  const count = (getEl(id).listeners.get("click") || []).length;
  console.log("LISTENER " + id + " " + count);
  if (count < 1) missing.push(id);
}

if (typeof window.SentIQGetSafeErrorMessage !== "function") {
  missing.push("SentIQGetSafeErrorMessage");
}
if (typeof window.SentIQChat?.showToast !== "function" || typeof window.SentIQChat?.debugWarn !== "function") {
  missing.push("SentIQChat diagnostics");
}
if (missing.length > 0) {
  console.error("Missing frontend bootstrap contracts: " + missing.join(", "));
  process.exit(1);
}

const collapse = window.SentIQStorage?.collapseAdjacentDuplicateChatMessages;
if (typeof collapse !== "function") {
  console.error("SentIQStorage.collapseAdjacentDuplicateChatMessages is unavailable.");
  process.exit(1);
}
const baseTime = Date.parse("2026-05-15T00:00:00.000Z");
const adjacentDuplicates = collapse([
  { role: "user", content: "Hello   world", timestamp: new Date(baseTime).toISOString() },
  { role: "user", content: "Hello world", timestamp: new Date(baseTime + 1000).toISOString() },
  { role: "assistant", content: "Reply", timestamp: new Date(baseTime + 2000).toISOString() },
]);
const imageDuplicates = collapse([
  { role: "assistant", content: "image", timestamp: new Date(baseTime).toISOString(), meta: { type: "image" } },
  { role: "assistant", content: "image", timestamp: new Date(baseTime + 1000).toISOString(), meta: { type: "image" } },
]);
const spacedDuplicates = collapse([
  { role: "user", content: "Still separate", timestamp: new Date(baseTime).toISOString() },
  { role: "user", content: "Still separate", timestamp: new Date(baseTime + 180000).toISOString() },
]);
if (adjacentDuplicates.length !== 2 || imageDuplicates.length !== 2 || spacedDuplicates.length !== 2) {
  console.error("Chat-message dedupe behavior regressed.");
  process.exit(1);
}
console.log("DEDUPE_OK");

try {
  const newChatHandler = getEl("new-chat-btn").listeners.get("click")?.[0];
  await Promise.resolve(newChatHandler?.({ target: getEl("new-chat-btn"), preventDefault() {}, stopPropagation() {} }));
  console.log("NEW_CHAT_CLICK_OK");
} catch (error) {
  console.error("New chat click crashed after bootstrap:", error);
  process.exit(1);
}
process.exit(0);
`;

const output = execFileSync(process.execPath, ["--input-type=module", "-e", harness], {
  cwd: root,
  encoding: "utf8",
});

for (const id of [
  "auth-login-btn",
  "auth-signup-btn",
  "new-chat-btn",
  "settings-btn",
  "send-btn",
  "execution-mode-toggle",
  "composer-plus-btn",
  "file-attach-btn",
  "image-gen-btn",
  "websurf-basic-btn",
]) {
  assert.match(output, new RegExp(`LISTENER ${id} [1-9]`), `${id} should have a click listener after bootstrap`);
}
assert.match(output, /DEDUPE_OK/, "chat-message dedupe helper should satisfy production behavior");
assert.match(output, /NEW_CHAT_CLICK_OK/, "new chat click should not crash after bootstrap");

console.log("PASS | Frontend bootstrap regression checks passed.");
