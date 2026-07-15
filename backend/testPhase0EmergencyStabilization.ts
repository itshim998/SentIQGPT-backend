import assert from "assert";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const root = resolve(__dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const html = read("frontend/index.html");
const htaccess = read("frontend/.htaccess");
const bootstrap = read("frontend/scripts/bootstrap-guard.js");
const storage = read("frontend/scripts/services/storage.js");
const api = read("frontend/scripts/services/api.js");
const controller = read("frontend/scripts/features/chat-controller.js");
const errors = read("frontend/scripts/services/errors.js");
const trustPanel = read("frontend/scripts/panels/trust-panel.js");
const server = read("backend/server.ts");

for (const relativePath of [
  "frontend/vendor/marked/marked.min.js",
  "frontend/vendor/katex/katex.min.js",
  "frontend/vendor/katex/katex.min.css",
  "frontend/vendor/supabase/supabase.js",
]) {
  assert(existsSync(resolve(root, relativePath)), `missing vendored browser asset: ${relativePath}`);
}

assert(html.includes("scripts/bootstrap-guard.js"), "bootstrap guard must load before the module entrypoint");
assert(!html.includes("cdn.jsdelivr.net/npm/marked"), "marked must not depend on a runtime CDN");
assert(!html.includes("cdn.jsdelivr.net/npm/katex"), "KaTeX must not depend on a runtime CDN");
assert(!html.includes("cdn.jsdelivr.net/npm/@supabase"), "Supabase must not depend on a runtime CDN");
assert(htaccess.includes("AddType application/javascript .js .mjs"), "static host must declare JavaScript MIME types");
assert(htaccess.includes("AddType font/woff2 .woff2"), "static host must declare KaTeX font MIME types");
assert(bootstrap.includes("SentIQBootstrap"), "bootstrap guard must expose readiness status");
assert(bootstrap.includes("temporary in-memory storage"), "bootstrap guard must explain volatile storage mode");

assert(storage.includes('storageMode = "persistent"'), "storage must track persistent versus volatile mode");
assert(storage.includes("switchToVolatileStorage"), "storage must fall back when IndexedDB is blocked");
assert(storage.includes("clearLocalData"), "storage must expose a local data clear");
assert(storage.includes("globalThis.crypto?.getRandomValues"), "UUID fallback must prefer secure random bytes");

assert(errors.includes("response_interrupted"), "safe errors must include interrupted responses");
assert(errors.includes("backend_unavailable"), "safe errors must include backend failures");
assert(api.includes("canStreamResponses"), "API client must expose streaming capability");
assert(api.includes('terminalError.code = "response_interrupted"'), "transport interruption must retain a stable error code");
assert(controller.includes("appendResponseRecoveryRow"), "partial answers must render a recovery action");
assert(controller.includes("CONTINUE_RESPONSE_PROMPT"), "partial answers must support linked continuation");
assert(controller.includes("STORAGE_KEYS.guestRecoveryDraft"), "guest recovery must write the current tab-scoped key");
assert(controller.includes("LEGACY_STORAGE_KEYS.guestRecoveryDraft"), "guest recovery must retain legacy draft reads during migration");
assert(controller.includes("readSessionStorageWithLegacy"), "guest recovery must fall back to legacy session storage");

assert(html.includes('data-trust-tab="support"'), "account panel must expose the trust and support dialog");
assert(html.includes('data-trust-tab="controls"'), "trust dialog must expose privacy and data controls");
assert(html.includes("support@sentiqlabs.com"), "support email fallback must be visible");
assert(trustPanel.includes("clearFileSession"), "local clear must clear temporary backend upload context");
assert(trustPanel.includes("clearUploadedSourceContext"), "data controls must clear temporary source files independently");
assert(server.includes('"/api/files/session"'), "backend must expose temporary source cleanup");
assert(server.includes('"/api/generated-files/:id"'), "backend must expose generated file deletion");
assert(server.includes('"/api/images/:id"'), "backend must expose generated image deletion");
assert(server.includes("deleteGeneratedFileObject"), "conversation deletion must remove generated objects");
assert(server.includes("deleteChatImage"), "conversation deletion must remove image objects");
assert(server.includes("sanitizePublicPayload"), "browser responses must be sanitized");
assert(server.includes('"storage_path"'), "sanitizer must strip storage topology keys");
assert(server.includes('"provider_used"'), "sanitizer must strip provider keys");

console.log("Phase 0 emergency stabilization contracts passed.");
