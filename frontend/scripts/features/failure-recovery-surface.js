/* SentIQ Liquid Glass V4 — Phase 7.5 recovery surface states */

import {
  FAILURE_RECOVERY_VERSION,
  inferFailureRecoveryState,
  inferFailureRecoveryTool,
} from "./failure-recovery-state.js";

export const FAILURE_RECOVERY_SURFACE_SELECTOR = [
  ".message.assistant",
  ".deep-research-card",
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(", ");

const SPECIAL_SURFACE_SELECTOR = [
  ".deep-research-card",
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(", ");
const TERMINAL_STATES = new Set(["partial", "cancelled", "failed"]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function surfaceProfile(surface) {
  const special = surface.matches(SPECIAL_SURFACE_SELECTOR)
    ? surface
    : surface.querySelector(SPECIAL_SURFACE_SELECTOR);
  const target = special || surface;
  return {
    target,
    classes: [target.className, surface.className].join(" "),
    status: [
      target.dataset.deepResearchStatus,
      target.dataset.assetResultState,
      surface.dataset.responseStatus,
      target.getAttribute("aria-busy") === "true" ? "aria-busy" : "",
    ].filter(Boolean).join(" "),
    text: clean(surface.textContent),
    type: target.matches(".deep-research-card") ? "deep-research"
      : target.matches(".image-generation-card") ? "image"
        : target.matches(".message-chart-container") ? "chart"
          : target.matches(".generated-file-panel") ? "document"
            : surface.querySelector(".websurf-v2-panel, .web-search-panel") ? "websurf"
              : "response",
  };
}

function explicitState(profile, surface) {
  const { target } = profile;
  const message = surface.closest(".message.assistant");
  if (message && (message.dataset.responseStatus || message.querySelector(".truncation-notice, .response-recovery-row"))) {
    const state = inferFailureRecoveryState({
      classes: `${profile.classes} ${message.className}`,
      status: `${profile.status} ${message.dataset.responseStatus || ""}`,
      text: `${profile.text} ${clean(message.textContent)}`,
    });
    if (TERMINAL_STATES.has(state)) return state;
  }
  if (target.matches(".deep-research-card")) {
    if (target.classList.contains("failed")) return "failed";
    if (target.classList.contains("cancelled")) return "cancelled";
    if (target.classList.contains("completed")) return "successful";
    return "running";
  }
  if (target.matches(".image-generation-card, .message-chart-container, .generated-file-panel")) {
    if (target.classList.contains("is-failed") || target.querySelector(".image-load-error, .message-chart-error, .asset-request-failure")) return "failed";
    if (target.classList.contains("is-loading") || target.getAttribute("aria-busy") === "true") return "running";
    if (target.classList.contains("is-ready")) return "successful";
  }
  if (target.querySelector(".message-error-wrap, .asset-request-failure")) return "failed";
  if (surface.dataset.responseStatus || target.querySelector(".truncation-notice, .response-recovery-row")) {
    return inferFailureRecoveryState(profile);
  }
  if (target.querySelector(".typing-active, .response-inline-loader, .semantic-activity-progress")) return "running";
  if (target.querySelector(".message-error-text")) return "failed";
  return "successful";
}

export function createFailureRecoverySurfaceEnhancer(snapshots, view) {
  return function enhanceSurface(surface) {
    if (!(surface instanceof HTMLElement) || !surface.isConnected) return;
    if (surface.matches(".message.assistant") && surface.querySelector(SPECIAL_SURFACE_SELECTOR)) return;
    const profile = surfaceProfile(surface);
    const snapshot = snapshots.snapshotForSurface(surface);
    let tool = inferFailureRecoveryTool(profile);
    if (tool === "response" && snapshot?.mode) tool = snapshot.mode;
    const state = explicitState(profile, surface);
    surface.dataset.failureRecoveryVersion = FAILURE_RECOVERY_VERSION;
    surface.dataset.failureRecoveryTool = tool;
    surface.dataset.failureRecoveryState = state;

    if (!TERMINAL_STATES.has(state)) {
      surface.querySelector(":scope > .failure-recovery-panel, :scope > .message-content > .failure-recovery-panel")?.remove();
      if (state === "successful") {
        view.clearTray();
        snapshots.markCompleted(snapshot);
      }
      return;
    }

    view.ensurePanel(surface, tool, state, snapshot);
    const restoreKey = surface.dataset.requestId || `${tool}:${state}`;
    if (snapshots.markRestored(snapshot, restoreKey)) snapshots.restoreScroll(snapshot);
  };
}
