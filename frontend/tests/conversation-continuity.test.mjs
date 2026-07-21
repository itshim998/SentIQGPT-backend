import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CONVERSATION_CONTINUITY_VERSION,
  MAX_CONTINUITY_RECORDS,
  RESEARCH_ACTIVITY_STALE_MS,
  STREAMING_ACTIVITY_STALE_MS,
  captureReadingRecord,
  deriveConversationActivity,
  draftRecordHasContent,
  draftRecordIsMeaningful,
  isMeaningfulText,
  normalizeContinuityRegistry,
  normalizeDraftRecord,
  normalizeModeSnapshot,
  removeConversationContinuity,
  resolveRestoredScrollTop,
  updateRegistryDraft,
  updateRegistryReading,
} from "../scripts/features/conversation-continuity-model.mjs";

assert.equal(CONVERSATION_CONTINUITY_VERSION, "9.4");
assert.deepEqual(normalizeModeSnapshot({ toolMode: "image", executionMode: "intuitive" }), {
  toolMode: "image",
  executionMode: "intuitive",
});
assert.deepEqual(normalizeModeSnapshot({ toolMode: "invalid", executionMode: "invalid" }), {
  toolMode: "none",
  executionMode: "fast",
});

assert.equal(isMeaningfulText(""), false);
assert.equal(isMeaningfulText("?"), false);
assert.equal(isMeaningfulText("ok"), true);
assert.equal(isMeaningfulText("👍"), true);
assert.equal(isMeaningfulText("line\n"), true);
assert.equal(draftRecordHasContent({ text: "", mode: { toolMode: "none" } }), false);
assert.equal(draftRecordHasContent({ text: "", mode: { toolMode: "deep-research" } }), true);
assert.equal(draftRecordIsMeaningful({ text: "?", mode: { toolMode: "none" } }), false);
assert.equal(draftRecordIsMeaningful({ text: "?" }, { hasAttachments: true }), true);

let registry = normalizeContinuityRegistry({ updatedAt: 1 });
registry = updateRegistryDraft(registry, "chat-a", {
  text: "Continue the architecture review",
  mode: { toolMode: "deep-research", executionMode: "intuitive" },
  updatedAt: 10,
});
registry = updateRegistryDraft(registry, "chat-b", {
  text: "Image prompt",
  mode: { toolMode: "image", executionMode: "fast" },
  updatedAt: 20,
});
assert.equal(registry.drafts["chat-a"].text, "Continue the architecture review");
assert.deepEqual(registry.drafts["chat-a"].mode, { toolMode: "deep-research", executionMode: "intuitive" });
assert.deepEqual(registry.drafts["chat-b"].mode, { toolMode: "image", executionMode: "fast" });
registry = updateRegistryDraft(registry, "chat-a", {
  text: "",
  mode: { toolMode: "none", executionMode: "intuitive" },
  updatedAt: 30,
});
assert.equal(registry.drafts["chat-a"], undefined, "clearing text and tool mode removes the draft");

const oversized = {};
for (let index = 0; index < MAX_CONTINUITY_RECORDS + 9; index += 1) {
  oversized[`chat-${index}`] = normalizeDraftRecord({ text: `draft ${index}`, updatedAt: index + 1 });
}
const bounded = normalizeContinuityRegistry({ drafts: oversized, updatedAt: 100 });
assert.equal(Object.keys(bounded.drafts).length, MAX_CONTINUITY_RECORDS);
assert.ok(bounded.drafts[`chat-${MAX_CONTINUITY_RECORDS + 8}`]);
assert.equal(bounded.drafts["chat-0"], undefined);

const readingMiddle = captureReadingRecord({
  scrollTop: 640,
  scrollHeight: 2200,
  clientHeight: 700,
  anchorFromEnd: 4,
  anchorOffset: -18,
  updatedAt: 100,
});
assert.equal(readingMiddle.atBottom, false);
assert.equal(readingMiddle.maxScrollTop, 1500);
assert.equal(readingMiddle.anchorFromEnd, 4);
assert.equal(resolveRestoredScrollTop(readingMiddle, {
  scrollHeight: 2600,
  clientHeight: 700,
  anchorOffsetTop: 900,
}), 882);
assert.equal(resolveRestoredScrollTop(readingMiddle, {
  scrollHeight: 2600,
  clientHeight: 700,
}), readingMiddle.ratio * 1900);

const readingBottom = captureReadingRecord({
  scrollTop: 1430,
  scrollHeight: 2200,
  clientHeight: 700,
  updatedAt: 200,
});
assert.equal(readingBottom.atBottom, true);
assert.equal(resolveRestoredScrollTop(readingBottom, { scrollHeight: 3000, clientHeight: 800 }), 2200);
registry = updateRegistryReading(registry, "chat-b", readingMiddle);
assert.equal(registry.reading["chat-b"].anchorFromEnd, 4);
registry = removeConversationContinuity(registry, "chat-b");
assert.equal(registry.drafts["chat-b"], undefined);
assert.equal(registry.reading["chat-b"], undefined);

