import {
  STREAMING_POLISH_VERSION,
  deriveCompletedProcessSummary,
  hasSignificantProcessActivity,
  normalizeStreamingActivity,
} from "./streaming-polish-state.mjs";

const MESSAGE_SELECTOR = ".message.assistant";
const CONTENT_SELECTOR = ":scope > .message-content";
const ACTIVITY_SELECTOR = [
  ".response-inline-loader:not(.sentiq-streaming-handoff-ghost)",
  ".semantic-legacy-progress",
  ".semantic-surface-progress",
  "[data-semantic-activity-state]",
].join(", ");
const HANDOFF_GHOST_LIFETIME_MS = 220;

function initializeStreamingPolish() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQStreamingPolish?.version === STREAMING_POLISH_VERSION) return;

  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const messageStates = new WeakMap();
  const pendingMessages = new Map();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce), (update: slow)") || { matches: false };
  let syncFrame = 0;

  function now() {
    return window.performance?.now?.() || Date.now();
  }

  function getState(message) {
    let state = messageStates.get(message);
    if (state) return state;
    state = {
      startedAt: 0,
      completedAt: 0,
      wasStreaming: false,
      completed: false,
      handoffStarted: false,
      activities: new Set(),
      loaderSnapshot: null,
      loaderPosition: null,
      lastLoaderText: "",
    };
    messageStates.set(message, state);
    return state;
  }

  function rememberActivity(state, value) {
    const normalized = normalizeStreamingActivity(value);
    if (normalized) state.activities.add(normalized);
  }

  function captureActivity(message, content, state) {
    const activityNodes = content.querySelectorAll(ACTIVITY_SELECTOR);
    activityNodes.forEach((node) => {
      rememberActivity(state, node.getAttribute("data-semantic-activity-state"));
      rememberActivity(state, node.textContent);
    });
    rememberActivity(state, message.getAttribute("data-semantic-activity-state"));
    rememberActivity(state, message.dataset.loaderKind);

    const loader = content.querySelector(".response-inline-loader:not(.sentiq-streaming-handoff-ghost)");
    if (!(loader instanceof HTMLElement)) return null;
    state.lastLoaderText = String(loader.textContent || "").replace(/\s+/g, " ").trim();
    state.loaderSnapshot = loader.cloneNode(true);
    state.loaderPosition = {
      left: Math.round(loader.offsetLeft),
      top: Math.round(loader.offsetTop),
    };
    rememberActivity(state, state.lastLoaderText);
    return loader;
  }

  function sanitizeGhost(ghost) {
    ghost.removeAttribute("id");
    ghost.removeAttribute("role");
    ghost.removeAttribute("aria-live");
    ghost.removeAttribute("aria-atomic");
    ghost.setAttribute("aria-hidden", "true");
    ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    ghost.querySelectorAll("[role], [aria-live], [aria-atomic]").forEach((node) => {
      node.removeAttribute("role");
      node.removeAttribute("aria-live");
      node.removeAttribute("aria-atomic");
    });
  }

  function createHandoffGhost(content, state, removedLoader) {
    if (reducedMotion.matches || content.querySelector(":scope > .sentiq-streaming-handoff-ghost")) return;
    const source = removedLoader instanceof HTMLElement
      ? removedLoader
      : state.loaderSnapshot instanceof HTMLElement
        ? state.loaderSnapshot
        : null;
    if (!source) return;

    const ghost = source.cloneNode(true);
    if (!(ghost instanceof HTMLElement)) return;
    sanitizeGhost(ghost);
    ghost.classList.add("sentiq-streaming-handoff-ghost");
    ghost.style.insetInlineStart = `${Math.max(0, state.loaderPosition?.left || 0)}px`;
    ghost.style.insetBlockStart = `${Math.max(0, state.loaderPosition?.top || 0)}px`;
    content.appendChild(ghost);
    window.requestAnimationFrame(() => ghost.classList.add("is-leaving"));
    window.setTimeout(() => ghost.remove(), HANDOFF_GHOST_LIFETIME_MS);
  }

  function beginHandoff(content, state, removedLoader) {
    content.dataset.sentiqStreamingPhase = "streaming";
    if (state.handoffStarted) return;
    state.handoffStarted = true;
    content.classList.add("sentiq-streaming-handoff");
    createHandoffGhost(content, state, removedLoader);
    window.setTimeout(() => content.classList.remove("sentiq-streaming-handoff"), HANDOFF_GHOST_LIFETIME_MS);
  }

  function getThinkingPanel(content) {
    const panel = content.querySelector(":scope > .thinking-panel");
    return panel instanceof HTMLElement ? panel : null;
  }

  function getSummaryLabel(panel) {
    const toggle = panel?.querySelector(":scope > .thinking-toggle");
    if (!(toggle instanceof HTMLButtonElement)) return null;
    const spans = Array.from(toggle.querySelectorAll(":scope > span"));
    const label = spans.find((span) => !span.classList.contains("thinking-chevron"));
    return label instanceof HTMLElement ? { toggle, label } : null;
  }

  function buildSummary(state, hasThinking) {
    const finishedAt = state.completedAt || now();
    const elapsedMs = state.startedAt > 0 ? Math.max(0, finishedAt - state.startedAt) : 0;
    return deriveCompletedProcessSummary({
      elapsedMs,
      activities: Array.from(state.activities),
      hasThinking,
    });
  }

  function decorateThinkingPanel(content, state) {
    const panel = getThinkingPanel(content);
    if (!panel) return false;
    const parts = getSummaryLabel(panel);
    if (!parts) return false;

    const summary = buildSummary(state, true) || "Reasoning";
    panel.dataset.sentiqProcessSummary = summary;
    panel.dataset.sentiqStreamingPolish = STREAMING_POLISH_VERSION;
    parts.toggle.classList.add("sentiq-process-summary-toggle");
    parts.label.classList.add("sentiq-process-summary-label");
    if (parts.label.textContent !== summary) parts.label.textContent = summary;
    parts.toggle.setAttribute("aria-label", `${summary}. Expand to review.`);
    parts.toggle.setAttribute("title", `${summary}. Expand to review.`);
    return true;
  }

  function insertStandaloneProcessSummary(content, state) {
    if (content.querySelector(":scope > .sentiq-completed-process-summary")) return;
    const activities = Array.from(state.activities);
    if (!hasSignificantProcessActivity(activities)) return;
    const summary = buildSummary(state, false);
    if (!summary) return;

    const row = document.createElement("div");
    row.className = "sentiq-completed-process-summary";
    row.dataset.sentiqStreamingPolish = STREAMING_POLISH_VERSION;
    row.setAttribute("aria-label", summary);

    const mark = document.createElement("span");
    mark.className = "sentiq-completed-process-mark";
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "sentiq-completed-process-copy";
    copy.textContent = summary;
    row.append(mark, copy);
    content.prepend(row);
  }

  function completeMessage(content, state) {
    if (!state.completed) {
      state.completed = true;
      state.completedAt = now();
    }
    content.dataset.sentiqStreamingPhase = "complete";
    content.classList.remove("sentiq-streaming-handoff");
    content.querySelectorAll(":scope > .sentiq-streaming-handoff-ghost").forEach((ghost) => ghost.remove());
    if (!decorateThinkingPanel(content, state)) insertStandaloneProcessSummary(content, state);
  }

  function syncMessage(message, removedLoader = null) {
    if (!(message instanceof HTMLElement) || !message.matches(MESSAGE_SELECTOR)) return;
    const content = message.querySelector(CONTENT_SELECTOR);
    if (!(content instanceof HTMLElement)) return;

    const state = getState(message);
    message.dataset.sentiqStreamingPolish = STREAMING_POLISH_VERSION;
    content.dataset.sentiqStreamingPolish = STREAMING_POLISH_VERSION;

    const loader = captureActivity(message, content, state);
    const streaming = content.classList.contains("typing-active");
    const tail = content.querySelector(":scope > .streaming-tail");
    const hasVisibleTail = Boolean(tail?.textContent?.trim());

    if (streaming) {
      if (!state.startedAt) state.startedAt = now();
      state.wasStreaming = true;
      state.completed = false;
      if (loader) {
        content.dataset.sentiqStreamingPhase = "waiting";
      } else if (hasVisibleTail || removedLoader) {
        beginHandoff(content, state, removedLoader);
      }
      return;
    }

    if (state.wasStreaming) completeMessage(content, state);
    else decorateThinkingPanel(content, state);
  }

  function scheduleMessage(message, removedLoader = null) {
    if (!(message instanceof HTMLElement) || !message.matches(MESSAGE_SELECTOR)) return;
    const existing = pendingMessages.get(message);
    pendingMessages.set(message, removedLoader || existing || null);
    if (syncFrame) return;
    syncFrame = window.requestAnimationFrame(() => {
      syncFrame = 0;
      const batch = Array.from(pendingMessages.entries());
      pendingMessages.clear();
      batch.forEach(([item, loader]) => syncMessage(item, loader));
    });
  }

  function findMessage(node, fallback = null) {
    const element = node instanceof Element
      ? node
      : node?.parentElement instanceof Element
        ? node.parentElement
        : fallback instanceof Element
          ? fallback
          : null;
    if (!element) return null;
    const message = element.matches(MESSAGE_SELECTOR) ? element : element.closest(MESSAGE_SELECTOR);
    return message instanceof HTMLElement ? message : null;
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      const message = findMessage(record.target);
      let removedLoader = null;
      record.removedNodes.forEach((node) => {
        if (removedLoader) return;
        const element = node instanceof HTMLElement ? node : null;
        if (!element) return;
        if (element.matches(".response-inline-loader:not(.sentiq-streaming-handoff-ghost)")) removedLoader = element;
        else removedLoader = element.querySelector?.(".response-inline-loader:not(.sentiq-streaming-handoff-ghost)") || null;
      });
      if (message) scheduleMessage(message, removedLoader);

      record.addedNodes.forEach((node) => {
        const addedMessage = findMessage(node, record.target);
        if (addedMessage) scheduleMessage(addedMessage);
        if (node instanceof Element) node.querySelectorAll?.(MESSAGE_SELECTOR).forEach((item) => scheduleMessage(item));
      });
    });
  });

  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "data-semantic-activity-state", "data-loader-kind"],
  });
  chatMessages.querySelectorAll(MESSAGE_SELECTOR).forEach((message) => scheduleMessage(message));

  window.SentIQStreamingPolish = Object.freeze({
    version: STREAMING_POLISH_VERSION,
    sync() {
      chatMessages.querySelectorAll(MESSAGE_SELECTOR).forEach((message) => scheduleMessage(message));
    },
  });
}

initializeStreamingPolish();
