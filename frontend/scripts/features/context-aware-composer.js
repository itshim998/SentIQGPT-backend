/* ============================================================
   SentIQ Liquid Glass V4 — Phase 5.3
   Context-aware composer controls

   Existing controller state remains authoritative. This module reads the
   established textarea, attachment, tool, Live, Send, Stop, and selected-text
   states and exposes one coherent presentation/accessibility state.
   ============================================================ */

const CONTEXT_READY_CLASS = "context-aware-composer-ready";
const PRIMARY_MODE_CLASS = "is-context-primary";
const SUPPRESSED_MODE_CLASS = "is-context-suppressed";
const MODE_PRIORITY = [
  "deep-research-mode-bar",
  "web-search-mode-bar",
  "image-mode-bar",
];

function elementIsVisible(element) {
  if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function modeIsControllerActive(element) {
  if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  return element.style.display !== "none";
}

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

function setAttribute(element, name, value) {
  if (!element) return;
  const next = String(value);
  if (element.getAttribute(name) !== next) element.setAttribute(name, next);
}

function setHidden(element, hidden) {
  if (!element) return;
  const next = Boolean(hidden);
  if (element.hidden !== next) element.hidden = next;
  setAttribute(element, "aria-hidden", next ? "true" : "false");
}

function ensureComposerStatus(surface) {
  let status = surface.querySelector("#composer-action-status");
  if (status) return status;

  status = document.createElement("span");
  status.id = "composer-action-status";
  status.className = "composer-action-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.hidden = true;
  surface.appendChild(status);
  return status;
}

function resolveAttachmentState(attachmentArea) {
  const attachments = Array.from(attachmentArea?.querySelectorAll(".composer-attachment") || []);
  if (attachments.length === 0) return { state: "none", count: 0 };

  const failed = attachments.some((attachment) => (
    attachment.classList.contains("is-failed")
    || Boolean(attachment.querySelector(".composer-attachment-retry"))
    || attachment.dataset.status === "failed"
    || attachment.dataset.state === "failed"
  ));
  if (failed) return { state: "failed", count: attachments.length };

  const uploading = attachments.some((attachment) => (
    Boolean(attachment.querySelector(".composer-attachment-spinner"))
    || attachment.getAttribute("aria-busy") === "true"
    || ["uploading", "processing", "analyzing", "pending"].includes(attachment.dataset.status)
    || ["uploading", "processing", "analyzing", "pending"].includes(attachment.dataset.state)
  ));
  if (uploading) return { state: "uploading", count: attachments.length };

  return { state: "ready", count: attachments.length };
}

function selectPrimaryMode(modeBars) {
  const active = modeBars.filter(modeIsControllerActive);
  const primary = MODE_PRIORITY
    .map((id) => active.find((mode) => mode.id === id))
    .find(Boolean) || active[0] || null;

  modeBars.forEach((mode) => {
    const isActive = active.includes(mode);
    setClass(mode, PRIMARY_MODE_CLASS, mode === primary);
    setClass(mode, SUPPRESSED_MODE_CLASS, isActive && mode !== primary);
    if (!isActive) {
      setClass(mode, PRIMARY_MODE_CLASS, false);
      setClass(mode, SUPPRESSED_MODE_CLASS, false);
    }
  });

  return primary;
}

function getModeName(mode) {
  if (!mode) return "none";
  if (mode.id === "deep-research-mode-bar") return "deep-research";
  if (mode.id === "web-search-mode-bar") return "websurf";
  if (mode.id === "image-mode-bar") return "visualize";
  return "tool";
}

function getReadinessCopy(fileState, hasPrompt) {
  const { state, count } = fileState;
  const noun = count === 1 ? "file" : "files";
  if (state === "uploading") return `Preparing ${count > 1 ? `${count} ` : ""}${noun}`;
  if (state === "failed") return `Review ${count > 1 ? `${count} ` : ""}${noun}`;
  if (state === "ready" && !hasPrompt) return "Add a message";
  if (state === "ready") return `${count > 1 ? `${count} files` : "File"} ready`;
  return "";
}

function initializeContextAwareComposer() {
  const wrapper = document.querySelector(".chat-input-wrapper");
  const surface = wrapper?.querySelector(":scope > .chat-input-area");
  const textarea = surface?.querySelector("#chat-input");
  const attachmentArea = surface?.querySelector("#file-preview-area");
  const sendButton = surface?.querySelector("#send-btn");
  const liveButton = surface?.querySelector("#live-beta-btn");
  const selectedContextBar = wrapper?.querySelector("#selected-context-bar");
  const modeBars = Array.from(surface?.querySelectorAll(".composer-mode-pill") || []);

  if (!wrapper || !surface || !textarea || !attachmentArea || !sendButton) return;
  if (surface.classList.contains(CONTEXT_READY_CLASS)) return;

  const status = ensureComposerStatus(surface);
  surface.classList.add(CONTEXT_READY_CLASS);
  wrapper.dataset.composerContextVersion = "5.3";

  let syncFrame = 0;

  function sync() {
    syncFrame = 0;

    const hasText = Boolean(textarea.value.trim());
    const selectedContextActive = elementIsVisible(selectedContextBar);
    const primaryMode = selectPrimaryMode(modeBars);
    const modeName = getModeName(primaryMode);
    const fileState = resolveAttachmentState(attachmentArea);
    const hasPrompt = hasText || selectedContextActive;
    const stopActive = sendButton.classList.contains("is-stop") || surface.classList.contains("is-response-locked");
    const liveVisible = elementIsVisible(liveButton);
    const sendVisible = elementIsVisible(sendButton);

    let actionState = "send";
    if (stopActive) actionState = "stop";
    else if (liveVisible) actionState = "live";

    let composerState = "empty";
    if (stopActive) composerState = "streaming";
    else if (fileState.state === "uploading") composerState = "files-uploading";
    else if (fileState.state === "failed") composerState = "files-failed";
    else if (fileState.state === "ready" && !hasPrompt) composerState = "files-need-prompt";
    else if (fileState.state === "ready") composerState = "files-ready";
    else if (hasText) composerState = "text";
    else if (primaryMode) composerState = "tool";
    else if (selectedContextActive) composerState = "selected-context";
    else if (liveVisible) composerState = "empty-live";

    setData(surface, "actionState", actionState);
    setData(surface, "composerContext", composerState);
    setData(surface, "inputState", hasText ? "text" : "empty");
    setData(surface, "fileState", fileState.state);
    setData(surface, "activeToolMode", modeName);
    setData(wrapper, "selectedContext", selectedContextActive ? "active" : "none");

    setClass(wrapper, "composer-has-selected-context", selectedContextActive);
    setClass(surface, "composer-has-readiness", fileState.state !== "none");
    setClass(surface, "composer-has-primary-mode", Boolean(primaryMode));

    const readinessCopy = getReadinessCopy(fileState, hasPrompt);
    if (status.textContent !== readinessCopy) status.textContent = readinessCopy;
    setHidden(status, !readinessCopy);

    if (readinessCopy && sendVisible && actionState === "send") {
      setAttribute(sendButton, "aria-describedby", status.id);
    } else if (sendButton.getAttribute("aria-describedby") === status.id) {
      sendButton.removeAttribute("aria-describedby");
    }

    if (actionState === "stop") {
      setAttribute(sendButton, "aria-label", "Stop response");
      setAttribute(sendButton, "title", "Stop response");
    } else if (fileState.state === "uploading") {
      setAttribute(sendButton, "aria-label", "Preparing files before sending");
      setAttribute(sendButton, "title", "Preparing files before sending");
    } else if (fileState.state === "failed") {
      setAttribute(sendButton, "aria-label", "Review failed attachments before sending");
      setAttribute(sendButton, "title", "Review failed attachments before sending");
    } else if (fileState.state === "ready" && !hasPrompt) {
      setAttribute(sendButton, "aria-label", "Add a message before sending attachments");
      setAttribute(sendButton, "title", "Add a message before sending attachments");
    } else if (fileState.state === "ready") {
      setAttribute(sendButton, "aria-label", "Send message with attachments");
      setAttribute(sendButton, "title", "Send message with attachments");
    } else {
      setAttribute(sendButton, "aria-label", "Send message");
      setAttribute(sendButton, "title", "Send message");
    }

    if (liveButton) {
      setData(liveButton, "contextPrimary", liveVisible && !liveButton.classList.contains("is-disabled") ? "true" : "false");
    }
  }

  function scheduleSync() {
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(sync);
  }

  textarea.addEventListener("input", scheduleSync);
  textarea.addEventListener("change", scheduleSync);
  textarea.addEventListener("compositionend", scheduleSync);

  const surfaceObserver = new MutationObserver(scheduleSync);
  surfaceObserver.observe(surface, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "style", "disabled", "aria-hidden", "aria-busy", "data-status", "data-state"],
  });

  if (selectedContextBar) {
    const contextObserver = new MutationObserver(scheduleSync);
    contextObserver.observe(selectedContextBar, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "style", "aria-hidden"],
    });
  }

  window.addEventListener("focus", scheduleSync);
  document.addEventListener("visibilitychange", scheduleSync);

  sync();
}

if (typeof document !== "undefined") {
  const start = () => window.setTimeout(initializeContextAwareComposer, 0);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
