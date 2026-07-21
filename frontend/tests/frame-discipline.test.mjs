import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  FRAME_DISCIPLINE_DEFAULTS,
  FRAME_DISCIPLINE_DOMAINS,
  FRAME_DISCIPLINE_VERSION,
  clampFrameValue,
  createFrameCoordinator,
  createFrameTaskKey,
  deriveAttachmentMetrics,
  deriveScrollAnchorState,
  deriveTextareaSizing,
  deriveViewportMetrics,
  normalizeFrameDomain,
  summarizeMutationRecords,
} from "../scripts/features/frame-discipline-state.mjs";

assert.equal(FRAME_DISCIPLINE_VERSION, "11.4");
assert.deepEqual(FRAME_DISCIPLINE_DOMAINS, [
  "textarea",
  "scroll",
  "sidebar",
  "viewport",
  "attachments",
  "streaming",
]);
assert.equal(FRAME_DISCIPLINE_DEFAULTS.scrollAnchorThresholdPx, 72);
assert.equal(clampFrameValue(120, 44, 96), 96);
assert.equal(clampFrameValue(20, 44, 96), 44);
assert.equal(normalizeFrameDomain("VIEWPORT"), "viewport");
assert.equal(normalizeFrameDomain("unknown"), "streaming");
assert.equal(createFrameTaskKey("sidebar", "measure"), "sidebar:measure");

assert.deepEqual(deriveTextareaSizing({
  scrollHeight: 180,
  minHeight: 44,
  maxHeight: 120,
}), {
  minHeight: 44,
  maxHeight: 120,
  naturalHeight: 180,
  height: 120,
  overflowing: true,
});
assert.equal(deriveTextareaSizing({ scrollHeight: 60, minHeight: 44, maxHeight: 120 }).height, 60);

const bottomAnchor = deriveScrollAnchorState({
  scrollTop: 720,
  scrollHeight: 1000,
  clientHeight: 240,
  threshold: 72,
  userInitiated: true,
});
assert.equal(bottomAnchor.atBottom, true);
assert.equal(bottomAnchor.pinned, true);
assert.equal(bottomAnchor.targetScrollTop, 760);

const readingAnchor = deriveScrollAnchorState({
  scrollTop: 300,
  scrollHeight: 1000,
  clientHeight: 240,
  threshold: 72,
  userInitiated: true,
});
assert.equal(readingAnchor.atBottom, false);
assert.equal(readingAnchor.pinned, false);
assert.equal(readingAnchor.targetScrollTop, 300);
assert.equal(deriveScrollAnchorState({
  scrollTop: 300,
  scrollHeight: 1100,
  clientHeight: 240,
  previousPinned: true,
}).targetScrollTop, 860);

const keyboardViewport = deriveViewportMetrics({
  layoutWidth: 390,
  layoutHeight: 844,
  visualWidth: 390,
  visualHeight: 520,
  offsetTop: 0,
});
assert.equal(keyboardViewport.orientation, "portrait");
assert.equal(keyboardViewport.keyboardInset, 324);
assert.equal(keyboardViewport.keyboardOpen, true);
assert.equal(deriveViewportMetrics({
  layoutWidth: 844,
  layoutHeight: 390,
  visualWidth: 844,
  visualHeight: 390,
}).orientation, "landscape");

assert.deepEqual(deriveAttachmentMetrics({
  previewHeight: 96,
  composerHeight: 174,
  itemCount: 5,
}), {
  previewHeight: 96,
  composerHeight: 174,
  itemCount: 5,
  visible: true,
  density: "dense",
});

assert.deepEqual(summarizeMutationRecords([
  { type: "childList", addedNodes: [1, 2], removedNodes: [1] },
  { type: "characterData" },
  { type: "attributes" },
]), {
  childList: 1,
  characterData: 1,
  attributes: 1,
  addedNodes: 2,
  removedNodes: 1,
});

const frames = [];
const cancelledFrames = new Set();
const timers = new Map();
let nextFrameId = 1;
let nextTimerId = 1;
const order = [];
const errors = [];

