import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  LONG_CONVERSATION_DEFAULTS,
  LONG_CONVERSATION_VERSION,
  classifyMessageWindowIndex,
  createStableElementSignature,
  deriveMediaPolicy,
  deriveMessageWindow,
  deriveRehydrationTarget,
  deriveScrollSnapshot,
  deriveSidebarHistoryWindow,
} from "../scripts/features/long-conversation-state.mjs";

assert.equal(LONG_CONVERSATION_VERSION, "11.5");
assert.equal(LONG_CONVERSATION_DEFAULTS.activationMessageCount, 48);
assert.equal(LONG_CONVERSATION_DEFAULTS.retainedTailMessages, 24);

const shortWindow = deriveMessageWindow({ count: 24 });
assert.equal(shortWindow.windowed, false);
assert.equal(shortWindow.activeCount, 24);
assert.equal(classifyMessageWindowIndex(3, shortWindow), "active");

const longWindow = deriveMessageWindow({
  count: 160,
  firstVisibleIndex: 42,
  lastVisibleIndex: 47,
  overscan: 8,
  tailCount: 24,
});
assert.deepEqual(longWindow, {
  count: 160,
  windowed: true,
  activeStart: 34,
  activeEnd: 55,
  tailStart: 136,
  activeCount: 46,
  deferredCount: 114,
});
assert.equal(classifyMessageWindowIndex(40, longWindow), "active");
assert.equal(classifyMessageWindowIndex(30, longWindow), "buffer");
assert.equal(classifyMessageWindowIndex(90, longWindow), "deferred");
assert.equal(classifyMessageWindowIndex(150, longWindow), "tail");

const tailWindow = deriveMessageWindow({
  count: 100,
  firstVisibleIndex: 92,
  lastVisibleIndex: 99,
  overscan: 8,
  tailCount: 24,
});
assert.equal(tailWindow.activeStart, 84);
assert.equal(tailWindow.activeEnd, 99);
assert.equal(tailWindow.tailStart, 76);
assert.equal(tailWindow.activeCount, 24);
assert.equal(tailWindow.deferredCount, 76);

assert.deepEqual(deriveSidebarHistoryWindow({ count: 20 }), {
  count: 20,
  windowed: false,
  start: 0,
  end: 19,
});
assert.deepEqual(deriveSidebarHistoryWindow({
  count: 90,
  firstVisibleIndex: 30,
  lastVisibleIndex: 40,
  overscan: 10,
}), {
  count: 90,
  windowed: true,
  start: 20,
  end: 50,
});

assert.deepEqual(deriveMediaPolicy({ latest: false, nearViewport: false, decoded: false }), {
  loading: "lazy",
  decoding: "async",
  fetchPriority: "low",
  shouldDecode: false,
  videoPreload: "none",
  frameState: "deferred",
});
assert.deepEqual(deriveMediaPolicy({ latest: true, nearViewport: true, decoded: false }), {
  loading: "eager",
  decoding: "async",
  fetchPriority: "high",
  shouldDecode: true,
  videoPreload: "metadata",
  frameState: "near",
});
assert.equal(deriveMediaPolicy({ nearViewport: true, decoded: true }).frameState, "decoded");

const readingSnapshot = deriveScrollSnapshot({
  scrollTop: 420,
  scrollHeight: 1800,
  clientHeight: 600,
});
assert.equal(readingSnapshot.pinnedToBottom, false);
assert.equal(readingSnapshot.maximumScrollTop, 1200);
assert.equal(readingSnapshot.distanceFromBottom, 780);
assert.equal(readingSnapshot.ratio, 0.35);

const bottomSnapshot = deriveScrollSnapshot({
  scrollTop: 1120,
  scrollHeight: 1800,
  clientHeight: 600,
});
assert.equal(bottomSnapshot.pinnedToBottom, true);
assert.equal(deriveRehydrationTarget({
  snapshot: bottomSnapshot,
  scrollHeight: 2400,
  clientHeight: 600,
}), 1800);
assert.equal(deriveRehydrationTarget({
  snapshot: { ...readingSnapshot, anchorOffset: 40 },
  currentScrollTop: 500,
  anchorTop: 70,
  scrollHeight: 2200,
  clientHeight: 600,
}), 530);
assert.equal(deriveRehydrationTarget({
  snapshot: { scrollTop: 420, ratio: 0.35, pinnedToBottom: false },
  scrollHeight: 2200,
  clientHeight: 600,
}), 420);

assert.equal(createStableElementSignature({ requestId: "request-1", text: "ignored" }), "request-1");
assert.equal(createStableElementSignature({ role: "assistant", text: "  A   stable\nanswer  " }), "assistant:A stable answer");

const runtimeSource = await readFile(new URL("../scripts/features/long-conversation-optimizer.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/76-long-conversation-optimisation.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const cssImportsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");

for (const token of [
  "deriveMessageWindow",
  "deriveSidebarHistoryWindow",
  "deriveMediaPolicy",
  "deriveRehydrationTarget",
  "new IntersectionObserver",
  "new MutationObserver",
  "new ResizeObserver",
  "messageObserver",
  "mediaObserver",
  "citationObserver",
  "historyObserver",
  'rootMargin: "1200px 0px"',
  'rootMargin: "900px 0px"',
  "media.decode()",
  'media.loading = "lazy"',
  'media.decoding = "async"',
  "media.loading = policy.loading",
  "media.preload = policy.videoPreload",
  "captureConversationSnapshot",
  "restoreConversationSnapshot",
  "citationExpansion",
  "scheduleMessageWindow",
  "scheduleHistoryWindow",
  "sentiq-long-conversation-change",
  "window.SentIQLongConversation = Object.freeze",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "innerHTML = message"]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Optimizer must not own ${forbidden}`);
}

assert.ok(runtimeSource.includes("passive: true"));
assert.ok(runtimeSource.includes("window.SentIQFrameDiscipline"));
assert.ok(runtimeSource.includes("scheduleScrollAnchor"));
assert.ok(runtimeSource.includes("pinnedToBottom"));
assert.ok(runtimeSource.includes("ACTIVE_HISTORY_SELECTOR"));

for (const token of [
  "content-visibility: auto",
  "contain-intrinsic-size",
  'data-long-conversation-window="deferred"',
  'data-history-render="deferred"',
  'data-citation-render="collapsed"',
  'data-media-frame-state="deferred"',
  'data-conversation-rehydration="pending"',
]) assert.ok(cssSource.includes(token), `CSS missing ${token}`);

assert.ok(domRefsSource.includes('import "../long-conversation-optimizer.js";'));
assert.ok(cssImportsSource.includes('@import url("./76-long-conversation-optimisation.css");'));
const frameImport = domRefsSource.indexOf('import "../frame-discipline.js";');
const optimizerImport = domRefsSource.indexOf('import "../long-conversation-optimizer.js";');
const mobileNavigationImport = domRefsSource.indexOf('import "../mobile-navigation.js";');
assert.ok(frameImport >= 0 && optimizerImport > frameImport && mobileNavigationImport > optimizerImport,
  "Long conversation optimisation must initialize after frame discipline and before mobile navigation");

console.log("Pass 11.5 long conversation optimisation gate passed: browser-native message and history windowing, offscreen rendering, lazy decoded media, citation expansion preservation, scroll snapshots, and conversation rehydration are covered.");
