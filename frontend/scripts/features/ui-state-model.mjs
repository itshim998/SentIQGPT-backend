/* SentIQ Liquid Glass V4 — Phase 9.1 central derived UI state model */

export const UI_STATE_VERSION = "9.1";

export const UI_PRIMARY_STATES = Object.freeze([
  "guest-empty",
  "signed-in-empty",
  "ready",
  "drafting",
  "uploading",
  "tool-selected",
  "streaming",
  "background-task",
  "error-recoverable",
  "reading-history",
  "live-active",
]);

export const UI_STATE_PRIORITY = Object.freeze([
  "live-active",
  "error-recoverable",
  "uploading",
  "streaming",
  "background-task",
  "tool-selected",
  "drafting",
  "reading-history",
  "signed-in-empty",
  "guest-empty",
  "ready",
]);

export const DEFAULT_UI_FACTS = Object.freeze({
  authKnown: false,
  authenticated: false,
  hasMessages: false,
  draftLength: 0,
  attachmentCount: 0,
  uploadingCount: 0,
  hasSelectionContext: false,
  selectedTool: "",
  streaming: false,
  backgroundTask: false,
  recoverableError: false,
  readingHistory: false,
  liveActive: false,
});

const TOOL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function asCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function asTool(value) {
  const tool = String(value || "").trim().toLowerCase();
  return TOOL_PATTERN.test(tool) ? tool : "";
}

export function normalizeUIFacts(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return Object.freeze({
    authKnown: Boolean(source.authKnown),
    authenticated: Boolean(source.authenticated),
    hasMessages: Boolean(source.hasMessages),
    draftLength: asCount(source.draftLength),
    attachmentCount: asCount(source.attachmentCount),
    uploadingCount: asCount(source.uploadingCount),
    hasSelectionContext: Boolean(source.hasSelectionContext),
    selectedTool: asTool(source.selectedTool),
    streaming: Boolean(source.streaming),
    backgroundTask: Boolean(source.backgroundTask),
    recoverableError: Boolean(source.recoverableError),
    readingHistory: Boolean(source.readingHistory),
    liveActive: Boolean(source.liveActive),
  });
}

function resolvePrimaryState(facts) {
  if (facts.liveActive) return "live-active";
  if (facts.recoverableError) return "error-recoverable";
  if (facts.uploadingCount > 0) return "uploading";
  if (facts.streaming) return "streaming";
  if (facts.backgroundTask) return "background-task";
  if (facts.selectedTool) return "tool-selected";
  if (facts.draftLength > 0 || facts.attachmentCount > 0 || facts.hasSelectionContext) return "drafting";
  if (facts.readingHistory && facts.hasMessages) return "reading-history";
  if (!facts.hasMessages) return facts.authenticated ? "signed-in-empty" : "guest-empty";
  return "ready";
}

function buildFlags(facts, primary) {
  const flags = new Set();
  flags.add(facts.authenticated ? "signed-in" : "guest");
  if (!facts.authKnown) flags.add("auth-pending");
  flags.add(facts.hasMessages ? "has-messages" : "empty");
  if (facts.draftLength > 0 || facts.attachmentCount > 0 || facts.hasSelectionContext) flags.add("draft");
  if (facts.attachmentCount > 0) flags.add("has-attachments");
  if (facts.uploadingCount > 0) flags.add("uploading");
  if (facts.hasSelectionContext) flags.add("has-selection-context");
  if (facts.selectedTool) flags.add("tool-selected");
  if (facts.streaming) flags.add("streaming");
  if (facts.backgroundTask) flags.add("background-task");
  if (facts.recoverableError) flags.add("error-recoverable");
  if (facts.readingHistory) flags.add("reading-history");
  if (facts.liveActive) flags.add("live-active");
  flags.add(primary);
  return Object.freeze(Array.from(flags).sort());
}

export function deriveUIState(input = {}) {
  const facts = normalizeUIFacts(input);
  const primary = resolvePrimaryState(facts);
  const flags = buildFlags(facts, primary);
  return Object.freeze({
    version: UI_STATE_VERSION,
    primary,
    auth: facts.authenticated ? "signed-in" : "guest",
    authKnown: facts.authKnown,
    empty: !facts.hasMessages,
    busy: facts.uploadingCount > 0 || facts.streaming || facts.backgroundTask || facts.liveActive,
    interactive: !facts.liveActive,
    selectedTool: facts.selectedTool || null,
    flags,
    flagsText: flags.join(" "),
    facts,
  });
}

function factsEqual(left, right) {
  return Object.keys(DEFAULT_UI_FACTS).every((key) => left[key] === right[key]);
}

export function createUIStateStore(initialFacts = {}, options = {}) {
  const clock = typeof options.clock === "function" ? options.clock : Date.now;
  const listeners = new Set();
  let facts = normalizeUIFacts({ ...DEFAULT_UI_FACTS, ...initialFacts });
  let derived = deriveUIState(facts);
  let revision = 0;
  let batchDepth = 0;
  let pendingCommit = false;
  let pendingMeta = { source: "initial", reason: "initial" };

  function snapshot(meta = pendingMeta, previous = null) {
    return Object.freeze({
      ...derived,
      revision,
      previous,
      transition: Object.freeze({
        source: String(meta?.source || "unknown"),
        reason: String(meta?.reason || "update"),
        changedAt: Number(clock()) || 0,
      }),
    });
  }

  let current = snapshot();

  function notify(previous, meta) {
    revision += 1;
    current = snapshot(meta, previous?.primary || null);
    listeners.forEach((listener) => {
      try {
        listener(current, previous);
      } catch {
        // A presentation subscriber must not break the state model.
      }
    });
  }

  function commit(meta = pendingMeta) {
    if (!pendingCommit) return current;
    pendingCommit = false;
    const previous = current;
    derived = deriveUIState(facts);
    notify(previous, meta);
    return current;
  }

  function patch(nextPatch = {}, meta = {}) {
    const candidate = normalizeUIFacts({ ...facts, ...(nextPatch && typeof nextPatch === "object" ? nextPatch : {}) });
    if (factsEqual(facts, candidate)) return current;
    facts = candidate;
    pendingCommit = true;
    pendingMeta = {
      source: meta.source || pendingMeta.source || "unknown",
      reason: meta.reason || "patch",
    };
    if (batchDepth === 0) commit(pendingMeta);
    return current;
  }

  function transaction(callback, meta = {}) {
    batchDepth += 1;
    try {
      if (typeof callback === "function") callback(api);
    } finally {
      batchDepth = Math.max(0, batchDepth - 1);
      if (batchDepth === 0) commit({
        source: meta.source || pendingMeta.source || "transaction",
        reason: meta.reason || pendingMeta.reason || "transaction",
      });
    }
    return current;
  }

  function subscribe(listener, optionsForSubscription = {}) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    if (optionsForSubscription.emitCurrent !== false) listener(current, null);
    return () => listeners.delete(listener);
  }

  const api = Object.freeze({
    version: UI_STATE_VERSION,
    getState: () => current,
    getFacts: () => facts,
    patch,
    transaction,
    subscribe,
  });

  return api;
}
