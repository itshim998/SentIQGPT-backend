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
    running: "Still generating.",
    successful: "Response complete.",
    partial: "Partial answer saved. Continue or retry.",
    cancelled: "Stopped. Retry to start over.",
    failed: "Didn't finish. Retry to try again.",
  }),
  websurf: Object.freeze({
    label: "Web search",
    running: "Searching…",
    successful: "Answer complete.",
    partial: "Sources and partial answer saved. Retry to search again.",
    cancelled: "Search stopped. Retry to search again.",
    failed: "Search didn't finish. Retry to try again.",
  }),
  image: Object.freeze({
    label: "Image generation",
    running: "Creating the image…",
    successful: "Image complete.",
    partial: "Preview saved. Retry to regenerate.",
    cancelled: "Image stopped. Retry to regenerate.",
    failed: "Couldn't create the image. Retry to try again.",
  }),
  chart: Object.freeze({
    label: "Chart generation",
    running: "Generating the chart…",
    successful: "Chart complete.",
    partial: "Partial chart saved. Retry to regenerate.",
    cancelled: "Chart stopped. Retry to regenerate.",
    failed: "Couldn't create the chart. Retry to try again.",
  }),
  document: Object.freeze({
    label: "Document generation",
    running: "Preparing the document…",
    successful: "Document complete.",
    partial: "The available draft is preserved. Retry can rebuild the unfinished document.",
    cancelled: "Document stopped. Retry to try again.",
    failed: "Couldn't create the document. Retry to try again.",
  }),
  "deep-research": Object.freeze({
    label: "Deep Research",
    running: "Research is continuing.",
    successful: "Report complete.",
    partial: "Progress and draft saved. Resume or retry.",
    cancelled: "Research stopped. Progress is saved. Retry to start again.",
    failed: "Research didn't finish. Progress is saved. Retry to try again.",
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
