/* SentIQ Chat — Pass 11.5 long conversation optimisation state */

export const LONG_CONVERSATION_VERSION = "11.5";

export const LONG_CONVERSATION_DEFAULTS = Object.freeze({
  activationMessageCount: 48,
  messageOverscan: 8,
  retainedTailMessages: 24,
  sidebarActivationCount: 36,
  sidebarOverscan: 10,
  nearBottomThresholdPx: 120,
  messageIntrinsicSizePx: 180,
  citationIntrinsicSizePx: 220,
  historyIntrinsicSizePx: 52,
  rehydrateSettleMs: 180,
});

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

export function clampLongConversationValue(value, minimum, maximum) {
  const min = finite(minimum, 0);
  const max = Math.max(min, finite(maximum, min));
  return Math.min(max, Math.max(min, finite(value, min)));
}

export function deriveMessageWindow(input = {}) {
  const count = integer(input.count);
  const threshold = Math.max(1, integer(
    input.threshold,
    LONG_CONVERSATION_DEFAULTS.activationMessageCount,
  ));
  const overscan = integer(input.overscan, LONG_CONVERSATION_DEFAULTS.messageOverscan);
  const tailCount = integer(input.tailCount, LONG_CONVERSATION_DEFAULTS.retainedTailMessages);
  const windowed = count >= threshold;
  if (!count || !windowed) {
    return Object.freeze({
      count,
      windowed: false,
      activeStart: 0,
      activeEnd: Math.max(0, count - 1),
      tailStart: 0,
      activeCount: count,
      deferredCount: 0,
    });
  }

  const lastIndex = count - 1;
  const firstVisible = clampLongConversationValue(
    integer(input.firstVisibleIndex, Math.max(0, lastIndex - tailCount)),
    0,
    lastIndex,
  );
  const lastVisible = clampLongConversationValue(
    integer(input.lastVisibleIndex, firstVisible),
    firstVisible,
    lastIndex,
  );
  const tailStart = Math.max(0, count - tailCount);
  const activeStart = Math.max(0, firstVisible - overscan);
  const activeEnd = Math.min(lastIndex, lastVisible + overscan);
  const visibleWindowCount = Math.max(0, activeEnd - activeStart + 1);
  const tailOverlap = Math.max(0, activeEnd - Math.max(activeStart, tailStart) + 1);
  const activeCount = Math.min(count, visibleWindowCount + Math.max(0, count - tailStart) - tailOverlap);

  return Object.freeze({
    count,
    windowed: true,
    activeStart,
    activeEnd,
    tailStart,
    activeCount,
    deferredCount: Math.max(0, count - activeCount),
  });
}

export function classifyMessageWindowIndex(index, plan = {}) {
  const normalizedIndex = integer(index);
  if (!plan.windowed) return "active";
  if (normalizedIndex >= plan.tailStart) return "tail";
  if (normalizedIndex >= plan.activeStart && normalizedIndex <= plan.activeEnd) return "active";
  const bufferStart = Math.max(0, plan.activeStart - LONG_CONVERSATION_DEFAULTS.messageOverscan);
  const bufferEnd = plan.activeEnd + LONG_CONVERSATION_DEFAULTS.messageOverscan;
  return normalizedIndex >= bufferStart && normalizedIndex <= bufferEnd ? "buffer" : "deferred";
}

export function deriveSidebarHistoryWindow(input = {}) {
  const count = integer(input.count);
  const threshold = Math.max(1, integer(
    input.threshold,
    LONG_CONVERSATION_DEFAULTS.sidebarActivationCount,
  ));
  const overscan = integer(input.overscan, LONG_CONVERSATION_DEFAULTS.sidebarOverscan);
  if (!count || count < threshold) {
    return Object.freeze({ count, windowed: false, start: 0, end: Math.max(0, count - 1) });
  }
  const lastIndex = count - 1;
  const firstVisible = clampLongConversationValue(integer(input.firstVisibleIndex), 0, lastIndex);
  const lastVisible = clampLongConversationValue(integer(input.lastVisibleIndex, firstVisible), firstVisible, lastIndex);
  return Object.freeze({
    count,
    windowed: true,
    start: Math.max(0, firstVisible - overscan),
    end: Math.min(lastIndex, lastVisible + overscan),
  });
}

export function deriveMediaPolicy(input = {}) {
  const latest = Boolean(input.latest);
  const nearViewport = Boolean(input.nearViewport);
  const decoded = Boolean(input.decoded);
  const visible = Boolean(input.visible);
  return Object.freeze({
    loading: latest || visible ? "eager" : "lazy",
    decoding: "async",
    fetchPriority: latest ? "high" : (nearViewport ? "auto" : "low"),
    shouldDecode: !decoded && (latest || nearViewport || visible),
    videoPreload: latest || nearViewport ? "metadata" : "none",
    frameState: decoded ? "decoded" : (nearViewport ? "near" : "deferred"),
  });
}

export function deriveScrollSnapshot(input = {}) {
  const scrollTop = Math.max(0, finite(input.scrollTop));
  const scrollHeight = Math.max(0, finite(input.scrollHeight));
  const clientHeight = Math.max(0, finite(input.clientHeight));
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  const distanceFromBottom = Math.max(0, maximumScrollTop - scrollTop);
  const threshold = Math.max(0, finite(
    input.threshold,
    LONG_CONVERSATION_DEFAULTS.nearBottomThresholdPx,
  ));
  return Object.freeze({
    scrollTop,
    scrollHeight,
    clientHeight,
    maximumScrollTop,
    distanceFromBottom,
    pinnedToBottom: distanceFromBottom <= threshold,
    ratio: maximumScrollTop > 0 ? scrollTop / maximumScrollTop : 1,
  });
}

export function deriveRehydrationTarget(input = {}) {
  const scrollHeight = Math.max(0, finite(input.scrollHeight));
  const clientHeight = Math.max(0, finite(input.clientHeight));
  const maximumScrollTop = Math.max(0, scrollHeight - clientHeight);
  const snapshot = input.snapshot || {};
  if (snapshot.pinnedToBottom) return maximumScrollTop;
  if (Number.isFinite(Number(input.anchorTop)) && Number.isFinite(Number(snapshot.anchorOffset))) {
    return clampLongConversationValue(
      finite(input.currentScrollTop) + finite(input.anchorTop) - finite(snapshot.anchorOffset),
      0,
      maximumScrollTop,
    );
  }
  if (Number.isFinite(Number(snapshot.scrollTop))) {
    return clampLongConversationValue(snapshot.scrollTop, 0, maximumScrollTop);
  }
  return clampLongConversationValue(finite(snapshot.ratio, 1) * maximumScrollTop, 0, maximumScrollTop);
}

export function createStableElementSignature(input = {}) {
  const explicit = String(input.id || input.requestId || input.chatId || "").trim();
  if (explicit) return explicit.slice(0, 160);
  const role = String(input.role || "message").trim().toLowerCase();
  const text = String(input.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `${role}:${text}`;
}