const coordinator = createFrameCoordinator({
  requestFrame(callback) {
    const id = nextFrameId++;
    frames.push({ id, callback });
    return id;
  },
  cancelFrame(id) {
    cancelledFrames.add(id);
  },
  setTimer(callback, delay) {
    const id = nextTimerId++;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimer(id) {
    timers.delete(id);
  },
  onError(error, context) {
    errors.push({ error, context });
  },
});

coordinator.measure("viewport", "shared", () => {
  order.push("stale-read");
  return "stale";
}, () => order.push("stale-write"));
coordinator.measure("viewport", "shared", () => {
  order.push("fresh-read");
  return "fresh";
}, (value) => order.push(`measured-write:${value}`));
coordinator.write("sidebar", "state", () => order.push("direct-write"));
assert.equal(frames.length, 1, "Keyed work should share one animation frame");
frames.shift().callback(16);
assert.deepEqual(order, ["fresh-read", "direct-write", "measured-write:fresh"]);
assert.equal(errors.length, 0);

coordinator.measure("textarea", "two-frame", () => {
  order.push("second-read");
  coordinator.write("textarea", "late-write", () => order.push("late-write"));
  return 1;
}, () => order.push("second-measured-write"));
frames.shift().callback(32);
assert.equal(order.includes("late-write"), false, "Writes scheduled during the read phase must wait for the next frame");
assert.equal(order.at(-1), "second-measured-write");
frames.shift().callback(48);
assert.equal(order.at(-1), "late-write");

let settledRuns = 0;
coordinator.debounce("viewport", "settled", () => {
  settledRuns += 1;
  coordinator.debounce("viewport", "settled", () => {
    settledRuns += 100;
  }, 120);
}, 120);
coordinator.debounce("viewport", "settled", () => {
  settledRuns += 1;
  coordinator.debounce("viewport", "settled", () => {
    settledRuns += 100;
  }, 120);
}, 120);
assert.equal(timers.size, 1, "Repeated settle work should debounce to one timer");
const settleTimer = [...timers.values()][0];
assert.equal(settleTimer.delay, 120);
timers.clear();
settleTimer.callback();
frames.shift().callback(64);
assert.equal(settledRuns, 1);
assert.equal(timers.size, 0, "A settle callback must not recursively re-arm itself");

coordinator.write("streaming", "chunk", () => order.push("cancelled-write"));
const scheduledBeforeFlush = frames[0]?.id;
coordinator.flushNow(80);
assert.ok(scheduledBeforeFlush && cancelledFrames.has(scheduledBeforeFlush));
assert.equal(order.at(-1), "cancelled-write");
assert.equal(coordinator.getState().frameScheduled, false);
coordinator.destroy();

const runtimeSource = await readFile(new URL("../scripts/features/frame-discipline.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const mobileComposerSource = await readFile(new URL("../scripts/features/mobile-composer.js", import.meta.url), "utf8");
const mobileNavigationSource = await readFile(new URL("../scripts/features/mobile-navigation.js", import.meta.url), "utf8");

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval("]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Frame discipline runtime must not own ${forbidden}`);
}

for (const token of [
  "createFrameCoordinator",
  'coordinator.write("textarea", "prepare"',
  'coordinator.measure("textarea", "measure"',
  'coordinator.measure("scroll", "anchor"',
  'coordinator.measure("sidebar", "measure"',
  'coordinator.measure("viewport", "measure"',
  'coordinator.measure("attachments", "measure"',
  'coordinator.measure("streaming", "frame"',
  "new MutationObserver(handleStreamMutations)",
  "new ResizeObserver",
  "listenPassive(chatMessages, \"scroll\"",
  "listenPassive(window.visualViewport, \"resize\"",
  "listenPassive(window.visualViewport, \"scroll\"",
  "scheduleStreamingUpdate",
  'new CustomEvent("sentiq-stream-frame"',
  "window.SentIQFrameDiscipline = Object.freeze",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

assert.ok(runtimeSource.includes("passive: true"));
assert.ok(runtimeSource.includes("programmaticScrollUntil"));
assert.ok(runtimeSource.includes("--sentiq-sidebar-measured-width"));
assert.ok(runtimeSource.includes("--sentiq-visual-viewport-height"));
assert.ok(runtimeSource.includes("--sentiq-attachment-preview-height"));
assert.ok(runtimeSource.includes("pendingStreamSummary"));

const frameImport = domRefsSource.indexOf('import "../frame-discipline.js";');
const navigationImport = domRefsSource.indexOf('import "../mobile-navigation.js";');
const composerImport = domRefsSource.indexOf('import "../mobile-composer.js";');
assert.ok(frameImport >= 0 && navigationImport > frameImport && composerImport > frameImport,
  "The shared coordinator must initialize before mobile navigation and composer schedulers");

for (const source of [mobileComposerSource, mobileNavigationSource]) {
  assert.ok(source.includes("requestAnimationFrame"));
  assert.ok(source.includes("passive: true"));
  assert.ok(source.includes("MutationObserver") || source.includes("ResizeObserver"));
}

console.log("Pass 11.4 JavaScript frame discipline gate passed: keyed read/write frames, passive viewport and scroll listeners, debounced settles, observer-backed attachment/sidebar measurement, and coalesced stream anchoring.");
