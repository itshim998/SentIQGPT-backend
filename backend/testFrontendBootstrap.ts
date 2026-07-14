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
assert.match(
  apiClient,
  /async function generateImage[\s\S]*execution_mode:\s*executionMode/,
  "image API payload should include execution_mode",
);
assert.match(
  chatController,
  /API\.generateImage\(prompt,\s*\{[\s\S]*executionMode:\s*normalizeExecutionMode\(currentExecutionMode\)/,
  "image generation should send current execution mode",
);
assert.doesNotMatch(
  chatController,
  /shouldSkipFastIntentPreflight|API\.getChatIntent|isLikelyFileGenerationRequest|isChartRequest|isImageRequest/,
  "chat startup must not predict semantic intent",
);
assert.match(chatController, /onToolLifecycle/, "confirmed tool lifecycle events drive tool UI state");
assert.match(
  chatController,
  /getChatContextData\(targetChatId,\s*\{\s*recentLimit:\s*requestExecutionMode\s*===\s*["']fast["']\s*\?\s*6\s*:\s*20,\s*\}\)/,
  "fast chat should send only six recent messages while intuitive keeps the larger context",
);
assert.match(
  chatController,
  /trustedProfile:\s*requestExecutionMode\s*===\s*["']fast["']\s*&&\s*authProfileState\.displayName/,
  "fast chat should pass cached profile context when available",
);
assert.match(
  apiClient,
  /requestContext\.trusted_profile\s*=\s*\{\s*display_name:\s*trustedDisplayName\s*\}/,
  "API client should serialize cached trusted profile context",
);
assert.match(
  chatController,
  /authGateMessage\.classList\.toggle\(["']visible["'],\s*requiresName\)/,
  "guest mode should not show the lower auth gate above the composer",
);
assert.match(
  chatController,
  /setControlDisabled\(fileAttachBtn,\s*composerDisabled\)/,
  "guest mode should not disable file attachment just because the user is signed out",
);
assert.doesNotMatch(
  chatController,
  /fileAttachBtn\.(disabled|style\.display)\s*=\s*!?isAuthenticatedSession\(\)/,
  "file attachment should not be hidden or disabled by signed-in state",
);
assert.doesNotMatch(
  chatController,
  /authGateMessage\.classList\.toggle\(["']visible["'],\s*!signedIn\s*\|\|\s*requiresName\)/,
  "guest auth upsell should stay in the welcome note instead of blocking the composer",
);
const queueDroppedFilesStart = chatController.indexOf("function queueDroppedFiles");
const queueDroppedFilesEnd = chatController.indexOf("function handleFileSelect", queueDroppedFilesStart);
assert(queueDroppedFilesStart > 0 && queueDroppedFilesEnd > queueDroppedFilesStart);
const queueDroppedFilesBlock = chatController.slice(queueDroppedFilesStart, queueDroppedFilesEnd);
assert.match(queueDroppedFilesBlock, /addPendingFiles\(files\)[\s\S]*renderFilePreview\(\)/, "guest file drops should queue and preview files");
assert.doesNotMatch(queueDroppedFilesBlock, /requireAuthAccess|isAuthenticatedSession\(\)/, "guest file drops should not require authentication");
const processAttachmentStart = chatController.indexOf("async function processComposerAttachment");
const processAttachmentEnd = chatController.indexOf("async function runWithConcurrencyLimit", processAttachmentStart);
assert(processAttachmentStart > 0 && processAttachmentEnd > processAttachmentStart);
const processAttachmentBlock = chatController.slice(processAttachmentStart, processAttachmentEnd);
assert.match(processAttachmentBlock, /attachment\.attempt\s*=\s*attempt/, "file uploads should version processing attempts");
assert.match(processAttachmentBlock, /API\.uploadFile\(attachment\.file\)/, "guest and authenticated regular files should use the upload endpoint");
assert.match(processAttachmentBlock, /isActiveComposerAttachment\(attachment, attempt\)/, "stale upload completions must not mutate active composer state");
assert.match(processAttachmentBlock, /attachment\.fileReference\s*=\s*fileReference/, "uploaded files should become request context references");
assert.match(chatController, /status:\s*validation\.ok\s*\?\s*["']processing["']\s*:\s*["']failed["']/, "selected files should remain previewable while upload processing begins");
assert.match(
  apiClient,
  /!tokensReceived\s*&&\s*!structuredReceived\s*&&\s*!terminalError/,
  "empty SSE streams should be treated as retryable failures",
);
assert.match(
  chatController,
  /response did not complete\|please retry/i,
  "retryable empty stream failures should go to the existing retry UI instead of non-stream fallback",
);
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

const deepResearchStateUrl = new URL("frontend/scripts/features/deep-research-state.js", "file:///" + process.cwd().replace(/\\/g, "/") + "/");
const { resolveDeepResearchCardState } = await import(deepResearchStateUrl.href + "?stateTest=" + Date.now());
const runningResearchState = resolveDeepResearchCardState(
  { type: "deep-research", reportId: "report-running", status: "running" },
  "",
  {
    report_id: "report-running",
    status: "running",
    progress_percent: 55,
    progress_phase: "search",
    latest_status_text: "Searching saved progress...",
    partial_content: "Persisted partial report"
  }
);
const completedResearchState = resolveDeepResearchCardState(
  { type: "deep-research", reportId: "report-complete", status: "running" },
  "",
  {
    report_id: "report-complete",
    status: "completed",
    progress_percent: 100,
    content: "Completed persisted report"
  }
);
if (
  !runningResearchState.shouldMonitor
  || runningResearchState.progressPercent !== 55
  || runningResearchState.partialContent !== "Persisted partial report"
  || completedResearchState.shouldMonitor
  || completedResearchState.status !== "completed"
  || completedResearchState.content !== "Completed persisted report"
) {
  console.error("Deep Research reload state hydration regressed.");
  process.exit(1);
}
console.log("DEEP_RESEARCH_RELOAD_STATE_OK");

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
  "live-beta-btn",
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
const deepResearchReloadDuplicates = collapse([
  {
    id: "assistant-local-request-1",
    role: "assistant",
    content: "# Completed report",
    timestamp: new Date(baseTime).toISOString(),
    clientRequestId: "request-1"
  },
  {
    id: "server-deep-report-1",
    role: "assistant",
    content: "# Completed report",
    timestamp: new Date(baseTime + 10 * 60 * 1000).toISOString(),
    clientRequestId: "request-1",
    meta: { type: "deep-research", reportId: "report-1", status: "completed" }
  }
]);
const cancelledDeepResearchReloadDuplicates = collapse([
  {
    id: "assistant-local-request-2",
    role: "assistant",
    content: "Research session cancelled.",
    timestamp: new Date(baseTime).toISOString(),
    clientRequestId: "request-2"
  },
  {
    id: "server-deep-report-2",
    role: "assistant",
    content: "Research session cancelled.",
    timestamp: new Date(baseTime + 10 * 60 * 1000).toISOString(),
    clientRequestId: "request-2",
    meta: { type: "deep-research", reportId: "report-2", status: "cancelled" }
  }
]);
const failedDeepResearchReloadDuplicates = collapse([
  {
    id: "assistant-local-request-3",
    role: "assistant",
    content: "Research session failed. Please try again shortly.",
    timestamp: new Date(baseTime).toISOString(),
    clientRequestId: "request-3"
  },
  {
    id: "server-deep-report-3",
    role: "assistant",
    content: "Research session failed. Please try again shortly.",
    timestamp: new Date(baseTime + 10 * 60 * 1000).toISOString(),
    clientRequestId: "request-3",
    meta: { type: "deep-research", reportId: "report-3", status: "failed" }
  }
]);
const normalAssistantMessages = collapse([
  {
    id: "normal-assistant-1",
    role: "assistant",
    content: "First normal response",
    timestamp: new Date(baseTime).toISOString(),
    clientRequestId: "normal-request"
  },
  {
    id: "normal-assistant-2",
    role: "assistant",
    content: "Second normal response",
    timestamp: new Date(baseTime + 1000).toISOString(),
    clientRequestId: "normal-request"
  }
]);
if (
  adjacentDuplicates.length !== 2
  || imageDuplicates.length !== 2
  || spacedDuplicates.length !== 2
  || deepResearchReloadDuplicates.length !== 1
  || deepResearchReloadDuplicates[0]?.meta?.type !== "deep-research"
  || deepResearchReloadDuplicates[0]?.meta?.status !== "completed"
  || cancelledDeepResearchReloadDuplicates.length !== 1
  || cancelledDeepResearchReloadDuplicates[0]?.meta?.status !== "cancelled"
  || failedDeepResearchReloadDuplicates.length !== 1
  || failedDeepResearchReloadDuplicates[0]?.meta?.status !== "failed"
  || normalAssistantMessages.length !== 2
) {
  console.error("Chat-message dedupe behavior regressed.");
  process.exit(1);
}
console.log("DEEP_RESEARCH_RELOAD_DEDUPE_OK");
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
  "live-beta-btn",
  "execution-mode-toggle",
  "composer-plus-btn",
  "file-attach-btn",
  "image-gen-btn",
  "websurf-basic-btn",
]) {
  assert.match(output, new RegExp(`LISTENER ${id} [1-9]`), `${id} should have a click listener after bootstrap`);
}
assert.match(output, /DEDUPE_OK/, "chat-message dedupe helper should satisfy production behavior");
assert.match(output, /DEEP_RESEARCH_RELOAD_DEDUPE_OK/, "Deep Research reload should retain only the canonical card message");
assert.match(output, /DEEP_RESEARCH_RELOAD_STATE_OK/, "running and completed Deep Research reload states should hydrate correctly");
assert.match(output, /NEW_CHAT_CLICK_OK/, "new chat click should not crash after bootstrap");

console.log("PASS | Frontend bootstrap regression checks passed.");
