/* ============================================================
   SentIQ Liquid Glass V4 — Phase 5.4
   Elevated liquid tool action sheet

   The existing action buttons and controller handlers remain authoritative.
   This module adds action-sheet semantics, concise purpose copy, capability
   reasons, and derived active states without introducing another tool store.
   ============================================================ */

const TOOL_ACTION_SHEET_READY_CLASS = "tool-action-sheet-ready";
const TOOL_ACTION_SHEET_VERSION = "5.4";

const ACTION_DEFINITIONS = Object.freeze({
  "file-attach-btn": {
    title: "Attach files",
    purpose: "Add documents or images to this message.",
    unavailable: "File attachment is unavailable right now.",
  },
  "image-gen-btn": {
    title: "Visualize",
    purpose: "Create an image from your prompt.",
    unavailable: "Image generation is unavailable right now.",
    hiddenReason: "Sign in to create images.",
  },
  "websurf-basic-btn": {
    title: "WebSurf",
    purpose: "Search current sources on the web.",
    unavailable: "WebSurf is unavailable right now.",
  },
  "deep-research-btn": {
    title: "Deep Research",
    purpose: "Build a cited, multi-source research report.",
    unavailable: "Deep Research is unavailable right now.",
    hiddenReason: "Not available for this account.",
  },
});

function setClass(element, className, enabled) {
  if (!element) return;
  const next = Boolean(enabled);
  if (element.classList.contains(className) !== next) element.classList.toggle(className, next);
}

function setData(element, key, value) {
  if (!element) return;
  const next = String(value ?? "");
  if (element.dataset[key] !== next) element.dataset[key] = next;
}

function setText(element, text) {
  if (element && element.textContent !== text) element.textContent = text;
}

function setHidden(element, hidden) {
  if (!element) return;
  const next = Boolean(hidden);
  if (element.hidden !== next) element.hidden = next;
}

function controllerHides(button) {
  return Boolean(button?.hidden || button?.style.display === "none");
}

function modeIsActive(mode) {
  if (!mode || mode.hidden || mode.getAttribute("aria-hidden") === "true") return false;
  return mode.style.display !== "none";
}

function cleanControllerReason(button) {
  const title = String(button?.getAttribute("title") || "").trim();
  if (!title) return "";
  if (!/(sign in|unavailable|not available|limit|upgrade|busy|finishing|wait|plan)/i.test(title)) return "";
  return /[.!?]$/.test(title) ? title : `${title}.`;
}

function ensureStateNode(button) {
  let state = button.querySelector(":scope > .composer-action-state");
  if (state) return state;

  state = document.createElement("span");
  state.className = "composer-action-state";
  state.hidden = true;
  button.appendChild(state);
  return state;
}

function ensureOptionCopy(button, definition) {
  const title = button.querySelector(".composer-action-title");
  const purpose = button.querySelector(".composer-action-subtitle");
  setText(title, definition.title);
  setText(purpose, definition.purpose);

  if (purpose && !purpose.id) purpose.id = `${button.id}-purpose`;
  const state = ensureStateNode(button);
  if (!state.id) state.id = `${button.id}-state`;
  return { purpose, state };
}

function manageSyntheticDisabledState(button, disabled) {
  const shouldManage = Boolean(disabled && !button.disabled);

  if (shouldManage) {
    if (button.getAttribute("aria-disabled") !== "true") {
      button.setAttribute("aria-disabled", "true");
      button.dataset.sheetManagedAriaDisabled = "true";
    }
    if (button.tabIndex !== -1) {
      button.tabIndex = -1;
      button.dataset.sheetManagedTabIndex = "true";
    }
    return;
  }

  if (button.dataset.sheetManagedAriaDisabled === "true") {
    button.removeAttribute("aria-disabled");
    delete button.dataset.sheetManagedAriaDisabled;
  }
  if (button.dataset.sheetManagedTabIndex === "true") {
    button.removeAttribute("tabindex");
    delete button.dataset.sheetManagedTabIndex;
  }
}

