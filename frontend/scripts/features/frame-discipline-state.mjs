/* SentIQ Chat — Pass 11.4 JavaScript frame discipline state */

export const FRAME_DISCIPLINE_VERSION = "11.4";

export const FRAME_DISCIPLINE_DOMAINS = Object.freeze([
  "textarea",
  "scroll",
  "sidebar",
  "viewport",
  "attachments",
  "streaming",
]);

export const FRAME_DISCIPLINE_DEFAULTS = Object.freeze({
  scrollAnchorThresholdPx: 72,
  viewportSettleMs: 120,
  sidebarSettleMs: 110,
  attachmentSettleMs: 80,
  textareaFallbackMinPx: 44,
  textareaFallbackMaxPx: 240,
});

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clampFrameValue(value, minimum, maximum) {
  const min = finiteNumber(minimum, 0);
  const max = Math.max(min, finiteNumber(maximum, min));
  return Math.min(max, Math.max(min, finiteNumber(value, min)));
}

export function normalizeFrameDomain(value) {
  const domain = String(value || "").trim().toLowerCase();
  return FRAME_DISCIPLINE_DOMAINS.includes(domain) ? domain : "streaming";
}

export function createFrameTaskKey(domain, key = "default") {
  return `${normalizeFrameDomain(domain)}:${String(key || "default")}`;
}

export function deriveTextareaSizing(input = {}) {
  const minimum = Math.max(1, finiteNumber(
    input.minHeight,
    FRAME_DISCIPLINE_DEFAULTS.textareaFallbackMinPx,
  ));
  const maximum = Math.max(minimum, finiteNumber(
    input.maxHeight,
    FRAME_DISCIPLINE_DEFAULTS.textareaFallbackMaxPx,
  ));
  const naturalHeight = Math.max(minimum, finiteNumber(input.scrollHeight, minimum));
  const height = clampFrameValue(naturalHeight, minimum, maximum);
  return Object.freeze({
    minHeight: minimum,
    maxHeight: maximum,
    naturalHeight,
    height,
    overflowing: naturalHeight > maximum + 0.5,
  });
}

export function deriveScrollAnchorState(input = {}) {
  const scrollTop = Math.max(0, finiteNumber(input.scrollTop, 0));
  const scrollHeight = Math.max(0, finiteNumber(input.scrollHeight, 0));
  const clientHeight = Math.max(0, finiteNumber(input.clientHeight, 0));
  const threshold = Math.max(0, finiteNumber(
    input.threshold,
    FRAME_DISCIPLINE_DEFAULTS.scrollAnchorThresholdPx,
  ));
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  const distanceFromBottom = Math.max(0, maximumScrollTop - scrollTop);
  const atBottom = distanceFromBottom <= threshold;
  const pinned = input.userInitiated
    ? atBottom
    : (typeof input.previousPinned === "boolean" ? input.previousPinned : atBottom);
  return Object.freeze({
    scrollTop,
    scrollHeight,
    clientHeight,
    maximumScrollTop,
    distanceFromBottom,
    atBottom,
    pinned,
    targetScrollTop: pinned ? maximumScrollTop : scrollTop,
  });
}

export function deriveViewportMetrics(input = {}) {
  const layoutWidth = Math.max(1, finiteNumber(input.layoutWidth, 1));
  const layoutHeight = Math.max(1, finiteNumber(input.layoutHeight, 1));
  const visualWidth = Math.max(1, finiteNumber(input.visualWidth, layoutWidth));
  const visualHeight = Math.max(1, finiteNumber(input.visualHeight, layoutHeight));
  const offsetTop = Math.max(0, finiteNumber(input.offsetTop, 0));
  const offsetLeft = Math.max(0, finiteNumber(input.offsetLeft, 0));
  const keyboardInset = Math.max(0, layoutHeight - visualHeight - offsetTop);
  const orientation = visualWidth > visualHeight ? "landscape" : "portrait";
  return Object.freeze({
    layoutWidth,
    layoutHeight,
    visualWidth,
    visualHeight,
    offsetTop,
    offsetLeft,
    keyboardInset,
    orientation,
    keyboardOpen: keyboardInset >= Math.min(160, layoutHeight * 0.2),
  });
}

export function deriveAttachmentMetrics(input = {}) {
  const previewHeight = Math.max(0, finiteNumber(input.previewHeight, 0));
  const composerHeight = Math.max(0, finiteNumber(input.composerHeight, 0));
  const itemCount = Math.max(0, Math.floor(finiteNumber(input.itemCount, 0)));
  return Object.freeze({
    previewHeight,
    composerHeight,
    itemCount,
    visible: itemCount > 0 && previewHeight > 0,
    density: itemCount >= 4 ? "dense" : (itemCount > 0 ? "normal" : "empty"),
  });
}

