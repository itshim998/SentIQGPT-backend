import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ATTENTION_MANAGEMENT_VERSION,
  ATTENTION_DEDUPE_WINDOW_MS,
  MAX_ATTENTION_QUEUE,
  attentionSignalKey,
  classifyMessageOutcome,
  coalesceAttentionQueue,
  deriveLatestChatOutcome,
  deriveOutcomeSignal,
  normalizeAttentionSignal,
  pruneRecentSignals,
  rememberAcceptedSignal,
  shouldAcceptSignal,
} from "../scripts/features/attention-management-model.mjs";

assert.equal(ATTENTION_MANAGEMENT_VERSION, "9.5");
assert.equal(MAX_ATTENTION_QUEUE, 3);

const now = Date.parse("2026-07-21T12:00:00.000Z");
const response = classifyMessageOutcome({
  id: "response-1",
  role: "assistant",
  content: "The completed answer.",
  timestamp: new Date(now - 5_000).toISOString(),
  meta: { responseStatus: "complete" },
}, now);
assert.equal(response.kind, "response-complete");

assert.equal(classifyMessageOutcome({
  id: "response-running",
  role: "assistant",
  content: "Partial",
  timestamp: new Date(now - 4_000).toISOString(),
  meta: { responseStatus: "generating", streaming: true },
}, now), null);
assert.equal(classifyMessageOutcome({
  id: "response-stopped",
  role: "assistant",
  content: "Partial",
  timestamp: new Date(now - 4_000).toISOString(),
  meta: { responseStatus: "stopped" },
}, now), null);

const research = classifyMessageOutcome({
  id: "research-1",
  role: "assistant",
  content: "Research report",
  timestamp: new Date(now - 3_000).toISOString(),
  meta: { type: "deep-research", reportId: "report-1", status: "complete" },
}, now);
assert.equal(research.kind, "research-complete");
assert.equal(classifyMessageOutcome({
  role: "assistant",
  content: "Research report",
  meta: { type: "deep-research", reportId: "report-2", status: "running" },
}, now), null);

const image = classifyMessageOutcome({
  id: "image-1",
  role: "assistant",
  content: "Generated image",
  timestamp: new Date(now - 2_000).toISOString(),
  meta: { type: "image", image_url: "https://example.com/image.png", success: true },
}, now);
assert.equal(image.kind, "image-complete");
assert.equal(classifyMessageOutcome({
  id: "image-failed",
  role: "assistant",
  content: "Image failed",
  meta: { type: "image", success: false, status: "failed" },
}, now), null);

const fileFailure = classifyMessageOutcome({
  id: "file-1",
  role: "assistant",
  content: "Could not analyse notes.pdf",
  timestamp: new Date(now - 1_000).toISOString(),
  meta: { type: "file-analysis", status: "failed", filename: "notes.pdf" },
}, now);
assert.equal(fileFailure.kind, "file-analysis-failed");
assert.match(fileFailure.detail, /notes\.pdf/);

assert.equal(classifyMessageOutcome({
  id: "generated-file-1",
  role: "assistant",
  content: "Document created",
  meta: { type: "generated-file", status: "complete" },
}, now), null, "generated files do not masquerade as ordinary response completion");

const latest = deriveLatestChatOutcome({
  id: "chat-a",
  messages: [
    { id: "old", role: "assistant", content: "Old answer", timestamp: new Date(now - 10_000).toISOString() },
    { id: "new", role: "assistant", content: "New answer", timestamp: new Date(now - 1_000).toISOString() },
  ],
}, now);
assert.match(latest.signature, /new/);

const previous = { kind: "response-complete", signature: "response:old", updatedAt: now - 10_000 };
const next = { kind: "response-complete", signature: "response:new", updatedAt: now - 1_000 };
assert.equal(deriveOutcomeSignal(previous, next, { chatId: "chat-a", active: true }), null);
assert.equal(deriveOutcomeSignal(previous, next, { chatId: "chat-a", active: false }).kind, "response-complete");
assert.equal(deriveOutcomeSignal(previous, research, { chatId: "chat-a", active: true }).kind, "research-complete");
assert.equal(deriveOutcomeSignal(null, next, { chatId: "chat-a", active: false }), null, "initial baselines do not notify");
assert.equal(deriveOutcomeSignal(next, next, { chatId: "chat-a", active: false }), null, "unchanged snapshots do not notify");

const signal = normalizeAttentionSignal({
  kind: "image-complete",
  chatId: "chat-b",
  signature: "image:1",
  updatedAt: now,
});
assert.equal(signal.title, "Image ready");
assert.equal(attentionSignalKey(signal), "image-complete:chat-b:image:1");

