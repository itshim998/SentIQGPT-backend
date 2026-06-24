import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFrontendSources } from "./frontendSource";

const root = resolve(__dirname, "..");
const frontend = readFrontendSources(root);
const chatController = frontend.scripts["scripts/features/chat-controller.js"] || "";
const apiClient = frontend.scripts["scripts/services/api.js"] || "";
const authService = frontend.scripts["scripts/services/auth.js"] || "";
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
assert.match(
  chatController,
  /function\s+shouldSkipFastIntentPreflight/,
  "chat controller should include a fast plain-chat intent preflight skip helper",
);
assert.match(
  chatController,
  /if\s*\(\s*!skipFastIntentPreflight\s*&&\s*apiMessage\s*&&\s*typeof\s+API\.getChatIntent\s*===\s*["']function["']\s*\)/,
  "fast plain-chat should skip the intent preflight only through the explicit guard",
);
assert.match(
  chatController,
  /function\s+shouldSkipFastIntentPreflight[\s\S]*!isLikelyFileGenerationRequest[\s\S]*!isChartRequest[\s\S]*!isLikelyBufferedReasoningPrompt[\s\S]*!isImageRequest/,
  "fast intent skip should retain local guards for file, chart, reasoning, and image prompts",
);
assert.doesNotMatch(
  chatController,
  /shouldSkipFastIntentPreflight[\s\S]*!isLikelyCurrentInfoPrompt/,
  "current-info prompts should not force an intent preflight without manual WebSurf",
);
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
  authService,
  /createClient\([\s\S]*auth:\s*\{[\s\S]*autoRefreshToken:\s*true[\s\S]*persistSession:\s*true[\s\S]*storage:\s*resolveAuthStorage\(\)/,
  "Supabase auth should explicitly persist sessions through the resolved WebView/browser storage",
);
const passwordSignInStart = authService.indexOf("async function signInWithPassword");
const passwordSignInEnd = authService.indexOf("async function signInWithGoogle", passwordSignInStart);
assert(passwordSignInStart > 0 && passwordSignInEnd > passwordSignInStart, "auth service should expose a password sign-in boundary");
const passwordSignInBlock = authService.slice(passwordSignInStart, passwordSignInEnd);
assert.match(
  passwordSignInBlock,
  /client\.auth\.signInWithPassword\(\{\s*email,\s*password\s*\}\)/,
  "email/password login should use Supabase signInWithPassword in-app",
);
assert.match(
  passwordSignInBlock,
  /commitAuthSession\(session,\s*["']password["']\)/,
  "email/password login should commit and publish the returned session",
);
assert.doesNotMatch(
  passwordSignInBlock,
  /signInWithOAuth|openNativeAuthBrowser|buildAuthReturnUrl|window\.location\.href/,
  "email/password login should not use OAuth, browser, or native callback redirect flow",
);
assert.match(
  authService,
  /document\.dispatchEvent\(new CustomEvent\(["']sentiq-auth-changed["']/,
  "auth service should dispatch the existing auth-changed event when sessions change",
);
assert.match(
  authService,
  /async function signInWithGoogle[\s\S]*client\.auth\.signInWithOAuth/,
  "Google auth should remain on the OAuth path",
);
assert.match(
  authService,
  /async function resetPasswordForEmail[\s\S]*buildRecoveryRedirectUrl\(\)/,
  "password recovery should remain on the recovery redirect path",
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
const processPendingFilesStart = chatController.indexOf("async function processPendingFiles");
const processPendingFilesEnd = chatController.indexOf("function openSettings", processPendingFilesStart);
assert(processPendingFilesStart > 0 && processPendingFilesEnd > processPendingFilesStart);
const processPendingFilesBlock = chatController.slice(processPendingFilesStart, processPendingFilesEnd);
assert.match(processPendingFilesBlock, /fileUploadInFlight/, "file uploads should guard against duplicate processing");
assert.match(processPendingFilesBlock, /API\.uploadFile\(file\)/, "guest and authenticated regular files should use the upload endpoint");
assert.match(processPendingFilesBlock, /addCurrentSessionFiles\(completedSessionFiles\)/, "uploaded files should be attached to session context");
assert.match(processPendingFilesBlock, /debugLog\(["']\[Upload\] guest files attached to session["']/, "guest upload context attachment should be logged");
assert.match(processPendingFilesBlock, /skipPendingFileProcessing:\s*true/, "follow-up chat after upload should not reprocess the same files");
assert.match(chatController, /pendingFileStatusByFile\.set\(file,\s*\{\s*status:\s*["']queued["']/, "selected files should remain previewable before upload");
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
const authStateListeners = [];
const fakeSession = {
  access_token: "test-access-token",
  refresh_token: "test-refresh-token",
  user: { id: "user-1", email: "person@example.test" }
};
const supabaseCalls = {
  clientOptions: null,
  passwordSignIn: [],
  oauth: 0,
  recovery: 0
};
let fakeCurrentSession = null;

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
  dispatchEvent(event) {
    (domListeners.get(event.type) || []).forEach((fn) => fn(event));
    return true;
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
  SENTIQ_SUPABASE_URL: "https://example.supabase.co",
  SENTIQ_SUPABASE_ANON_KEY: "anon-key",
  supabase: {
    createClient(_url, _key, options) {
      supabaseCalls.clientOptions = options;
      return {
        auth: {
          async getSession() {
            return { data: { session: fakeCurrentSession }, error: null };
          },
          async getUser() {
            return { data: { user: fakeCurrentSession?.user || null }, error: null };
          },
          async signInWithPassword(credentials) {
            supabaseCalls.passwordSignIn.push(credentials);
            fakeCurrentSession = fakeSession;
            return { data: { session: fakeSession, user: fakeSession.user }, error: null };
          },
          async signInWithOAuth() {
            supabaseCalls.oauth += 1;
            return { data: { url: "https://oauth.example.test" }, error: null };
          },
          async signUp() {
            return { data: { session: null, user: null }, error: null };
          },
          async resetPasswordForEmail() {
            supabaseCalls.recovery += 1;
            return { data: {}, error: null };
          },
          async updateUser() {
            return { data: { user: fakeCurrentSession?.user || fakeSession.user }, error: null };
          },
          async signOut() {
            fakeCurrentSession = null;
            authStateListeners.forEach((listener) => listener("SIGNED_OUT", null));
            return { error: null };
          },
          onAuthStateChange(listener) {
            authStateListeners.push(listener);
            return { data: { subscription: { unsubscribe() {} } } };
          }
        }
      };
    }
  },
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

let passwordAuthEvent = null;
const passwordCallbackSessions = [];
document.addEventListener("sentiq-auth-changed", (event) => {
  if (event.detail?.source === "password") passwordAuthEvent = event.detail;
});
window.SentIQAuth?.subscribeAuthChanges?.((session) => {
  passwordCallbackSessions.push(session);
});
const passwordResult = await window.SentIQAuth?.signInWithPassword?.("person@example.test", "correct-password");
if (supabaseCalls.passwordSignIn.length !== 1) {
  console.error("Password login did not call Supabase signInWithPassword exactly once.");
  process.exit(1);
}
if (supabaseCalls.passwordSignIn[0]?.email !== "person@example.test" || supabaseCalls.passwordSignIn[0]?.password !== "correct-password") {
  console.error("Password login did not pass credentials through to signInWithPassword.");
  process.exit(1);
}
if (supabaseCalls.oauth !== 0 || supabaseCalls.recovery !== 0) {
  console.error("Password login touched OAuth or recovery redirect flow.");
  process.exit(1);
}
if (supabaseCalls.clientOptions?.auth?.persistSession !== true || supabaseCalls.clientOptions?.auth?.autoRefreshToken !== true) {
  console.error("Supabase auth persistence options were not configured.");
  process.exit(1);
}
if (!supabaseCalls.clientOptions?.auth?.storage || typeof supabaseCalls.clientOptions.auth.storage.setItem !== "function") {
  console.error("Supabase auth storage was not configured.");
  process.exit(1);
}
if (passwordResult?.session !== fakeSession) {
  console.error("Password login did not return the committed session.");
  process.exit(1);
}
if (passwordAuthEvent?.session !== fakeSession) {
  console.error("Password login did not dispatch sentiq-auth-changed with the session.");
  process.exit(1);
}
if (passwordCallbackSessions.at(-1) !== fakeSession) {
  console.error("Password login did not notify subscribed auth refresh callbacks.");
  process.exit(1);
}
const passwordAccessToken = await window.SentIQAuth?.getAccessToken?.();
if (passwordAccessToken !== fakeSession.access_token) {
  console.error("Password login did not update the active access token.");
  process.exit(1);
}
console.log("AUTH_PASSWORD_COMMIT_OK");
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
assert.match(output, /AUTH_PASSWORD_COMMIT_OK/, "password login should commit a session and publish auth state");

console.log("PASS | Frontend bootstrap regression checks passed.");
