/* ============================================================
   SentIQ Liquid Glass V4 — Phase 6.2
   Compact user-message presentation
   ============================================================ */

const COMPACT_USER_MESSAGE_VERSION = "6.2";
const PENDING_CONTEXT_TTL_MS = 30000;

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const sendButton = document.getElementById("send-btn");
const selectedContextBar = document.getElementById("selected-context-bar");
const selectedContextText = document.getElementById("selected-context-text");
const clearSelectedContext = document.getElementById("clear-selected-context");

if (chatMessages) {
  let pendingSelectedContext = null;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function selectedContextIsActive() {
    const text = normalizeText(selectedContextText?.textContent);
    if (!text || !selectedContextBar) return false;
    if (selectedContextBar.hidden || selectedContextBar.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle?.(selectedContextBar);
    return !style || (style.display !== "none" && style.visibility !== "hidden");
  }

  function capturePendingSelectedContext() {
    if (!selectedContextIsActive()) {
      pendingSelectedContext = null;
      return;
    }

    pendingSelectedContext = {
      text: normalizeText(selectedContextText?.textContent),
      composerText: normalizeText(chatInput?.value),
      capturedAt: Date.now(),
    };
  }

  function getVisiblePromptText(content) {
    const explicitPrompt = content.querySelector(".message-attachment-prompt");
    if (explicitPrompt) return normalizeText(explicitPrompt.textContent);

    const copy = content.cloneNode(true);
    copy.querySelectorAll(
      ".message-attachment-list, .message-file-chip, .user-selected-context-indicator",
    ).forEach((node) => node.remove());
    return normalizeText(copy.textContent);
  }

  function createSelectedContextIndicator(context, visiblePrompt) {
    const indicator = document.createElement("div");
    indicator.className = "user-selected-context-indicator";
    indicator.setAttribute("role", "note");
    indicator.setAttribute("aria-label", "Selected text included");

    const icon = document.createElement("span");
    icon.className = "user-selected-context-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none"><path d="M5.4 5.5h3.4v3.7H6.9c0 1.8-.7 3-2.2 3.8"/><path d="M11.2 5.5h3.4v3.7h-1.9c0 1.8-.7 3-2.2 3.8"/></svg>';

    const copy = document.createElement("span");
    copy.className = "user-selected-context-copy";

    const label = document.createElement("span");
    label.className = "user-selected-context-label";
    label.textContent = "Selected text";
    copy.appendChild(label);

    const normalizedContext = normalizeText(context.text);
    const normalizedPrompt = normalizeText(visiblePrompt);
    if (normalizedContext && normalizedContext !== normalizedPrompt) {
      const excerpt = document.createElement("span");
      excerpt.className = "user-selected-context-excerpt";
      excerpt.textContent = normalizedContext.length > 180
        ? `${normalizedContext.slice(0, 177)}…`
        : normalizedContext;
      copy.appendChild(excerpt);
    }

    indicator.append(icon, copy);
    return indicator;
  }

  function consumePendingContext() {
    const context = pendingSelectedContext;
    pendingSelectedContext = null;
    if (!context || Date.now() - context.capturedAt > PENDING_CONTEXT_TTL_MS) return null;
    return context;
  }

  function enhanceUserMessage(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains("user")) return;
    if (message.dataset.compactUserMessageVersion === COMPACT_USER_MESSAGE_VERSION) return;

    message.dataset.compactUserMessageVersion = COMPACT_USER_MESSAGE_VERSION;
    message.setAttribute("role", "group");
    message.setAttribute("aria-label", "Your message");

    const header = message.querySelector(":scope > .message-header");
    if (header) header.setAttribute("aria-hidden", "true");

    const content = message.querySelector(":scope > .message-content");
    const context = consumePendingContext();
    if (!content || !context || content.querySelector(".user-selected-context-indicator")) return;

    const visiblePrompt = getVisiblePromptText(content) || context.composerText;
    content.prepend(createSelectedContextIndicator(context, visiblePrompt));
    message.dataset.hasSelectedContext = "true";
  }

  function enhanceAddedNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches(".message.user")) enhanceUserMessage(node);
    node.querySelectorAll?.(".message.user").forEach(enhanceUserMessage);
  }

  clearSelectedContext?.addEventListener("click", () => { pendingSelectedContext = null; }, true);
  sendButton?.addEventListener("click", capturePendingSelectedContext, true);
  chatInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    capturePendingSelectedContext();
  }, true);

  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach(enhanceAddedNode));
  });
  observer.observe(chatMessages, { childList: true });

  chatMessages.querySelectorAll(".message.user").forEach(enhanceUserMessage);
}