const recent = new Map();
assert.equal(shouldAcceptSignal(signal, recent, now), true);
rememberAcceptedSignal(signal, recent, now);
assert.equal(shouldAcceptSignal(signal, recent, now + 1), false);
assert.equal(shouldAcceptSignal({ ...signal, signature: "image:2" }, recent, now + ATTENTION_DEDUPE_WINDOW_MS - 1), false);
assert.equal(shouldAcceptSignal({ ...signal, signature: "image:2" }, recent, now + ATTENTION_DEDUPE_WINDOW_MS), true);
pruneRecentSignals(recent, now + ATTENTION_DEDUPE_WINDOW_MS * 4);
assert.equal(recent.size, 0);

let queue = [];
queue = coalesceAttentionQueue(queue, { kind: "response-complete", chatId: "chat-a", signature: "1" });
queue = coalesceAttentionQueue(queue, { kind: "image-complete", chatId: "chat-b", signature: "2" });
queue = coalesceAttentionQueue(queue, { kind: "research-complete", chatId: "chat-c", signature: "3" });
queue = coalesceAttentionQueue(queue, { kind: "file-analysis-failed", chatId: "chat-d", signature: "4" });
assert.equal(queue.length, MAX_ATTENTION_QUEUE);
assert.deepEqual(queue.map((item) => item.chatId), ["chat-b", "chat-c", "chat-d"]);
queue = coalesceAttentionQueue(queue, { kind: "image-complete", chatId: "chat-b", signature: "5" });
assert.equal(queue.length, MAX_ATTENTION_QUEUE);
assert.equal(queue.at(-1).signature, "5");
assert.equal(queue.filter((item) => item.chatId === "chat-b").length, 1);

const modelSource = await readFile(new URL("../scripts/features/attention-management-model.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../scripts/features/attention-management.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/61-attention-management.css", import.meta.url), "utf8");
const responsiveSource = await readFile(new URL("../styles/modules/62-attention-management-responsive.css", import.meta.url), "utf8");
const combinedCss = `${cssSource}\n${responsiveSource}`;

for (const forbidden of ["document.", "window.", "localStorage", "sessionStorage", "indexedDB", "fetch("]) {
  assert.equal(modelSource.includes(forbidden), false, `Pure attention model must not own ${forbidden}`);
}
for (const forbidden of ["Notification", "new Audio", "navigator.vibrate", "window.confirm", "localStorage", "sessionStorage", "indexedDB", "fetch("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Attention runtime must avoid noisy or unrelated ownership: ${forbidden}`);
}
assert.equal(runtimeSource.includes('window.addEventListener("resize"'), false, "Viewport changes must remain CSS-only");
for (const forbiddenModeHook of ["#image-gen-btn", "#deep-research-btn", "#websurf-basic-btn", "data-execution-mode"]) {
  assert.equal(runtimeSource.includes(forbiddenModeHook), false, `Mode changes must not create attention signals: ${forbiddenModeHook}`);
}

for (const token of [
  'const CHAT_POLL_INTERVAL_MS = 4_000',
  'const OFFLINE_CONFIRM_DELAY_MS = 1_200',
  'const DOM_BASELINE_WINDOW_MS = 1_200',
  'role", "status"',
  'aria-live", "polite"',
  'aria-atomic", "true"',
  'className = "conversation-attention-marker"',
  'attentionByChat.delete(id)',
  'deriveLatestChatOutcome(chat, now)',
  'deriveOutcomeSignal(previousOutcome, nextOutcome',
  'if (baselineReady)',
  'epoch !== scopeEpoch || currentScope() !== scope',
  'document.visibilityState === "hidden"',
  'sentiq-conversation-continuity-restored',
  'sentiq-conversation-activity-change',
  'sentiq-auth-changed',
  'scopeEpoch += 1',
  'baselineActiveDom()',
  'Date.now() > domBaselineUntil',
  'window.addEventListener("offline", confirmOffline)',
  'window.addEventListener("online", handleOnline)',
  'kind: "connection-recovered"',
  'kind: "file-analysis-failed"',
  'kind: "image-complete"',
  'window.SentIQAttentionManagement = Object.freeze',
]) assert.ok(runtimeSource.includes(token), `Attention runtime missing ${token}`);

assert.ok(
  domRefsSource.indexOf('import "../conversation-continuity-event-bridge.js";')
    < domRefsSource.indexOf('import "../attention-management.js";'),
  "Attention management must initialize after conversation continuity",
);
assert.ok(importsSource.includes('@import url("./61-attention-management.css");'));
assert.ok(importsSource.includes('@import url("./62-attention-management-responsive.css");'));

for (const token of [
  ':root[data-attention-management-version="9.5"]',
  ".conversation-attention-marker",
  ".conversation-attention-dot",
  ".sentiq-attention-status",
  '[data-attention-kind="research-complete"]',
  '[data-attention-kind="image-complete"]',
  '[data-attention-kind="file-analysis-failed"]',
  '[data-attention-kind="connection-recovered"]',
  "safe-area-inset-top",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(combinedCss.includes(token), `Attention CSS missing ${token}`);
assert.equal(/animation[^;]*infinite/i.test(combinedCss), false, "Attention signals must not animate continuously");

console.log("Pass 9.5 attention management phase gate passed.");
