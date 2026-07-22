/* SentIQ Liquid Glass V4 — Phase 8.1 adaptive panel state */

export const ADAPTIVE_PANEL_VERSION = "8.1";
export const ADAPTIVE_PANEL_TABLET_MAX = 1024;
export const ADAPTIVE_PANEL_MOBILE_MAX = 640;

export const ADAPTIVE_PANEL_CONFIGS = Object.freeze([
  Object.freeze({
    id: "auth-modal",
    kind: "dialog",
    surfaceSelector: ".modal-container",
    headerSelector: ".modal-header",
    titleSelector: "#auth-modal-title",
    existingCloseSelector: "#auth-close-btn",
    closeActionSelector: "#auth-close-btn",
    desktopPlacement: "center",
    mobileMode: "bottom",
    dismissible: true,
  }),
  Object.freeze({
    id: "name-modal",
    kind: "dialog",
    surfaceSelector: ".modal-container",
    headerSelector: ".modal-header",
    titleSelector: "#name-modal-title",
    desktopPlacement: "center",
    mobileMode: "bottom",
    dismissible: false,
  }),
  Object.freeze({
    id: "settings-modal",
    kind: "dialog",
    surfaceSelector: ".modal-container",
    headerSelector: ".modal-header",
    titleSelector: ".modal-header h2",
    existingCloseSelector: "#close-settings-btn",
    closeActionSelector: "#close-settings-btn",
    desktopPlacement: "contextual",
    mobileMode: "full",
    dismissible: true,
  }),
  Object.freeze({
    id: "trust-modal",
    kind: "dialog",
    surfaceSelector: ".modal-container",
    headerSelector: ".modal-header",
    titleSelector: "#trust-modal-title",
    existingCloseSelector: "#close-trust-btn",
    closeActionSelector: "#close-trust-btn",
    desktopPlacement: "contextual",
    mobileMode: "full",
    dismissible: true,
  }),
  Object.freeze({
    id: "live-beta-panel",
    kind: "dialog",
    titleLabel: "Live voice",
    surfaceSelector: ".live-beta-surface",
    headerSelector: ".live-beta-header",
    titleSelector: "#live-beta-title",
    closeActionSelector: "#live-beta-end",
    desktopPlacement: "center",
    mobileMode: "full",
    generatedClose: true,
    dismissible: true,
  }),
  Object.freeze({
    id: "account-panel",
    kind: "popover",
    surfaceSelector: null,
    headerSelector: ".account-panel-header",
    titleLabel: "Account",
    closeActionSelector: "#account-btn",
    desktopPlacement: "contextual",
    mobileMode: "bottom",
    modalBelow: ADAPTIVE_PANEL_TABLET_MAX,
    generatedClose: true,
    dismissible: true,
  }),
]);

export function resolveAdaptivePanelMode(config, viewportWidth) {
  const width = Math.max(0, Number(viewportWidth) || 0);
  if (width <= ADAPTIVE_PANEL_MOBILE_MAX) {
    return config?.mobileMode === "full" ? "full-height-sheet" : "bottom-sheet";
  }
  if (width <= ADAPTIVE_PANEL_TABLET_MAX) return "side-sheet";
  if (config?.kind === "popover") return "contextual-floating";
  return config?.desktopPlacement === "contextual" ? "contextual-floating" : "floating-dialog";
}

export function isAdaptivePanelModal(config, mode) {
  if (config?.kind === "dialog") return true;
  return mode !== "contextual-floating";
}

export function getAdaptivePanelConfig(id) {
  return ADAPTIVE_PANEL_CONFIGS.find((config) => config.id === id) || null;
}
