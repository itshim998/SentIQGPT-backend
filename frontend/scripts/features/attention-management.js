/* SentIQ Liquid Glass V4 — Phase 9.5 attention management */

import {
  ATTENTION_MANAGEMENT_VERSION,
  ATTENTION_DEDUPE_WINDOW_MS,
  MAX_ATTENTION_QUEUE,
  coalesceAttentionQueue,
  deriveLatestChatOutcome,
  deriveOutcomeSignal,
  normalizeAttentionSignal,
  pruneRecentSignals,
  rememberAcceptedSignal,
  shouldAcceptSignal,
} from "./attention-management-model.mjs";

const CHAT_POLL_INTERVAL_MS = 4_000;
const ANNOUNCEMENT_DURATION_MS = 4_200;
const FAILURE_ANNOUNCEMENT_DURATION_MS = 5_200;
const OFFLINE_CONFIRM_DELAY_MS = 1_200;
const DOM_BASELINE_WINDOW_MS = 1_200;
const IMAGE_RESULT_SELECTOR = ".image-generation-card";
const FILE_FAILURE_SELECTOR = [
  ".composer-attachment[data-attachment-state='failed']",
  ".composer-attachment.is-failed",
  ".composer-attachment[aria-invalid='true']",
  ".composer-attachment .composer-attachment-error",
].join(", ");

