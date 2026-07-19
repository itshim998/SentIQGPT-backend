/* SentIQ Liquid Glass V4 — Phase 9.1 central UI state runtime */

import {
  UI_PRIMARY_STATES,
  UI_STATE_VERSION,
  createUIStateStore,
  deriveUIState,
} from "./ui-state-model.mjs";

function initializeUIStateRuntime() {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.documentElement) return;
  if (window.SentIQUIState?.version === UI_STATE_VERSION) return;

  const store = createUIStateStore({}, { clock: Date.now });
  const stateClassNames = UI_PRIMARY_STATES.map((state) => `sentiq-ui-state-${state}`);

  function targets() {
    return [
      document.documentElement,
      document.body,
      document.querySelector(".app-container"),
      document.querySelector(".main-content"),
      document.querySelector(".chat-input-wrapper"),
      document.getElementById("welcome-screen"),
      document.getElementById("chat-messages"),
    ].filter((element) => element instanceof HTMLElement);
  }

  function setAttribute(element, name, value) {
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function applyState(state) {
    targets().forEach((element) => {
      element.classList.remove(...stateClassNames);
      element.classList.add(`sentiq-ui-state-${state.primary}`);
      setAttribute(element, "data-sentiq-ui-state", state.primary);
      setAttribute(element, "data-sentiq-ui-flags", state.flagsText);
      setAttribute(element, "data-sentiq-ui-auth", state.auth);
      setAttribute(element, "data-sentiq-ui-empty", state.empty ? "true" : "false");
      setAttribute(element, "data-sentiq-ui-busy", state.busy ? "true" : "false");
      if (state.selectedTool) setAttribute(element, "data-sentiq-ui-tool", state.selectedTool);
      else element.removeAttribute("data-sentiq-ui-tool");
    });

    setAttribute(document.documentElement, "data-sentiq-ui-version", UI_STATE_VERSION);
    document.dispatchEvent(new CustomEvent("sentiq-ui-state-change", {
      detail: {
        version: state.version,
        revision: state.revision,
        primary: state.primary,
        previous: state.previous,
        flags: state.flags,
        auth: state.auth,
        empty: state.empty,
        busy: state.busy,
        selectedTool: state.selectedTool,
        transition: state.transition,
      },
    }));
  }

  store.subscribe(applyState);

  document.addEventListener("sentiq-ui-signal", (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== "object") return;
    const patch = detail.facts || detail.patch;
    if (!patch || typeof patch !== "object") return;
    store.patch(patch, {
      source: detail.source || "event",
      reason: detail.reason || event.type,
    });
  });

  window.SentIQUIState = Object.freeze({
    version: UI_STATE_VERSION,
    getState: store.getState,
    getFacts: store.getFacts,
    patch: store.patch,
    transaction: store.transaction,
    subscribe: store.subscribe,
    derive: deriveUIState,
    signal(facts, meta = {}) {
      return store.patch(facts, {
        source: meta.source || "api",
        reason: meta.reason || "signal",
      });
    },
  });

  document.dispatchEvent(new CustomEvent("sentiq-ui-state-ready", {
    detail: { version: UI_STATE_VERSION, state: store.getState().primary },
  }));
}

initializeUIStateRuntime();
