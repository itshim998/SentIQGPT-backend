/* SentIQ Liquid Glass V4 — Phase 9.4 conversation continuity model */

export const CONVERSATION_CONTINUITY_VERSION = "9.4";
export const CONTINUITY_REGISTRY_VERSION = 1;
export const MAX_CONTINUITY_RECORDS = 80;
export const MAX_DRAFT_CHARS = 12_000;
export const READING_BOTTOM_THRESHOLD = 120;
export const STREAMING_ACTIVITY_STALE_MS = 10 * 60 * 1000;

const TOOL_MODES = new Set(["none", "image", "web-basic", "deep-research"]);
const EXECUTION_MODES = new Set(["fast", "intuitive"]);

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asTimestamp(value, fallback = Date.now()) {
  const number = asFiniteNumber(value, fallback);
  return number > 0 ? Math.floor(number) : fallback;
}

function asText(value, maxLength = MAX_DRAFT_CHARS) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeModeSnapshot(input = {}) {
  const source = asObject(input);
  const toolMode = TOOL_MODES.has(source.toolMode) ? source.toolMode : "none";
  const executionMode = EXECUTION_MODES.has(source.executionMode) ? source.executionMode : "fast";
  return Object.freeze({ toolMode, executionMode });
}

export function isMeaningfulText(value) {
  const text = asText(value).trim();
  if (!text) return false;
  const alphanumeric = text.match(/[\p{L}\p{N}]/gu) || [];
  return alphanumeric.length >= 2 || text.includes("\n") || text.length >= 8;
}

export function normalizeDraftRecord(input = {}) {
  const source = asObject(input);
  const mode = normalizeModeSnapshot(source.mode || source);
  const text = asText(source.text);
  return Object.freeze({
    text,
    mode,
    updatedAt: asTimestamp(source.updatedAt),
  });
}

export function draftRecordHasContent(record) {
  const draft = normalizeDraftRecord(record);
  return Boolean(draft.text.trim() || draft.mode.toolMode !== "none");
}

export function draftRecordIsMeaningful(record, options = {}) {
  const draft = normalizeDraftRecord(record);
  return Boolean(
    isMeaningfulText(draft.text)
    || draft.mode.toolMode !== "none"
    || options.hasAttachments
    || options.hasSelectionContext
  );
}

export function normalizeReadingRecord(input = {}) {
  const source = asObject(input);
  const maxScrollTop = Math.max(0, asFiniteNumber(source.maxScrollTop, 0));
  const scrollTop = Math.min(maxScrollTop, Math.max(0, asFiniteNumber(source.scrollTop, 0)));
  const distanceFromBottom = Math.max(0, asFiniteNumber(source.distanceFromBottom, maxScrollTop - scrollTop));
  const ratio = maxScrollTop > 0
    ? Math.min(1, Math.max(0, asFiniteNumber(source.ratio, scrollTop / maxScrollTop)))
    : 0;
  const anchorFromEnd = Number.isInteger(source.anchorFromEnd) && source.anchorFromEnd >= 0
    ? source.anchorFromEnd
    : null;
  return Object.freeze({
    scrollTop,
    maxScrollTop,
    distanceFromBottom,
    ratio,
    atBottom: source.atBottom === true || distanceFromBottom <= READING_BOTTOM_THRESHOLD,
    anchorFromEnd,
    anchorOffset: asFiniteNumber(source.anchorOffset, 0),
    updatedAt: asTimestamp(source.updatedAt),
  });
}

export function captureReadingRecord(input = {}) {
  const source = asObject(input);
  const scrollHeight = Math.max(0, asFiniteNumber(source.scrollHeight, 0));
  const clientHeight = Math.max(0, asFiniteNumber(source.clientHeight, 0));
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const scrollTop = Math.min(maxScrollTop, Math.max(0, asFiniteNumber(source.scrollTop, 0)));
  const distanceFromBottom = Math.max(0, maxScrollTop - scrollTop);
  return normalizeReadingRecord({
    scrollTop,
    maxScrollTop,
    distanceFromBottom,
    ratio: maxScrollTop > 0 ? scrollTop / maxScrollTop : 0,
    atBottom: distanceFromBottom <= READING_BOTTOM_THRESHOLD,
    anchorFromEnd: source.anchorFromEnd,
    anchorOffset: source.anchorOffset,
    updatedAt: source.updatedAt,
  });
}