function initializeToolActionSheet() {
  const wrapper = document.querySelector(".chat-input-wrapper");
  const surface = wrapper?.querySelector(":scope > .chat-input-area");
  const menu = surface?.querySelector("#composer-action-menu");
  const plusButton = surface?.querySelector("#composer-plus-btn");
  const fileInput = surface?.querySelector("#file-input");
  const attachmentArea = surface?.querySelector("#file-preview-area");
  const modeByAction = new Map([
    ["image-gen-btn", surface?.querySelector("#image-mode-bar")],
    ["websurf-basic-btn", surface?.querySelector("#web-search-mode-bar")],
    ["deep-research-btn", surface?.querySelector("#deep-research-mode-bar")],
  ]);
  const buttons = Object.keys(ACTION_DEFINITIONS)
    .map((id) => surface?.querySelector(`#${id}`))
    .filter(Boolean);

  if (!wrapper || !surface || !menu || !plusButton || buttons.length !== 4) return;
  if (menu.classList.contains(TOOL_ACTION_SHEET_READY_CLASS)) return;

  menu.classList.add(TOOL_ACTION_SHEET_READY_CLASS);
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Tools and actions");
  menu.setAttribute("aria-orientation", "vertical");
  wrapper.dataset.toolActionSheetVersion = TOOL_ACTION_SHEET_VERSION;
  plusButton.setAttribute("aria-haspopup", "menu");
  plusButton.setAttribute("aria-label", "Open tools and actions");

  const copyNodes = new Map();
  buttons.forEach((button) => {
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-label", ACTION_DEFINITIONS[button.id].title);
    copyNodes.set(button.id, ensureOptionCopy(button, ACTION_DEFINITIONS[button.id]));
  });

  let syncFrame = 0;

  function sync() {
    syncFrame = 0;
    const responseLocked = surface.classList.contains("is-response-locked");
    const attachmentCount = attachmentArea?.querySelectorAll(".composer-attachment").length || 0;

    buttons.forEach((button) => {
      const definition = ACTION_DEFINITIONS[button.id];
      const { purpose, state } = copyNodes.get(button.id);
      const hiddenByController = controllerHides(button);
      const ariaDisabledByController = (
        button.getAttribute("aria-disabled") === "true"
        && button.dataset.sheetManagedAriaDisabled !== "true"
      );
      const disabledByController = Boolean(
        button.disabled
        || ariaDisabledByController
        || button.classList.contains("auth-disabled")
        || (button.id === "file-attach-btn" && fileInput?.disabled)
      );
      const disabled = responseLocked || hiddenByController || disabledByController;

      const mode = modeByAction.get(button.id);
      const active = button.id === "file-attach-btn"
        ? attachmentCount > 0
        : Boolean(
          modeIsActive(mode)
          || button.classList.contains("active")
          || button.getAttribute("aria-pressed") === "true"
        );

      let stateCopy = "";
      if (disabled) {
        if (responseLocked) stateCopy = "Available after the response.";
        else if (hiddenByController && definition.hiddenReason) stateCopy = definition.hiddenReason;
        else stateCopy = cleanControllerReason(button) || definition.unavailable;
      } else if (button.id === "file-attach-btn" && attachmentCount > 0) {
        stateCopy = `${attachmentCount} ${attachmentCount === 1 ? "file" : "files"} attached`;
      } else if (active) {
        stateCopy = "Active";
      }

      setData(button, "sheetState", disabled ? "disabled" : active ? "active" : "available");
      setClass(button, "is-sheet-active", active);
      setClass(button, "is-sheet-disabled", disabled);
      manageSyntheticDisabledState(button, disabled);
      setText(state, stateCopy);
      setHidden(state, !stateCopy);

      const describedBy = [purpose?.id, stateCopy ? state.id : ""].filter(Boolean).join(" ");
      if (describedBy && button.getAttribute("aria-describedby") !== describedBy) {
        button.setAttribute("aria-describedby", describedBy);
      }
    });

    const open = menu.classList.contains("open");
    setData(menu, "sheetOpen", open ? "true" : "false");
    if (plusButton.getAttribute("aria-label") !== (open ? "Close tools and actions" : "Open tools and actions")) {
      plusButton.setAttribute("aria-label", open ? "Close tools and actions" : "Open tools and actions");
    }
  }

  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(sync);
  }

  menu.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest(".composer-action-option")
      : null;
    if (!button || !menu.contains(button) || button.dataset.sheetState !== "disabled") return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  menu.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const enabled = buttons.filter((button) => button.dataset.sheetState !== "disabled" && !button.disabled);
    if (enabled.length === 0) return;

    event.preventDefault();
    const currentIndex = enabled.indexOf(document.activeElement);
    let nextIndex = 0;
    if (event.key === "End") nextIndex = enabled.length - 1;
    else if (event.key === "ArrowDown") nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % enabled.length;
    else if (event.key === "ArrowUp") nextIndex = currentIndex < 0 ? enabled.length - 1 : (currentIndex - 1 + enabled.length) % enabled.length;
    enabled[nextIndex]?.focus();
  });

  const observer = new MutationObserver(scheduleSync);
  observer.observe(surface, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "style", "disabled", "aria-disabled", "aria-pressed", "title"],
  });

  window.addEventListener("focus", scheduleSync);
  document.addEventListener("visibilitychange", scheduleSync);
  sync();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeToolActionSheet, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