export function summarizeMutationRecords(records = []) {
  let childList = 0;
  let characterData = 0;
  let attributes = 0;
  let addedNodes = 0;
  let removedNodes = 0;

  for (const record of Array.from(records || [])) {
    if (!record) continue;
    if (record.type === "childList") {
      childList += 1;
      addedNodes += record.addedNodes?.length || 0;
      removedNodes += record.removedNodes?.length || 0;
    } else if (record.type === "characterData") {
      characterData += 1;
    } else if (record.type === "attributes") {
      attributes += 1;
    }
  }

  return Object.freeze({ childList, characterData, attributes, addedNodes, removedNodes });
}

export function createFrameCoordinator(options = {}) {
  const requestFrame = options.requestFrame
    || ((callback) => globalThis.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame
    || ((handle) => globalThis.cancelAnimationFrame(handle));
  const setTimer = options.setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((handle) => globalThis.clearTimeout(handle));
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  let pendingReads = new Map();
  let pendingWrites = new Map();
  const timers = new Map();
  let frameHandle = 0;
  let flushing = false;
  let phase = "idle";
  let flushCount = 0;

  function hasPendingWork() {
    return pendingReads.size > 0 || pendingWrites.size > 0;
  }

  function ensureFrame() {
    if (frameHandle || !hasPendingWork()) return;
    frameHandle = requestFrame(flush);
  }

  function report(error, context) {
    try { onError(error, context); } catch { /* error reporting must not break the frame */ }
  }

  function flush(timestamp = 0) {
    frameHandle = 0;
    if (flushing) return;
    flushing = true;
    flushCount += 1;

    const reads = pendingReads;
    const writes = pendingWrites;
    pendingReads = new Map();
    pendingWrites = new Map();

    phase = "read";
    for (const [key, task] of reads) {
      try {
        const result = task.read(timestamp);
        if (typeof task.write === "function") {
          writes.set(key, () => task.write(result, timestamp));
        }
      } catch (error) {
        report(error, { phase, key });
      }
    }

    phase = "write";
    for (const [key, write] of writes) {
      try { write(timestamp); } catch (error) { report(error, { phase, key }); }
    }

    phase = "idle";
    flushing = false;
    ensureFrame();
  }

  function scheduleRead(domain, key, read, write) {
    if (typeof read !== "function") return () => {};
    const taskKey = createFrameTaskKey(domain, key);
    pendingReads.set(taskKey, { read, write });
    ensureFrame();
    return () => pendingReads.delete(taskKey);
  }

  function scheduleWrite(domain, key, write) {
    if (typeof write !== "function") return () => {};
    const taskKey = createFrameTaskKey(domain, key);
    pendingWrites.set(taskKey, write);
    ensureFrame();
    return () => pendingWrites.delete(taskKey);
  }

  function debounce(domain, key, callback, delay = 0) {
    const taskKey = createFrameTaskKey(domain, key);
    const previous = timers.get(taskKey);
    if (previous) clearTimer(previous);
    const handle = setTimer(() => {
      timers.delete(taskKey);
      scheduleWrite(domain, key, callback);
    }, Math.max(0, finiteNumber(delay, 0)));
    timers.set(taskKey, handle);
    return () => {
      const active = timers.get(taskKey);
      if (active) clearTimer(active);
      timers.delete(taskKey);
    };
  }

  function cancel(domain, key) {
    const taskKey = createFrameTaskKey(domain, key);
    pendingReads.delete(taskKey);
    pendingWrites.delete(taskKey);
    const timer = timers.get(taskKey);
    if (timer) clearTimer(timer);
    timers.delete(taskKey);
  }

  function destroy() {
    if (frameHandle) cancelFrame(frameHandle);
    frameHandle = 0;
    pendingReads.clear();
    pendingWrites.clear();
    timers.forEach((timer) => clearTimer(timer));
    timers.clear();
    phase = "idle";
    flushing = false;
  }

  return Object.freeze({
    read: scheduleRead,
    measure: scheduleRead,
    write: scheduleWrite,
    debounce,
    cancel,
    flushNow: flush,
    destroy,
    getState: () => Object.freeze({
      phase,
      flushing,
      flushCount,
      pendingReads: pendingReads.size,
      pendingWrites: pendingWrites.size,
      pendingDebounces: timers.size,
      frameScheduled: Boolean(frameHandle),
    }),
  });
}
