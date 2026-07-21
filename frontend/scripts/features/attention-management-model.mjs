/* SentIQ Liquid Glass V4 — Phase 9.5 attention management model */

export const ATTENTION_MANAGEMENT_VERSION = "9.5";
export const ATTENTION_SIGNAL_KINDS = Object.freeze([
  "response-complete",
  "research-complete",
  "file-analysis-failed",
  "image-complete",
  "connection-recovered",
]);
export const MAX_ATTENTION_QUEUE = 3;
export const ATTENTION_DEDUPE_WINDOW_MS = 20_000;

const COMPLETE_STATUSES = new Set(["complete", "completed", "success", "succeeded", "finished", "ready", "done"]);
const FAILED_STATUSES = new Set(["failed", "failure", "error", "errored", "unavailable"]);
const PENDING_STATUSES = new Set(["running", "pending", "generating", "processing", "uploading", "queued", "started"]);
const INTERRUPTED_STATUSES = new Set(["interrupted", "stopped", "cancelled", "canceled"]);
const TEXT_MESSAGE_TYPES = new Set(["", "text", "assistant", "response", "message"]);

const SIGNAL_COPY = Object.freeze({
  "response-complete": Object.freeze({ title: "Response ready", shortLabel: "Ready", tone: "ready" }),
  "research-complete": Object.freeze({ title: "Research ready", shortLabel: "Research", tone: "research" }),
  "file-analysis-failed": Object.freeze({ title: "File analysis failed", shortLabel: "File issue", tone: "error" }),
  "image-complete": Object.freeze({ title: "Image ready", shortLabel: "Image", tone: "image" }),
  "connection-recovered": Object.freeze({ title: "Connection restored", shortLabel: "Online", tone: "connection" }),
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value, maxLength = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function lower(value) {
  return clean(value, 80).toLowerCase();
}

function timestampOf(value, fallback = 0) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function statusOf(meta) {
  return lower(meta.status || meta.responseStatus || meta.response_status || meta.state || meta.phase);
}

function typeOf(meta) {
  return lower(meta.type || meta.messageType || meta.message_type || meta.kind || meta.tool);
}

function messageIdentity(message, meta, fallbackKind) {
  return clean(
    message?.id
      || message?.clientRequestId
      || message?.client_request_id
      || meta.reportId
      || meta.report_id
      || meta.imageId
      || meta.image_id
      || meta.analysis_id
      || meta.analysisId
      || meta.file_id
      || meta.generated_file_id
      || message?.timestamp
      || message?.created_at
      || fallbackKind,
    240,
  );
}

function hasImageArtifact(meta, content) {
  return Boolean(
    meta.imageUrl
      || meta.image_url
      || meta.storagePath
      || meta.storage_path
      || meta.image_id
      || meta.imageId
      || meta.success === true
      || /\b(image|illustration|render)\b/i.test(content),
  );
}

function isFileLikeType(type) {
  return /(?:^|[-_])(file|attachment|document)(?:$|[-_])/.test(type)
    || ["file", "file-analysis", "file_upload", "message-attachments", "attachment-analysis"].includes(type);
}

function isDeepResearchType(type) {
  return type === "deep-research" || type === "deep_research" || type === "research-report";
}

function isImageType(type) {
  return type === "image" || type === "image-generation" || type === "image_generation" || type === "generated-image";
}

export function normalizeAttentionSignal(input = {}) {
  const source = asObject(input);
  const kind = ATTENTION_SIGNAL_KINDS.includes(source.kind) ? source.kind : "response-complete";
  const copy = SIGNAL_COPY[kind];
  const chatId = clean(source.chatId || source.conversationId, 160);
  const updatedAt = timestampOf(source.updatedAt, Date.now());
  const signature = clean(source.signature || `${kind}:${chatId || "global"}:${updatedAt}`, 360);
  return Object.freeze({
    kind,
    chatId,
    title: clean(source.title || copy.title, 90),
    shortLabel: clean(source.shortLabel || copy.shortLabel, 40),
    detail: clean(source.detail, 180),
    tone: copy.tone,
    signature,
    updatedAt,
    source: clean(source.source || "runtime", 60),
  });
}

export function attentionSignalKey(input = {}) {
  const signal = normalizeAttentionSignal(input);
  return `${signal.kind}:${signal.chatId || "global"}:${signal.signature}`;
}

export function classifyMessageOutcome(message, now = Date.now()) {
  if (!message || typeof message !== "object") return null;
  const meta = asObject(message.meta);
  const type = typeOf(meta);
  const status = statusOf(meta);
  const content = clean(message.content, 500);
  const updatedAt = timestampOf(message.timestamp || message.created_at || meta.updatedAt || meta.updated_at, now);

  if (isDeepResearchType(type)) {
    if (!COMPLETE_STATUSES.has(status)) return null;
    const identity = messageIdentity(message, meta, "research");
    return Object.freeze({
      kind: "research-complete",
      signature: `research:${identity}:${status || "complete"}`,
      updatedAt,
      detail: clean(meta.title || meta.query || content, 120),
    });
  }

  if (isImageType(type)) {
    if (meta.success === false || FAILED_STATUSES.has(status) || PENDING_STATUSES.has(status) || INTERRUPTED_STATUSES.has(status)) return null;
    if (!hasImageArtifact(meta, content)) return null;
    const identity = messageIdentity(message, meta, "image");
    return Object.freeze({
      kind: "image-complete",
      signature: `image:${identity}:${status || "complete"}`,
      updatedAt,
      detail: clean(meta.prompt || meta.title, 120),
    });
  }

  if (isFileLikeType(type) && (meta.success === false || FAILED_STATUSES.has(status))) {
    const identity = messageIdentity(message, meta, "file");
    return Object.freeze({
      kind: "file-analysis-failed",
      signature: `file-failure:${identity}:${status || "failed"}`,
      updatedAt,
      detail: clean(meta.filename || meta.file_name || meta.error || content, 120),
    });
  }

  if (message.role !== "assistant" || !content || !TEXT_MESSAGE_TYPES.has(type)) return null;
  if (PENDING_STATUSES.has(status) || FAILED_STATUSES.has(status) || INTERRUPTED_STATUSES.has(status)) return null;
  const identity = messageIdentity(message, meta, "response");
  return Object.freeze({
    kind: "response-complete",
    signature: `response:${identity}:${status || "settled"}`,
    updatedAt,
    detail: "",
  });
}

export function deriveLatestChatOutcome(chat, now = Date.now()) {
  const source = asObject(chat);
  const messages = Array.isArray(source.messages) ? source.messages : [];
  let latest = null;
  for (const message of messages) {
    const outcome = classifyMessageOutcome(message, now);
    if (!outcome) continue;
    if (!latest || outcome.updatedAt >= latest.updatedAt) latest = outcome;
  }
  return latest;
}

export function deriveOutcomeSignal(previousOutcome, nextOutcome, context = {}) {
  if (!previousOutcome || !nextOutcome) return null;
  if (previousOutcome.signature === nextOutcome.signature) return null;
  const active = Boolean(context.active);
  if (nextOutcome.kind === "response-complete" && active) return null;
  return normalizeAttentionSignal({
    ...nextOutcome,
    chatId: context.chatId,
    source: context.source || "conversation-snapshot",
  });
}

export function shouldAcceptSignal(signalInput, recent = new Map(), now = Date.now(), windowMs = ATTENTION_DEDUPE_WINDOW_MS) {
  const signal = normalizeAttentionSignal(signalInput);
  const exactKey = attentionSignalKey(signal);
  if (recent.has(exactKey)) return false;
  const familyKey = `${signal.kind}:${signal.chatId || "global"}`;
  const lastFamilyAt = Number(recent.get(familyKey) || 0);
  return !lastFamilyAt || now - lastFamilyAt >= windowMs;
}

export function rememberAcceptedSignal(signalInput, recent = new Map(), now = Date.now()) {
  const signal = normalizeAttentionSignal(signalInput);
  recent.set(attentionSignalKey(signal), now);
  recent.set(`${signal.kind}:${signal.chatId || "global"}`, now);
  return recent;
}

export function pruneRecentSignals(recent = new Map(), now = Date.now(), maxAgeMs = ATTENTION_DEDUPE_WINDOW_MS * 3) {
  for (const [key, value] of recent) {
    if (now - Number(value || 0) > maxAgeMs) recent.delete(key);
  }
  return recent;
}

export function coalesceAttentionQueue(queue = [], incoming, maxItems = MAX_ATTENTION_QUEUE) {
  const signal = normalizeAttentionSignal(incoming);
  const filtered = queue
    .map(normalizeAttentionSignal)
    .filter((item) => !(item.kind === signal.kind && item.chatId === signal.chatId));
  filtered.push(signal);
  return filtered.slice(-Math.max(1, maxItems));
}