export function resolveRestoredScrollTop(record, layout = {}) {
  const reading = normalizeReadingRecord(record);
  const scrollHeight = Math.max(0, asFiniteNumber(layout.scrollHeight, 0));
  const clientHeight = Math.max(0, asFiniteNumber(layout.clientHeight, 0));
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  if (reading.atBottom) return maxScrollTop;
  const anchorOffsetTop = asFiniteNumber(layout.anchorOffsetTop, Number.NaN);
  if (Number.isFinite(anchorOffsetTop)) {
    return Math.min(maxScrollTop, Math.max(0, anchorOffsetTop + reading.anchorOffset));
  }
  return Math.min(maxScrollTop, Math.max(0, reading.ratio * maxScrollTop));
}

function normalizeActivity(input = {}) {
  const source = asObject(input);
  const type = ["streaming", "research", "syncing"].includes(source.type) ? source.type : "";
  if (!type) return null;
  const labels = {
    streaming: "Generating",
    research: "Researching",
    syncing: "Syncing",
  };
  return Object.freeze({
    type,
    label: labels[type],
    updatedAt: asTimestamp(source.updatedAt),
  });
}

function messageActivity(message, now) {
  const meta = asObject(message?.meta);
  const timestamp = Date.parse(message?.timestamp || message?.created_at || "");
  const updatedAt = Number.isFinite(timestamp) ? timestamp : now;
  if (meta.type === "deep-research" && meta.status === "running") {
    return normalizeActivity({ type: "research", updatedAt });
  }
  const responseStatus = meta.responseStatus || meta.response_status;
  if (meta.streaming === true || responseStatus === "generating") {
    if (now - updatedAt <= STREAMING_ACTIVITY_STALE_MS) {
      return normalizeActivity({ type: "streaming", updatedAt });
    }
  }
  return null;
}

export function deriveConversationActivity(chat, now = Date.now()) {
  const source = asObject(chat);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const activity = messageActivity(messages[index], now);
    if (activity) return activity;
  }
  if (source.pending_server_sync) {
    return normalizeActivity({ type: "syncing", updatedAt: Date.parse(source.updated || "") || now });
  }
  return null;
}

function normalizeRegistryEntryMap(input, normalizer) {
  const source = asObject(input);
  const entries = Object.entries(source)
    .map(([key, value]) => [String(key || "").trim(), normalizer(value)])
    .filter(([key, value]) => key && value)
    .sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0))
    .slice(0, MAX_CONTINUITY_RECORDS);
  return Object.fromEntries(entries);
}

export function normalizeContinuityRegistry(input = {}) {
  const source = asObject(input);
  return {
    version: CONTINUITY_REGISTRY_VERSION,
    drafts: normalizeRegistryEntryMap(source.drafts, normalizeDraftRecord),
    reading: normalizeRegistryEntryMap(source.reading, normalizeReadingRecord),
    updatedAt: asTimestamp(source.updatedAt),
  };
}

export function updateRegistryDraft(registry, conversationId, record) {
  const id = String(conversationId || "").trim();
  const next = normalizeContinuityRegistry(registry);
  if (!id) return next;
  const normalized = normalizeDraftRecord(record);
  if (draftRecordHasContent(normalized)) next.drafts[id] = normalized;
  else delete next.drafts[id];
  next.updatedAt = Date.now();
  return normalizeContinuityRegistry(next);
}

export function updateRegistryReading(registry, conversationId, record) {
  const id = String(conversationId || "").trim();
  const next = normalizeContinuityRegistry(registry);
  if (!id) return next;
  next.reading[id] = normalizeReadingRecord(record);
  next.updatedAt = Date.now();
  return normalizeContinuityRegistry(next);
}

export function removeConversationContinuity(registry, conversationId) {
  const id = String(conversationId || "").trim();
  const next = normalizeContinuityRegistry(registry);
  if (!id) return next;
  delete next.drafts[id];
  delete next.reading[id];
  next.updatedAt = Date.now();
  return next;
}
