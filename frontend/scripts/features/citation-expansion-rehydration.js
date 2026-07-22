/* SentIQ Chat — Pass 11.5 controlled citation expansion rehydration */

const CITATION_EXPANSION_VERSION = "11.5";
const PANEL_SELECTOR = ".websurf-v2-source-explorer, .websurf-v2-citation-group";
const ACTIVE_HISTORY_SELECTOR = [
  "[data-chat-id].active",
  "[data-chat-id][aria-current='page']",
  ".chat-item.active",
  ".chat-list-item.active",
  ".conversation-item.active",
  "[data-id].active",
].join(",");

function initializeCitationExpansionRehydration() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQCitationExpansion?.version === CITATION_EXPANSION_VERSION) return;

  const chatMessages = document.getElementById("chat-messages");
  const chatList = document.getElementById("chat-list");
  if (!(chatMessages instanceof HTMLElement)) return;

  const states = new Map();
  const cleanup = [];
  const observers = [];
  let currentConversationKey = "";
  let frame = 0;
  let settleTimer = 0;
  let generation = 0;

  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  function getMessageSignature(message) {
    if (!(message instanceof HTMLElement)) return "";
    const explicit = message.id
      || message.dataset.requestId
      || message.dataset.messageId
      || message.dataset.chatId;
    if (explicit) return String(explicit).slice(0, 160);
    const role = message.classList.contains("assistant") ? "assistant" : "user";
    const text = String(message.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
    return `${role}:${text}`;
  }

  function readConversationKey() {
    const active = chatList?.querySelector?.(ACTIVE_HISTORY_SELECTOR);
    const activeId = active?.dataset?.chatId
      || active?.getAttribute?.("data-id")
      || active?.getAttribute?.("data-conversation-id")
      || active?.id;
    if (activeId) return `chat:${String(activeId).trim()}`;
    const messageChatId = chatMessages.querySelector(".message[data-chat-id]")?.dataset?.chatId;
    if (messageChatId) return `chat:${messageChatId}`;
    const first = chatMessages.querySelector(":scope > .message");
    return first ? `view:${getMessageSignature(first) || "conversation"}` : "view:empty";
  }

  function getToggle(panel) {
    if (!(panel instanceof HTMLElement)) return null;
    return panel.querySelector(":scope > [aria-expanded][aria-controls], [aria-expanded][aria-controls]");
  }

  function getPanelKey(panel) {
    if (!(panel instanceof HTMLElement)) return "";
    const message = panel.closest(".message");
    if (!(message instanceof HTMLElement)) return "";
    const panels = Array.from(message.querySelectorAll(PANEL_SELECTOR));
    const index = panels.indexOf(panel);
    const signature = getMessageSignature(message);
    return signature && index >= 0 ? `${signature}:${index}` : "";
  }

  function isExpanded(panel) {
    return getToggle(panel)?.getAttribute("aria-expanded") === "true";
  }

  function setExpanded(panel, expanded) {
    const toggle = getToggle(panel);
    if (!(toggle instanceof HTMLElement)) return;
    const next = Boolean(expanded);
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
    const controlledId = toggle.getAttribute("aria-controls");
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    if (controlled instanceof HTMLElement && panel.contains(controlled)) controlled.hidden = !next;
    panel.classList.toggle("is-expanded", next);
    panel.dataset.citationExpansionRehydration = next ? "expanded" : "collapsed";
  }

  function capture(reason = "capture") {
    const key = currentConversationKey || readConversationKey();
    if (!key || key === "view:empty") return null;
    const expansion = {};
    chatMessages.querySelectorAll(PANEL_SELECTOR).forEach((panel) => {
      const panelKey = getPanelKey(panel);
      if (panelKey && isExpanded(panel)) expansion[panelKey] = true;
    });
    states.delete(key);
    states.set(key, Object.freeze({ expansion: Object.freeze(expansion), capturedAt: Date.now(), reason }));
    while (states.size > 12) states.delete(states.keys().next().value);
    return states.get(key);
  }

  function restore(key, reason = "restore") {
    const state = states.get(key);
    chatMessages.querySelectorAll(PANEL_SELECTOR).forEach((panel) => {
      const panelKey = getPanelKey(panel);
      setExpanded(panel, Boolean(state?.expansion?.[panelKey]));
    });
    chatMessages.dataset.citationExpansionRehydration = state ? "restored" : "fresh";
    window.SentIQFrameDiscipline?.scheduleScrollAnchor?.(
      `citation-expansion:${reason}`,
      { userInitiated: true },
    );
  }

  function scheduleRestore(reason = "conversation") {
    generation += 1;
    const run = generation;
    window.cancelAnimationFrame(frame);
    window.clearTimeout(settleTimer);
    chatMessages.dataset.citationExpansionRehydration = "pending";
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (run !== generation) return;
      const key = readConversationKey();
      currentConversationKey = key;
      restore(key, reason);
      settleTimer = window.setTimeout(() => {
        if (run === generation) restore(key, "settled");
      }, 180);
    });
  }

  function scheduleCapture(reason) {
    window.requestAnimationFrame(() => capture(reason));
  }

  listen(chatMessages, "click", (event) => {
    if (!event.target?.closest?.(PANEL_SELECTOR)) return;
    scheduleCapture("click");
  }, true);
  listen(chatMessages, "focusout", (event) => {
    if (!event.target?.closest?.(PANEL_SELECTOR)) return;
    scheduleCapture("focusout");
  }, true);
  listen(chatMessages, "keydown", (event) => {
    if (event.key === "Escape" && event.target?.closest?.(PANEL_SELECTOR)) scheduleCapture("escape");
  }, true);

  if (chatList instanceof HTMLElement) {
    listen(chatList, "pointerdown", () => capture("history-intent"), { capture: true, passive: true });
    const historyObserver = new MutationObserver(() => {
      if (readConversationKey() !== currentConversationKey) scheduleRestore("history-state");
    });
    historyObserver.observe(chatList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-current"],
    });
    observers.push(historyObserver);
  }

  const messageObserver = new MutationObserver((records) => {
    const replaced = records.some((record) => record.type === "childList" && (
      record.addedNodes.length > 0 || record.removedNodes.length > 0
    ));
    if (replaced || readConversationKey() !== currentConversationKey) scheduleRestore("message-replacement");
  });
  messageObserver.observe(chatMessages, { childList: true, subtree: false });
  observers.push(messageObserver);

  currentConversationKey = readConversationKey();
  chatMessages.dataset.citationExpansionVersion = CITATION_EXPANSION_VERSION;
  scheduleRestore("initial");

  window.SentIQCitationExpansion = Object.freeze({
    version: CITATION_EXPANSION_VERSION,
    capture,
    restore: scheduleRestore,
    getState() {
      return Object.freeze({
        conversationKey: currentConversationKey,
        savedConversations: states.size,
        generation,
      });
    },
    destroy() {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      observers.forEach((observer) => observer.disconnect());
      cleanup.splice(0).forEach((dispose) => dispose());
      states.clear();
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeCitationExpansionRehydration, { once: true });
} else {
  initializeCitationExpansionRehydration();
}
