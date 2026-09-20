/* ============================================================
   SentIQ Liquid Glass V4 — Phase 5.6
   Execution mode selector presentation and placement stability

   The chat controller remains authoritative for the stored execution mode,
   option clicks, persistence, response locking, and menu open/close state.
   This layer enriches the existing nodes and keeps the same control inside
   the composer at every viewport.
   ============================================================ */

const EXECUTION_MODE_VERSION = "5.6";

const MODE_DETAILS = Object.freeze({
  fast: {
    label: "Fast",
    description: "Direct, lower-latency replies for everyday prompts.",
  },
  intuitive: {
    label: "Intuitive",
    description: "Deeper context and reflection for complex prompts.",
  },
});

function setClass(element, className, enabled) {
  if (!element) return;
  const next = Boolean(enabled);
  if (element.classList.contains(className) !== next) element.classList.toggle(className, next);
}

function getMode(option) {
  const mode = String(option?.dataset?.executionMode || "fast").toLowerCase();
  return mode === "intuitive" ? "intuitive" : "fast";
}

function buildOptionContent(option) {
  if (!option || option.dataset.executionModeEnhanced === EXECUTION_MODE_VERSION) return;

  const mode = getMode(option);
  const detail = MODE_DETAILS[mode];
  const copy = document.createElement("span");
  copy.className = "execution-mode-option-copy";

  const title = document.createElement("span");
  title.className = "execution-mode-option-title";
  title.textContent = detail.label;

  const description = document.createElement("span");
  description.className = "execution-mode-option-description";
  description.id = `execution-mode-${mode}-description`;
  description.textContent = detail.description;

  const check = document.createElement("span");
  check.className = "execution-mode-option-check";
  check.setAttribute("aria-hidden", "true");
  check.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m5 10 3.1 3.1L15 6.8"/></svg>';

  copy.append(title, description);
  option.replaceChildren(copy, check);
  option.dataset.executionModeEnhanced = EXECUTION_MODE_VERSION;
  option.setAttribute("aria-describedby", description.id);
  option.title = `${detail.label}: ${detail.description}`;
}

function ensureToggleIndicator(toggle) {
  let indicator = toggle.querySelector(":scope > .execution-mode-toggle-indicator");
  if (indicator) return indicator;
  indicator = document.createElement("span");
  indicator.className = "execution-mode-toggle-indicator";
  indicator.setAttribute("aria-hidden", "true");
  toggle.prepend(indicator);
  return indicator;
}

function initializeExecutionModeSelector() {
  const wrapper = document.querySelector(".chat-input-wrapper");
  const surface = wrapper?.querySelector(":scope > .chat-input-area");
  const control = document.querySelector("#execution-mode-control");
  const toggle = document.querySelector("#execution-mode-toggle");
  const label = document.querySelector("#execution-mode-label");
  const menu = document.querySelector("#execution-mode-menu");
  const sendButton = surface?.querySelector("#send-btn");

  if (!wrapper || !surface || !control || !toggle || !label || !menu || !sendButton) return;
  if (control.dataset.executionModeVersion === EXECUTION_MODE_VERSION) return;

  control.dataset.executionModeVersion = EXECUTION_MODE_VERSION;
  wrapper.dataset.executionModeVersion = EXECUTION_MODE_VERSION;
  toggle.setAttribute("aria-label", "Choose execution mode");
  menu.setAttribute("aria-label", "Choose execution mode");
  ensureToggleIndicator(toggle);

  const options = Array.from(menu.querySelectorAll("[data-execution-mode]"));
  options.forEach(buildOptionContent);

  let placementSyncing = false;
  let syncFrame = 0;

  function stabilizePlacement() {
    if (placementSyncing || !surface.isConnected || !control.isConnected || !sendButton.isConnected) return;
    if (control.parentElement === surface && control.nextElementSibling === sendButton) return;
    placementSyncing = true;
    surface.insertBefore(control, sendButton);
    placementSyncing = false;
  }

  function syncSelection() {
    stabilizePlacement();

    const selected = options.find((option) => option.getAttribute("aria-selected") === "true")
      || options.find((option) => option.classList.contains("active"))
      || options[0];
    const selectedMode = getMode(selected);
    const detail = MODE_DETAILS[selectedMode];

    control.dataset.executionMode = selectedMode;
    toggle.dataset.executionMode = selectedMode;
    if (!control.classList.contains("guest-fast-only")) {
      toggle.title = `${detail.label} mode — ${detail.description}`;
      toggle.setAttribute(
        "aria-label",
        `${detail.label} execution mode. ${detail.description} Choose execution mode.`,
      );
    }

    if (!String(label.textContent || "").trim()) label.textContent = detail.label;

    options.forEach((option) => {
      const active = option === selected;
      setClass(option, "is-selected", active);
      option.dataset.selectionState = active ? "selected" : "available";
    });
  }

  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0;
      syncSelection();
    });
  }

  const controlObserver = new MutationObserver(scheduleSync);
  controlObserver.observe(control, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "aria-expanded", "aria-selected", "aria-hidden", "disabled"],
  });

  const bodyObserver = new MutationObserver(() => {
    if (control.parentElement !== surface) scheduleSync();
  });
  bodyObserver.observe(document.body, { childList: true });

  window.addEventListener("resize", scheduleSync, { passive: true });
  window.addEventListener("orientationchange", scheduleSync, { passive: true });

  toggle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!control.classList.contains("open")) toggle.click();
    window.requestAnimationFrame(() => {
      const selected = options.find((option) => option.getAttribute("aria-selected") === "true") || options[0];
      const target = event.key === "ArrowUp" ? options[options.length - 1] : selected;
      target?.focus();
    });
  });

  menu.addEventListener("keydown", (event) => {
    const activeIndex = Math.max(0, options.indexOf(document.activeElement));
    let targetIndex = activeIndex;
    if (event.key === "ArrowDown") targetIndex = (activeIndex + 1) % options.length;
    else if (event.key === "ArrowUp") targetIndex = (activeIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = options.length - 1;
    else if (event.key === "Escape" && control.classList.contains("open")) {
      event.preventDefault();
      toggle.click();
      toggle.focus();
      return;
    } else {
      return;
    }
    event.preventDefault();
    options[targetIndex]?.focus();
  });

  syncSelection();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeExecutionModeSelector, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
