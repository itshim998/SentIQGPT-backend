/* SentIQ Liquid Glass V4 — Phase 7.5 failure recovery state */

export const FAILURE_RECOVERY_VERSION = "7.5";
export const FAILURE_RECOVERY_STATES = Object.freeze([
  "running",
  "successful",
  "partial",
  "cancelled",
  "failed",
]);

export const FAILURE_RECOVERY_TOOLS = Object.freeze({
  response: Object.freeze({
    label: "Response",
    running: "The response is still being prepared.",
    successful: "The response completed.",
    partial: "The partial answer is preserved. Continue from it or retry the response.",
    cancelled: "The response was stopped. Retry can start again from the original prompt.",
    failed: "The response did not finish. Retry reuses the original prompt and available context.",
  }),
  websurf: Object.freeze({
    label: "Web search",
    running: "Search and source comparison are still in progress.",
    successful: "The sourced answer completed.",
    partial: "Available sources and partial synthesis are preserved. Retry can repeat the unfinished search.",
    cancelled: "Web search was stopped. Retry can run the original search again.",
    failed: "Web search did not finish. Retry reuses the original prompt and WebSurf mode.",
  }),
  image: Object.freeze({
    label: "Image generation",
    running: "The image is still being created.",
    successful: "The image completed.",
    partial: "The available preview is preserved. Retry can regenerate the unfinished image.",
    cancelled: "Image generation was stopped. Retry can use the original prompt again.",
    failed: "The image could not be completed. Retry reuses the original prompt and image mode.",
  }),
  chart: Object.freeze({
    label: "Chart generation",
    running: "The chart is still being generated.",
    successful: "The chart completed.",
    partial: "Available chart content is preserved. Retry can regenerate the unfinished chart.",
    cancelled: "Chart generation was stopped. Retry can use the original request again.",
    failed: "The chart could not be completed. Retry reuses the original request and context.",
  }),
  document: Object.freeze({
    label: "Document generation",
    running: "The document is still being prepared.",
    successful: "The document completed.",
    partial: "The available draft is preserved. Retry can rebuild the unfinished document.",
    cancelled: "Document generation was stopped. Retry can use the original request again.",
    failed: "The document could not be completed. Retry reuses the original prompt and file context.",
  }),
  "deep-research": Object.freeze({
    label: "Deep Research",
    running: "Research continues in the saved workspace.",
    successful: "The research report completed.",
    partial: "Available research progress and draft content are preserved. Resume or retry the unfinished work.",
    cancelled: "Research was stopped. Available progress remains saved, and the original prompt can be retried.",
    failed: "Research could not finish. Available progress remains saved, and retry can reuse the original prompt.",
  }),
});

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeFailureRecoveryTool(value) {
  const normalized = clean(value).toLowerCase();
  if (["websurf", "web-search", "web_search", "search"].includes(normalized)) return "websurf";
  if (["file", "generated-file", "document", "pdf", "spreadsheet", "presentation"].includes(normalized)) return "document";
  if (["deep-research", "deep research", "research"].includes(normalized)) return "deep-research";
  if (["image", "chart", "response"].includes(normalized)) return normalized;
  return "response";
}

export function getFailureRecoveryContract(tool = "response") {
  return FAILURE_RECOVERY_TOOLS[normalizeFailureRecoveryTool(tool)] || FAILURE_RECOVERY_TOOLS.response;
}

export function getFailureRecoveryCopy(tool = "response", state = "failed") {
  const contract = getFailureRecoveryContract(tool);
  const normalizedState = FAILURE_RECOVERY_STATES.includes(state) ? state : "failed";
  return {
    label: contract.label,
    state: normalizedState,
    message: contract[normalizedState],
  };
}

export function inferFailureRecoveryTool(profile = {}) {
  const classes = clean(profile.classes).toLowerCase();
  const text = clean(profile.text).toLowerCase();
  const type = clean(profile.type).toLowerCase();
  const source = `${classes} ${type} ${text}`;
  if (/deep[- ]research/.test(source)) return "deep-research";
  if (/websurf|web[- ]search|search source|source comparison/.test(source)) return "websurf";
  if (/image-generation|generated image|image generation|create image/.test(source)) return "image";
  if (/message-chart|chart generation|generated chart|plotly|chart\.js/.test(source)) return "chart";
  if (/generated-file|document generation|preparing document|spreadsheet|presentation|\bpdf\b/.test(source)) return "document";
  return "response";
}

export function inferFailureRecoveryState(profile = {}) {
  const classes = clean(profile.classes).toLowerCase();
  const text = clean(profile.text).toLowerCase();
  const status = clean(profile.status).toLowerCase();
  const source = `${classes} ${status} ${text}`;
  if (/\b(cancelled|canceled|stopped|aborted)\b/.test(source)) return "cancelled";
  if (/\b(partial|interrupted|incomplete|available draft|showing partial)\b/.test(source)) return "partial";
  if (/\b(failed|failure|error|couldn'?t|could not|unable|something went wrong|needs attention|try again)\b/.test(source)) return "failed";
  if (/\b(completed|complete|successful|succeeded|is-ready|ready)\b/.test(source)) return "successful";
  if (/\b(running|loading|pending|thinking|searching|generating|preparing|aria-busy)\b/.test(source)) return "running";
  return "successful";
}

export function shouldRestoreComposerDraft(currentDraft, snapshotDraft) {
  const current = String(currentDraft || "");
  const snapshot = String(snapshotDraft || "");
  if (!snapshot) return false;
  return !current.trim() || current === snapshot;
}

export function getAttachmentRecoveryStatus(expectedCount, availableCount) {
  const expected = Math.max(0, Number(expectedCount) || 0);
  const available = Math.max(0, Number(availableCount) || 0);
  if (!expected) return "none";
  if (available >= expected) return "preserved";
  return "reattach";
}

export function isCompleteFailureRecoveryMatrix(matrix = FAILURE_RECOVERY_TOOLS) {
  return Object.values(matrix).every((contract) => FAILURE_RECOVERY_STATES.every((state) => clean(contract?.[state])));
}
