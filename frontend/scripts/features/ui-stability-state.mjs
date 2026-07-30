export const UI_STABILITY_VERSION = "13.0";
export const OPTIMISTIC_SEND_TIMEOUT_MS = 15_000;
export const SUCCESSFUL_SEND_GUARD_TIMEOUT_MS = 180_000;
export const CHAT_LIST_STABILIZE_QUIET_MS = 180;
export const CHAT_LIST_STABILIZE_MAX_MS = 1_200;

export function normalizeComposerText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeUserDisplayText(value) {
  const source = String(value || "").trim();
  return source.startsWith("Generate image: ")
    ? source.slice("Generate image: ".length).trim()
    : source;
}

export function normalizeExecutionMode(value) {
  return String(value || "").toLowerCase() === "intuitive" ? "intuitive" : "fast";
}

export function isComposerSendCandidate({
  text,
  sendDisabled = false,
  stopMode = false,
  composing = false,
} = {}) {
  if (sendDisabled || stopMode || composing) return false;
  return normalizeComposerText(text).length > 0;
}

export function isPlainTextSendCandidate(options = {}) {
  return isComposerSendCandidate(options) && (options.toolMode || "none") === "none";
}

export function shouldShowOptimisticUserMessage({
  executionMode,
  composerCleared,
  matchingRealMessagePresent,
  elapsedMs = 0,
} = {}) {
  return normalizeExecutionMode(executionMode) === "intuitive"
    && Boolean(composerCleared)
    && !matchingRealMessagePresent
    && Number(elapsedMs) >= 0
    && Number(elapsedMs) < OPTIMISTIC_SEND_TIMEOUT_MS;
}

export function messageTextMatches(left, right) {
  const a = normalizeComposerText(left);
  const b = normalizeComposerText(right);
  return Boolean(a && b && a === b);
}

export function shouldClearRestoredComposer({
  composerText,
  sentText,
  requestSucceeded = false,
  userEditedAfterSend = false,
} = {}) {
  return Boolean(requestSucceeded)
    && !userEditedAfterSend
    && messageTextMatches(composerText, sentText);
}

export function nextChatListSettleDelay({
  elapsedMs = 0,
  quietMs = CHAT_LIST_STABILIZE_QUIET_MS,
  maxMs = CHAT_LIST_STABILIZE_MAX_MS,
} = {}) {
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const remaining = Math.max(0, (Number(maxMs) || CHAT_LIST_STABILIZE_MAX_MS) - elapsed);
  return Math.min(Math.max(0, Number(quietMs) || CHAT_LIST_STABILIZE_QUIET_MS), remaining);
}