const now = Date.parse("2026-07-21T10:00:00.000Z");
const freshStreaming = deriveConversationActivity({
  messages: [{ timestamp: new Date(now - 1_000).toISOString(), meta: { streaming: true, responseStatus: "generating" } }],
}, now);
assert.equal(freshStreaming.type, "streaming");
assert.equal(deriveConversationActivity({
  messages: [{ timestamp: new Date(now - STREAMING_ACTIVITY_STALE_MS - 1).toISOString(), meta: { streaming: true } }],
}, now), null);

const runningResearch = deriveConversationActivity({
  messages: [{ timestamp: new Date(now - 2_000).toISOString(), meta: { type: "deep-research", reportId: "r1", status: "running" } }],
}, now);
assert.equal(runningResearch.type, "research");
assert.equal(deriveConversationActivity({
  messages: [
    { timestamp: new Date(now - 5_000).toISOString(), meta: { type: "deep-research", reportId: "r1", status: "running" } },
    { timestamp: new Date(now - 1_000).toISOString(), meta: { type: "deep-research", reportId: "r1", status: "complete" } },
  ],
}, now), null, "a newer settled report suppresses its older running record");
assert.equal(deriveConversationActivity({
  messages: [{ timestamp: new Date(now - RESEARCH_ACTIVITY_STALE_MS - 1).toISOString(), meta: { type: "deep-research", reportId: "r2", status: "running" } }],
}, now), null);
assert.equal(deriveConversationActivity({ pending_server_sync: true, messages: [] }, now).type, "syncing");

const modelSource = await readFile(new URL("../scripts/features/conversation-continuity-model.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../scripts/features/conversation-continuity.js", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("../scripts/features/conversation-continuity-dialog.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/59-conversation-continuity.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/60-conversation-continuity-responsive.css", import.meta.url), "utf8");
const combinedCss = `${cssSource}\n${responsiveSource}`;

for (const forbidden of ["document.", "window.", "localStorage", "sessionStorage", "indexedDB", "fetch("]) {
  assert.equal(modelSource.includes(forbidden), false, `Pure continuity model must not own ${forbidden}`);
}
for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "XMLHttpRequest", "fetch(", "window.confirm", "globalThis.confirm"]) {
  assert.equal(`${runtimeSource}\n${dialogSource}`.includes(forbidden), false, `Continuity runtime must not own ${forbidden}`);
}

for (const token of [
  'const REGISTRY_PREFIX = "conversation_continuity:v1:"',
  'const LAST_ACTIVE_CHAT_PREFIX = "last_active_chat_id:"',
  'const GUEST_CONVERSATION_ID = "guest-current"',
  "Storage.getConfig(registryKey(requestedScope))",
  "Storage.setConfig(registryKey(targetScope), snapshot)",
  'chatInput?.addEventListener("input"',
  'chatMessages?.addEventListener("scroll"',
  'const conversationId = currentConversationId;',
  "restoreToolMode(storedRecord?.mode.toolMode || \"none\")",
  "if (storedRecord) restoreExecutionMode",
  'window.SentIQCapabilities?.get?.(key)',
  "resolveRestoredScrollTop",
  'chatList?.querySelector(".chat-list-item.active[data-id]")',
  "deriveConversationActivity(chat, now)",
  'marker.className = "conversation-activity-indicator"',
  'marker.className = "conversation-draft-marker"',
  'sendButton?.classList.contains("is-stop")',
  "sendButton.click()",
  'document.documentElement.dataset.continuityStreamingIsolation = "stopped-before-navigation"',
  'document.addEventListener("click", handleGuardedClick, true)',
  "replayBypass.has(request.control)",
  "scheduleDeletedConversationCleanup",
  'window.addEventListener("beforeunload"',
  'window.addEventListener("pagehide"',
  "!existingHasContent && !nextHasContent",
  "window.SentIQConversationContinuity = Object.freeze",
]) assert.ok(runtimeSource.includes(token), `Continuity runtime missing ${token}`);

for (const token of [
  'role="alertdialog"',
  'aria-modal="true"',
  'event.key === "Escape"',
  'event.key !== "Tab"',
  'data-continuity-cancel',
  'document.body.classList.add("sentiq-continuity-confirmation-open")',
]) assert.ok(dialogSource.includes(token), `Continuity dialog missing ${token}`);

assert.ok(domRefsSource.indexOf('import "../capability-awareness.js";') < domRefsSource.indexOf('import "../conversation-continuity.js";'));
assert.ok(importsSource.includes('@import url("./59-conversation-continuity.css");'));
assert.ok(importsSource.includes('@import url("./60-conversation-continuity-responsive.css");'));

for (const token of [
  'data-conversation-continuity-version="9.4"',
  ".conversation-draft-marker",
  ".conversation-activity-indicator",
  ".sentiq-continuity-confirmation-panel",
  'data-intent="danger"',
  "safe-area-inset-bottom",
  "overscroll-behavior: contain",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(combinedCss.includes(token), `Continuity CSS missing ${token}`);

console.log("Pass 9.4 conversation continuity phase gate passed.");