function initializeAttentionManagement() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQAttentionManagement?.version === ATTENTION_MANAGEMENT_VERSION) return;

  const Storage = window.SentIQStorage;
  if (!Storage?.getAllChats) return;

  const chatList = document.getElementById("chat-list");
  const chatMessages = document.getElementById("chat-messages");
  const filePreviewArea = document.getElementById("file-preview-area");
  const recentSignals = new Map();
  const outcomesByChat = new Map();
  const attentionByChat = new Map();
  const subscribers = new Set();

  let activeConversationId = "";
  let scope = String(window.SentIQConversationContinuity?.getScope?.() || Storage.getActiveUserId?.() || "guest");
  let scopeEpoch = 0;
  let baselineReady = false;
  let pollBusyEpoch = -1;
  let pollTimer = 0;
  let decorateFrame = 0;
  let announcementTimer = 0;
  let currentAnnouncement = null;
  let queue = [];
  let offlineTimer = 0;
  let offlineConfirmed = typeof navigator !== "undefined" && navigator.onLine === false;
  let domReady = false;
  let domBaselineUntil = 0;
  let domBaselineFrame = 0;
  let seenImageSignatures = new Set();
  let seenFileFailureSignatures = new Set();

  function currentScope() {
    return String(window.SentIQConversationContinuity?.getScope?.() || Storage.getActiveUserId?.() || scope || "guest");
  }

  function currentConversation() {
    return String(
      chatList?.querySelector(".chat-list-item.active[data-id]")?.getAttribute("data-id")
        || window.SentIQConversationContinuity?.getConversationId?.()
        || activeConversationId
        || "",
    );
  }

  function createStatusRoot() {
    let root = document.getElementById("sentiq-attention-status");
    if (root) return root;
    root = document.createElement("section");
    root.id = "sentiq-attention-status";
    root.className = "sentiq-attention-status";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-atomic", "true");
    root.innerHTML = [
      '<span class="sentiq-attention-status-mark" aria-hidden="true"></span>',
      '<span class="sentiq-attention-status-copy">',
      '<strong class="sentiq-attention-status-title"></strong>',
      '<span class="sentiq-attention-status-detail"></span>',
      "</span>",
      '<button type="button" class="sentiq-attention-status-open" hidden>Open</button>',
      '<button type="button" class="sentiq-attention-status-dismiss" aria-label="Dismiss status">×</button>',
    ].join("");
    document.body.appendChild(root);
    root.querySelector(".sentiq-attention-status-dismiss")?.addEventListener("click", dismissAnnouncement);
    root.querySelector(".sentiq-attention-status-open")?.addEventListener("click", () => {
      const chatId = currentAnnouncement?.chatId;
      dismissAnnouncement();
      if (!chatId) return;
      const selector = `.chat-list-item[data-id="${escapeAttributeValue(chatId)}"]`;
      const item = chatList?.querySelector(selector);
      item?.click?.();
    });
    return root;
  }

  function escapeAttributeValue(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function setAttributeIfChanged(element, name, value) {
    if (!(element instanceof Element)) return;
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function notifySubscribers(reason) {
    const snapshot = getPublicState();
    subscribers.forEach((listener) => {
      try { listener(snapshot, reason); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-attention-state-change", {
      detail: { ...snapshot, reason },
    }));
  }

  function getPublicState() {
    return Object.freeze({
      version: ATTENTION_MANAGEMENT_VERSION,
      scope,
      activeConversationId,
      announcement: currentAnnouncement,
      queued: queue.slice(),
      chats: Object.fromEntries(attentionByChat),
      connection: offlineConfirmed ? "offline" : "online",
    });
  }

  function markerLabel(signal) {
    if (signal.kind === "file-analysis-failed") return "File issue";
    if (signal.kind === "research-complete") return "Research";
    if (signal.kind === "image-complete") return "Image";
    return "Ready";
  }

  function decorateItem(item) {
    if (!(item instanceof HTMLElement)) return;
    const conversationId = item.getAttribute("data-id") || "";
    const active = conversationId === activeConversationId || item.classList.contains("active");
    const signal = active ? null : attentionByChat.get(conversationId) || null;
    let marker = item.querySelector(":scope > .conversation-attention-marker");

    if (!signal) {
      marker?.remove();
      item.classList.remove("has-attention-signal");
      item.removeAttribute("data-attention-kind");
      return;
    }

    item.classList.add("has-attention-signal");
    setAttributeIfChanged(item, "data-attention-kind", signal.kind);
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "conversation-attention-marker";
      marker.innerHTML = '<span class="conversation-attention-dot" aria-hidden="true"></span><span class="conversation-attention-label"></span>';
      const firstAction = item.querySelector(".chat-rename-btn, .chat-delete-btn");
      item.insertBefore(marker, firstAction || null);
    }
    setAttributeIfChanged(marker, "data-attention-kind", signal.kind);
    const label = marker.querySelector(".conversation-attention-label");
    const shortLabel = markerLabel(signal);
    if (label && label.textContent !== shortLabel) label.textContent = shortLabel;
    const accessibleLabel = `${signal.title} in this conversation`;
    setAttributeIfChanged(marker, "aria-label", accessibleLabel);
    if (marker.title !== accessibleLabel) marker.title = accessibleLabel;
  }

  function decorateConversationList() {
    decorateFrame = 0;
    activeConversationId = currentConversation();
    chatList?.querySelectorAll(".chat-list-item[data-id]").forEach(decorateItem);
  }

  function scheduleDecoration() {
    if (decorateFrame) return;
    decorateFrame = window.requestAnimationFrame(decorateConversationList);
  }

  function dismissAnnouncement() {
    window.clearTimeout(announcementTimer);
    announcementTimer = 0;
    const root = createStatusRoot();
    root.hidden = true;
    root.removeAttribute("data-attention-kind");
    root.removeAttribute("data-attention-chat");
    document.documentElement.removeAttribute("data-sentiq-attention-visible");
    currentAnnouncement = null;
    window.setTimeout(showNextAnnouncement, 120);
  }

  function showNextAnnouncement() {
    if (currentAnnouncement || !queue.length || document.visibilityState === "hidden") return;
    const signal = queue.shift();
    currentAnnouncement = signal;
    const root = createStatusRoot();
    const title = root.querySelector(".sentiq-attention-status-title");
    const detail = root.querySelector(".sentiq-attention-status-detail");
    const openButton = root.querySelector(".sentiq-attention-status-open");
    if (title) title.textContent = signal.title;
    if (detail) {
      detail.textContent = signal.detail;
      detail.hidden = !signal.detail;
    }
    if (openButton instanceof HTMLButtonElement) {
      const canOpen = Boolean(signal.chatId && signal.chatId !== activeConversationId);
      openButton.hidden = !canOpen;
      openButton.disabled = !canOpen;
    }
    setAttributeIfChanged(root, "data-attention-kind", signal.kind);
    if (signal.chatId) setAttributeIfChanged(root, "data-attention-chat", signal.chatId);
    else root.removeAttribute("data-attention-chat");
    root.hidden = false;
    setAttributeIfChanged(document.documentElement, "data-sentiq-attention-visible", signal.kind);
    const duration = signal.kind === "file-analysis-failed"
      ? FAILURE_ANNOUNCEMENT_DURATION_MS
      : ANNOUNCEMENT_DURATION_MS;
    announcementTimer = window.setTimeout(dismissAnnouncement, duration);
    notifySubscribers("announcement-shown");
  }

  function enqueueSignal(input, options = {}) {
    const signal = normalizeAttentionSignal(input);
    const now = Date.now();
    pruneRecentSignals(recentSignals, now);
    if (!options.force && !shouldAcceptSignal(signal, recentSignals, now, ATTENTION_DEDUPE_WINDOW_MS)) return false;
    rememberAcceptedSignal(signal, recentSignals, now);

    const inactive = Boolean(signal.chatId && signal.chatId !== activeConversationId);
    if (inactive) {
      const existing = attentionByChat.get(signal.chatId);
      if (!existing || signal.updatedAt >= existing.updatedAt) attentionByChat.set(signal.chatId, signal);
      scheduleDecoration();
    }

    queue = coalesceAttentionQueue(queue, signal, MAX_ATTENTION_QUEUE);
    showNextAnnouncement();
    notifySubscribers("signal-enqueued");
    return true;
  }

  function acknowledgeConversation(conversationId) {
    const id = String(conversationId || "");
    if (!id) return false;
    const changed = attentionByChat.delete(id);
    queue = queue.filter((signal) => signal.chatId !== id);
    if (currentAnnouncement?.chatId === id) dismissAnnouncement();
    if (changed) {
      scheduleDecoration();
      notifySubscribers("conversation-acknowledged");
    }
    return changed;
  }

  function outcomeMapForChats(chats, now) {
    const next = new Map();
    for (const chat of chats) {
      if (!chat?.id) continue;
      const outcome = deriveLatestChatOutcome(chat, now);
      if (outcome) next.set(String(chat.id), outcome);
    }
    return next;
  }

  async function pollChats(reason = "interval") {
    const epoch = scopeEpoch;
    if (pollBusyEpoch === epoch) return;
    pollBusyEpoch = epoch;
    try {
      const chats = await Storage.getAllChats().catch(() => []);
      if (epoch !== scopeEpoch || currentScope() !== scope) return;
      const now = Date.now();
      const nextOutcomes = outcomeMapForChats(Array.isArray(chats) ? chats : [], now);
      const activeId = currentConversation();
      activeConversationId = activeId;

      if (baselineReady) {
        for (const [chatId, nextOutcome] of nextOutcomes) {
          const previousOutcome = outcomesByChat.get(chatId);
          const signal = deriveOutcomeSignal(previousOutcome, nextOutcome, {
            chatId,
            active: chatId === activeId,
            source: reason,
          });
          if (signal) enqueueSignal(signal);
        }
      }

      outcomesByChat.clear();
      nextOutcomes.forEach((value, key) => outcomesByChat.set(key, value));
      const visibleIds = new Set((Array.isArray(chats) ? chats : []).map((chat) => String(chat?.id || "")).filter(Boolean));
      for (const chatId of attentionByChat.keys()) {
        if (!visibleIds.has(chatId)) attentionByChat.delete(chatId);
      }
      baselineReady = true;
      scheduleDecoration();
    } finally {
      if (pollBusyEpoch === epoch) pollBusyEpoch = -1;
    }
  }

  function schedulePoll(delay = 0, reason = "scheduled") {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => {
      void pollChats(reason);
    }, Math.max(0, delay));
  }

  function startPollLoop() {
    window.clearInterval(startPollLoop.intervalId);
    startPollLoop.intervalId = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void pollChats("interval");
    }, CHAT_POLL_INTERVAL_MS);
  }
  startPollLoop.intervalId = 0;

  function nodeSignature(element, kind) {
    if (!(element instanceof Element)) return "";
    const message = element.closest(".message");
    const source = element.closest(".composer-attachment") || element;
    const identity = [
      message?.getAttribute("data-message-id"),
      message?.id,
      source.getAttribute("data-attachment-id"),
      source.getAttribute("data-analysis-id"),
      source.getAttribute("data-id"),
      source.querySelector("img")?.getAttribute("src"),
      source.textContent,
    ].filter(Boolean).join(":").replace(/\s+/g, " ").slice(0, 280);
    return `${kind}:${activeConversationId || "active"}:${identity || source.className}`;
  }

  function collectImageResults(root, emit) {
    if (!(root instanceof Element)) return;
    const results = [];
    if (root.matches(IMAGE_RESULT_SELECTOR)) results.push(root);
    root.querySelectorAll?.(IMAGE_RESULT_SELECTOR).forEach((element) => results.push(element));
    results.forEach((element) => {
      const signature = nodeSignature(element, "image");
      if (!signature || seenImageSignatures.has(signature)) return;
      seenImageSignatures.add(signature);
      if (!emit) return;
      enqueueSignal({
        kind: "image-complete",
        chatId: activeConversationId,
        signature,
        updatedAt: Date.now(),
        source: "active-thread",
      });
    });
  }

  function fileFailureRoot(element) {
    if (!(element instanceof Element)) return null;
    if (element.matches(FILE_FAILURE_SELECTOR)) return element.closest(".composer-attachment") || element;
    const closest = element.closest(FILE_FAILURE_SELECTOR);
    if (closest) return closest.closest(".composer-attachment") || closest;
    const child = element.querySelector(FILE_FAILURE_SELECTOR);
    return child?.closest(".composer-attachment") || child || null;
  }

  function collectFileFailures(root, emit) {
    if (!(root instanceof Element)) return;
    const candidates = new Set();
    const direct = fileFailureRoot(root);
    if (direct) candidates.add(direct);
    root.querySelectorAll?.(FILE_FAILURE_SELECTOR).forEach((element) => {
      candidates.add(element.closest(".composer-attachment") || element);
    });
    candidates.forEach((element) => {
      const signature = nodeSignature(element, "file-failure");
      if (!signature || seenFileFailureSignatures.has(signature)) return;
      seenFileFailureSignatures.add(signature);
      if (!emit) return;
      const filename = String(
        element.getAttribute("data-filename")
          || element.querySelector(".composer-attachment-name, .file-name")?.textContent
          || "",
      ).replace(/\s+/g, " ").trim();
      enqueueSignal({
        kind: "file-analysis-failed",
        chatId: activeConversationId,
        signature,
        detail: filename ? `Couldn't analyse ${filename}.` : "Couldn't analyse the file.",
        updatedAt: Date.now(),
        source: "composer-attachment",
      });
    });
  }

  function baselineActiveDom() {
    window.cancelAnimationFrame(domBaselineFrame);
    domReady = false;
    domBaselineUntil = Date.now() + DOM_BASELINE_WINDOW_MS;
    seenImageSignatures = new Set();
    seenFileFailureSignatures = new Set();
    collectImageResults(chatMessages, false);
    collectFileFailures(filePreviewArea, false);
    domBaselineFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        collectImageResults(chatMessages, false);
        collectFileFailures(filePreviewArea, false);
        domReady = true;
      });
    });
  }

  function inspectDomNode(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    if (!(element instanceof Element)) return;
    const imageEmit = domReady && Date.now() > domBaselineUntil;
    collectImageResults(element, imageEmit);
    collectFileFailures(element, domReady);
  }

  function resetScope(nextScope, reason = "scope-change") {
    const normalized = String(nextScope || "guest");
    scopeEpoch += 1;
    scope = normalized;
    baselineReady = false;
    pollBusyEpoch = -1;
    outcomesByChat.clear();
    attentionByChat.clear();
    recentSignals.clear();
    queue = [];
    if (currentAnnouncement) dismissAnnouncement();
    activeConversationId = "";
    scheduleDecoration();
    baselineActiveDom();
    notifySubscribers(reason);
    schedulePoll(180, "scope-baseline");
  }

  function handleConversationActivated(conversationId) {
    const nextId = String(conversationId || currentConversation());
    if (!nextId) return;
    activeConversationId = nextId;
    acknowledgeConversation(nextId);
    baselineActiveDom();
    scheduleDecoration();
    schedulePoll(100, "conversation-activated");
  }

  function confirmOffline() {
    window.clearTimeout(offlineTimer);
    offlineTimer = window.setTimeout(() => {
      offlineConfirmed = true;
      document.documentElement.dataset.sentiqConnectionState = "offline";
      notifySubscribers("connection-offline");
    }, OFFLINE_CONFIRM_DELAY_MS);
  }

  function handleOnline(options = {}) {
    window.clearTimeout(offlineTimer);
    offlineTimer = 0;
    const recovered = offlineConfirmed || options.explicit === true;
    offlineConfirmed = false;
    document.documentElement.dataset.sentiqConnectionState = "online";
    if (recovered) {
      enqueueSignal({
        kind: "connection-recovered",
        signature: `connection:${Date.now()}`,
        updatedAt: Date.now(),
        source: options.explicit ? "application-network" : "browser-network",
      });
    }
    schedulePoll(80, "connection-recovered");
  }

  document.addEventListener("sentiq-conversation-continuity-restored", (event) => {
    handleConversationActivated(event.detail?.conversationId);
  });
  document.addEventListener("sentiq-conversation-activity-change", () => schedulePoll(60, "activity-change"));
  document.addEventListener("sentiq-auth-changed", (event) => {
    const nextScope = String(event.detail?.session?.user?.id || event.detail?.session?.user?.sub || "guest");
    resetScope(nextScope, "auth-change");
  });
  document.addEventListener("sentiq-attention-signal", (event) => {
    if (event.detail && typeof event.detail === "object") enqueueSignal(event.detail);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (currentAnnouncement) dismissAnnouncement();
      return;
    }
    schedulePoll(40, "visibility-return");
    showNextAnnouncement();
  });
  window.addEventListener("pageshow", () => schedulePoll(60, "page-show"));
  window.addEventListener("offline", confirmOffline);
  window.addEventListener("online", () => handleOnline());
  window.addEventListener("sentiq-connection-recovered", () => handleOnline({ explicit: true }));
  window.addEventListener("sentiq-network-recovered", () => handleOnline({ explicit: true }));

  if (chatList) {
    new MutationObserver((records) => {
      const relevant = records.some((record) => (
        record.type === "childList"
        || (record.type === "attributes" && ["class", "data-id"].includes(record.attributeName))
      ));
      if (!relevant) return;
      const nextActive = currentConversation();
      if (nextActive && nextActive !== activeConversationId) handleConversationActivated(nextActive);
      else scheduleDecoration();
    }).observe(chatList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-id"],
    });
  }

  const activeDomObserver = new MutationObserver((records) => {
    records.forEach((record) => {
      inspectDomNode(record.target);
      record.addedNodes.forEach(inspectDomNode);
    });
  });
  if (chatMessages) {
    activeDomObserver.observe(chatMessages, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "src", "data-asset-result-state", "data-response-status"],
    });
  }
  if (filePreviewArea) {
    activeDomObserver.observe(filePreviewArea, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-invalid", "data-attachment-state", "data-analysis-id"],
    });
  }

  createStatusRoot();
  document.documentElement.dataset.sentiqConnectionState = offlineConfirmed ? "offline" : "online";
  baselineActiveDom();
  startPollLoop();
  void pollChats("initial-baseline");

  window.SentIQAttentionManagement = Object.freeze({
    version: ATTENTION_MANAGEMENT_VERSION,
    getState: getPublicState,
    refresh: () => pollChats("manual-refresh"),
    signal: enqueueSignal,
    acknowledge: acknowledgeConversation,
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent !== false) listener(getPublicState(), "subscribe");
      return () => subscribers.delete(listener);
    },
  });

  document.documentElement.dataset.attentionManagementVersion = ATTENTION_MANAGEMENT_VERSION;
}

initializeAttentionManagement();
