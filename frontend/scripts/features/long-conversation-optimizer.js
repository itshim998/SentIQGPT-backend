/* SentIQ Chat — Pass 11.5 long conversation optimisation runtime */

import {
  LONG_CONVERSATION_DEFAULTS,
  LONG_CONVERSATION_VERSION,
  classifyMessageWindowIndex,
  createStableElementSignature,
  deriveMediaPolicy,
  deriveMessageWindow,
  deriveRehydrationTarget,
  deriveScrollSnapshot,
  deriveSidebarHistoryWindow,
} from "./long-conversation-state.mjs";

const MESSAGE_SELECTOR = ":scope > .message";
const STREAMING_SELECTOR = ".typing-active, .streaming-tail, .deep-research-card.running, [data-response-state='streaming'], [data-tool-state='running']";
const MEDIA_SELECTOR = "img, video, iframe";
const CITATION_SELECTOR = [
  ".websurf-v2-source-explorer",
  ".websurf-v2-sources",
  ".web-search-details",
  ".web-search-results",
  ".web-search-source-fallback-list",
  ".deep-research-report-sources",
  ".deep-research-sources",
  "details.websurf-v2-source-explorer",
].join(",");
const ACTIVE_HISTORY_SELECTOR = [
  "[data-chat-id].active",
  "[data-chat-id][aria-current='page']",
  ".chat-item.active",
  ".chat-list-item.active",
  ".conversation-item.active",
  "[data-id].active",
].join(",");

function initializeLongConversationOptimizer() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQLongConversation?.version === LONG_CONVERSATION_VERSION) return;

  const root = document.documentElement;
  const chatMessages = document.getElementById("chat-messages");
  const chatList = document.getElementById("chat-list");
  const newChatButton = document.getElementById("new-chat-btn");
  if (!(chatMessages instanceof HTMLElement)) return;

  const frameApi = window.SentIQFrameDiscipline || null;
  const subscribers = new Set();
  const observers = [];
  const cleanup = [];
  const messageNear = new WeakMap();
  const historyNear = new WeakMap();
  const mediaNear = new WeakMap();
  const decodedMedia = new WeakSet();
  const measuredMessages = new WeakSet();
  const processedMedia = new WeakSet();
  const snapshots = new Map();
  const currentCitationExpansion = new Map();

  let fallbackFrame = 0;
  let mutationFrame = 0;
  let rehydrateTimer = 0;
  let snapshotTimer = 0;
  let generation = 0;
  let currentConversationKey = "";
  let lastMessageCount = 0;
  let lastHistoryCount = 0;
  let destroyed = false;

  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  function passive(target, type, handler, options = {}) {
    listen(target, type, handler, { ...options, passive: true });
  }

  function setData(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    const next = String(value);
    if (element.dataset[name] !== next) element.dataset[name] = next;
  }

  function setStyle(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }

  function notify(domain, reason, detail = {}) {
    const payload = Object.freeze({
      version: LONG_CONVERSATION_VERSION,
      domain,
      reason,
      ...detail,
    });
    subscribers.forEach((listener) => {
      try { listener(payload); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-long-conversation-change", { detail: payload }));
  }

  function scheduleMeasure(domain, key, read, write) {
    if (frameApi?.scheduleMeasure) {
      frameApi.scheduleMeasure(domain, `long-conversation:${key}`, read, write);
      return;
    }
    window.cancelAnimationFrame(fallbackFrame);
    fallbackFrame = window.requestAnimationFrame(() => {
      fallbackFrame = 0;
      const result = read();
      window.requestAnimationFrame(() => write(result));
    });
  }

  function scheduleWrite(domain, key, write) {
    if (frameApi?.scheduleWrite) {
      frameApi.scheduleWrite(domain, `long-conversation:${key}`, write);
      return;
    }
    window.requestAnimationFrame(write);
  }

  function getMessages() {
    return Array.from(chatMessages.querySelectorAll(MESSAGE_SELECTOR))
      .filter((message) => message instanceof HTMLElement);
  }

  function getHistoryItems() {
    if (!(chatList instanceof HTMLElement)) return [];
    return Array.from(chatList.children).filter((item) => (
      item instanceof HTMLElement
      && !item.hidden
      && item.getAttribute("aria-hidden") !== "true"
    ));
  }

  function getElementSignature(message) {
    if (!(message instanceof HTMLElement)) return "";
    return createStableElementSignature({
      id: message.id,
      requestId: message.dataset.requestId || message.dataset.messageId,
      chatId: message.dataset.chatId,
      role: message.classList.contains("assistant") ? "assistant" : "user",
      text: message.textContent,
    });
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
    if (!chatMessages.querySelector(MESSAGE_SELECTOR)) return "view:empty";
    const firstSignature = getElementSignature(chatMessages.querySelector(MESSAGE_SELECTOR));
    return `view:${firstSignature || "conversation"}`;
  }

  function findScrollAnchor(messages = getMessages()) {
    const rootRect = chatMessages.getBoundingClientRect();
    const nearMessages = messages.filter((message) => messageNear.get(message));
    const candidates = nearMessages.length ? nearMessages : messages.slice(-LONG_CONVERSATION_DEFAULTS.retainedTailMessages);
    const anchor = candidates.find((message) => {
      const rect = message.getBoundingClientRect();
      return rect.bottom > rootRect.top + 8 && rect.top < rootRect.bottom - 8;
    }) || null;
    return anchor instanceof HTMLElement
      ? {
          signature: getElementSignature(anchor),
          offset: anchor.getBoundingClientRect().top - rootRect.top,
        }
      : { signature: "", offset: 0 };
  }

  function getCitationKey(panel) {
    if (!(panel instanceof HTMLElement)) return "";
    const message = panel.closest(".message");
    if (!(message instanceof HTMLElement)) return "";
    const signature = getElementSignature(message);
    const panels = Array.from(message.querySelectorAll(CITATION_SELECTOR));
    const index = panels.indexOf(panel);
    return signature && index >= 0 ? `${signature}:${index}` : "";
  }

  function collectCitationExpansion() {
    return Object.fromEntries(currentCitationExpansion);
  }

  function captureConversationSnapshot(reason = "snapshot") {
    const key = currentConversationKey || readConversationKey();
    if (!key || key === "view:empty") return null;
    const messages = getMessages();
    if (!messages.length) return null;
    const scroll = deriveScrollSnapshot({
      scrollTop: chatMessages.scrollTop,
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
    });
    const anchor = findScrollAnchor(messages);
    const snapshot = Object.freeze({
      ...scroll,
      anchorSignature: anchor.signature,
      anchorOffset: anchor.offset,
      citationExpansion: collectCitationExpansion(),
      messageCount: messages.length,
      capturedAt: Date.now(),
    });
    snapshots.delete(key);
    snapshots.set(key, snapshot);
    while (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value);
    notify("rehydration", reason, { key, messageCount: messages.length, pinnedToBottom: snapshot.pinnedToBottom });
    return snapshot;
  }

  function scheduleSnapshot(reason = "scroll") {
    window.clearTimeout(snapshotTimer);
    snapshotTimer = window.setTimeout(() => captureConversationSnapshot(reason), 90);
  }

  function findVisibleRange(items, nearMap) {
    let first = -1;
    let last = -1;
    items.forEach((item, index) => {
      if (!nearMap.get(item)) return;
      if (first < 0) first = index;
      last = index;
    });
    return { first, last };
  }

  function applyMessageWindow(measurement, reason) {
    const { messages, heights, firstVisibleIndex, lastVisibleIndex } = measurement;
    const plan = deriveMessageWindow({
      count: messages.length,
      firstVisibleIndex: firstVisibleIndex < 0 ? Math.max(0, messages.length - 1) : firstVisibleIndex,
      lastVisibleIndex: lastVisibleIndex < 0 ? Math.max(0, messages.length - 1) : lastVisibleIndex,
    });

    messages.forEach((message, index) => {
      const streaming = Boolean(message.querySelector(STREAMING_SELECTOR));
      const state = streaming ? "tail" : classifyMessageWindowIndex(index, plan);
      setData(message, "longConversationWindow", state);
      setData(message, "longConversationIndex", index);
      const measuredHeight = heights[index];
      if (measuredHeight > 0) {
        setStyle(message, "--sentiq-message-intrinsic-size", `${Math.round(measuredHeight)}px`);
      }
      if (state === "deferred") message.setAttribute("data-offscreen-render", "deferred");
      else message.removeAttribute("data-offscreen-render");
    });

    setData(chatMessages, "longConversationWindowed", plan.windowed ? "true" : "false");
    setData(chatMessages, "longConversationMessages", messages.length);
    setData(root, "longConversationActive", plan.windowed ? "true" : "false");
    lastMessageCount = messages.length;
    notify("messages", reason, plan);
  }

  function scheduleMessageWindow(reason = "messages") {
    scheduleMeasure("streaming", "message-window", () => {
      const messages = getMessages();
      const range = findVisibleRange(messages, messageNear);
      return {
        messages,
        heights: messages.map((message, index) => (
          messageNear.get(message)
          || index >= Math.max(0, messages.length - LONG_CONVERSATION_DEFAULTS.retainedTailMessages)
          || Boolean(message.querySelector(STREAMING_SELECTOR))
            ? message.getBoundingClientRect().height
            : 0
        )),
        firstVisibleIndex: range.first,
        lastVisibleIndex: range.last,
      };
    }, (measurement) => applyMessageWindow(measurement, reason));
  }

  function applyHistoryWindow(measurement, reason) {
    const { items, firstVisibleIndex, lastVisibleIndex } = measurement;
    const plan = deriveSidebarHistoryWindow({
      count: items.length,
      firstVisibleIndex: firstVisibleIndex < 0 ? 0 : firstVisibleIndex,
      lastVisibleIndex: lastVisibleIndex < 0 ? Math.min(items.length - 1, 10) : lastVisibleIndex,
    });
    items.forEach((item, index) => {
      const active = item.matches(ACTIVE_HISTORY_SELECTOR);
      const visible = !plan.windowed || active || (index >= plan.start && index <= plan.end);
      setData(item, "historyRender", active ? "active" : (visible ? "near" : "deferred"));
      setStyle(item, "--sentiq-history-intrinsic-size", `${LONG_CONVERSATION_DEFAULTS.historyIntrinsicSizePx}px`);
    });
    if (chatList instanceof HTMLElement) {
      setData(chatList, "historyWindowed", plan.windowed ? "true" : "false");
      setData(chatList, "historyItems", items.length);
    }
    lastHistoryCount = items.length;
    notify("history", reason, plan);
  }

  function scheduleHistoryWindow(reason = "history") {
    if (!(chatList instanceof HTMLElement)) return;
    scheduleMeasure("sidebar", "history-window", () => {
      const items = getHistoryItems();
      const range = findVisibleRange(items, historyNear);
      return { items, firstVisibleIndex: range.first, lastVisibleIndex: range.last };
    }, (measurement) => applyHistoryWindow(measurement, reason));
  }

  function getLatestMessage() {
    let node = chatMessages.lastElementChild;
    while (node && !(node instanceof HTMLElement && node.classList.contains("message"))) node = node.previousElementSibling;
    return node instanceof HTMLElement ? node : null;
  }

  function isLatestMessageMedia(media) {
    const message = media.closest(".message");
    return message instanceof HTMLElement && message === getLatestMessage();
  }

  function markMediaDecoded(media, reason = "decode") {
    decodedMedia.add(media);
    setData(media, "mediaDecode", "decoded");
    frameApi?.scheduleScrollAnchor?.(`long-conversation:${reason}`);
    notify("media", reason, { decoded: true, tag: media.tagName.toLowerCase() });
  }

  function applyMediaPolicy(media, reason = "media") {
    if (!(media instanceof HTMLElement)) return;
    const nearViewport = Boolean(mediaNear.get(media));
    const visible = media.getClientRects().length > 0 && nearViewport;
    const policy = deriveMediaPolicy({
      latest: isLatestMessageMedia(media),
      nearViewport,
      visible,
      decoded: decodedMedia.has(media),
    });
    setData(media, "mediaFrameState", policy.frameState);

    if (media instanceof HTMLImageElement) {
      media.loading = policy.loading;
      media.decoding = policy.decoding;
      media.setAttribute("fetchpriority", policy.fetchPriority);
      if (policy.shouldDecode && typeof media.decode === "function") {
        setData(media, "mediaDecode", "pending");
        media.decode()
          .then(() => markMediaDecoded(media, "image-decode"))
          .catch(() => {
            if (media.complete) markMediaDecoded(media, "image-complete");
            else setData(media, "mediaDecode", "waiting");
          });
      }
    } else if (media instanceof HTMLIFrameElement) {
      media.loading = "lazy";
    } else if (media instanceof HTMLVideoElement) {
      media.preload = policy.videoPreload;
    }
    notify("media", reason, { tag: media.tagName.toLowerCase(), ...policy });
  }

  function registerMedia(media, reason = "register") {
    if (!(media instanceof HTMLElement)) return;
    if (!processedMedia.has(media)) {
      processedMedia.add(media);
      mediaObserver?.observe(media);
      if (media instanceof HTMLImageElement) {
        media.loading = isLatestMessageMedia(media) ? "eager" : "lazy";
        media.decoding = "async";
        passive(media, "load", () => markMediaDecoded(media, "load"), { once: true });
        passive(media, "error", () => setData(media, "mediaDecode", "error"), { once: true });
      } else if (media instanceof HTMLIFrameElement) {
        media.loading = "lazy";
      } else if (media instanceof HTMLVideoElement) {
        media.preload = "none";
      }
    }
    applyMediaPolicy(media, reason);
  }

  function processMedia(scope = chatMessages, reason = "scan") {
    scope.querySelectorAll?.(MEDIA_SELECTOR).forEach((media) => registerMedia(media, reason));
    if (scope instanceof HTMLElement && scope.matches(MEDIA_SELECTOR)) registerMedia(scope, reason);
  }

  function processCitationPanel(panel, reason = "citation") {
    if (!(panel instanceof HTMLElement)) return;
    const expanded = panel instanceof HTMLDetailsElement
      ? panel.open
      : panel.getAttribute("aria-expanded") === "true";
    const citationKey = getCitationKey(panel);
    if (citationKey) {
      if (expanded) currentCitationExpansion.set(citationKey, true);
      else currentCitationExpansion.delete(citationKey);
    }
    const near = panel.dataset.citationNear === "true";
    setData(panel, "citationRender", expanded ? (near ? "expanded-near" : "expanded") : "collapsed");
    setStyle(panel, "--sentiq-citation-intrinsic-size", `${LONG_CONVERSATION_DEFAULTS.citationIntrinsicSizePx}px`);
    if (expanded) {
      processMedia(panel, "citation-expand");
      frameApi?.scheduleScrollAnchor?.("long-conversation:citation-expand");
    }
    notify("citations", reason, { expanded, near });
    if (reason === "toggle" || reason === "toggle-capture" || reason === "interaction") {
      scheduleSnapshot("citation-expansion");
    }
  }

  function registerCitationPanel(panel) {
    if (!(panel instanceof HTMLElement) || panel.dataset.longConversationCitation === LONG_CONVERSATION_VERSION) return;
    setData(panel, "longConversationCitation", LONG_CONVERSATION_VERSION);
    citationObserver?.observe(panel);
    if (panel instanceof HTMLDetailsElement) {
      listen(panel, "toggle", () => scheduleWrite("streaming", "citation-toggle", () => processCitationPanel(panel, "toggle")));
    }
    processCitationPanel(panel, "register");
  }

  function processCitations(scope = chatMessages) {
    scope.querySelectorAll?.(CITATION_SELECTOR).forEach(registerCitationPanel);
    if (scope instanceof HTMLElement && scope.matches(CITATION_SELECTOR)) registerCitationPanel(scope);
  }

  function restoreCitationExpansion(snapshot, messages) {
    const expansion = snapshot?.citationExpansion || {};
    currentCitationExpansion.clear();
    Object.entries(expansion).forEach(([key, value]) => {
      if (value) currentCitationExpansion.set(key, true);
    });
    messages.forEach((message) => {
      const signature = getElementSignature(message);
      message.querySelectorAll(CITATION_SELECTOR).forEach((panel, index) => {
        if (!(panel instanceof HTMLDetailsElement)) return;
        panel.open = Boolean(expansion[`${signature}:${index}`]);
        processCitationPanel(panel, "rehydrate");
      });
    });
  }

  function restoreConversationSnapshot(key, reason = "rehydrate") {
    const snapshot = snapshots.get(key);
    const messages = getMessages();
    if (!snapshot) currentCitationExpansion.clear();
    processMedia(chatMessages, reason);
    processCitations(chatMessages);
    scheduleMessageWindow(reason);
    if (!snapshot || !messages.length) {
      setData(chatMessages, "conversationRehydration", "fresh");
      return;
    }

    restoreCitationExpansion(snapshot, messages);
    const anchor = messages.find((message) => getElementSignature(message) === snapshot.anchorSignature);
    const rootRect = chatMessages.getBoundingClientRect();
    const anchorTop = anchor instanceof HTMLElement
      ? anchor.getBoundingClientRect().top - rootRect.top
      : NaN;
    const target = deriveRehydrationTarget({
      snapshot,
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
      currentScrollTop: chatMessages.scrollTop,
      anchorTop,
    });
    chatMessages.scrollTop = target;
    setData(chatMessages, "conversationRehydration", "restored");
    frameApi?.scheduleScrollAnchor?.("long-conversation:rehydrate", { userInitiated: true });
    notify("rehydration", reason, { key, restored: true, target, messageCount: messages.length });
  }

  function scheduleRehydration(reason = "conversation") {
    generation += 1;
    const run = generation;
    window.clearTimeout(rehydrateTimer);
    setData(chatMessages, "conversationRehydration", "pending");
    scheduleWrite("streaming", "rehydrate-frame", () => {
      window.requestAnimationFrame(() => {
        if (run !== generation || destroyed) return;
        const nextKey = readConversationKey();
        currentConversationKey = nextKey;
        restoreConversationSnapshot(nextKey, reason);
        rehydrateTimer = window.setTimeout(() => {
          if (run !== generation || destroyed) return;
          restoreConversationSnapshot(nextKey, "settled");
        }, LONG_CONVERSATION_DEFAULTS.rehydrateSettleMs);
      });
    });
  }

  function handleChatMutations(records) {
    let directAdded = 0;
    let directRemoved = 0;
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches?.(".message")) directAdded += 1;
        if (node instanceof HTMLElement) {
          processMedia(node, "mutation");
          processCitations(node);
        }
      });
      record.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.matches?.(".message")) directRemoved += 1;
      });
    });

    window.cancelAnimationFrame(mutationFrame);
    mutationFrame = window.requestAnimationFrame(() => {
      mutationFrame = 0;
      const key = readConversationKey();
      const count = getMessages().length;
      const replacement = directRemoved > 0 && (directAdded > 0 || count === 0);
      const switched = currentConversationKey && key !== currentConversationKey;
      scheduleMessageWindow("mutation");
      if (replacement || switched || (lastMessageCount > 0 && count === 0)) scheduleRehydration(switched ? "switch" : "replacement");
      else scheduleSnapshot("mutation");
    });
  }

  function handleHistoryMutations() {
    scheduleHistoryWindow("mutation");
    if (readConversationKey() !== currentConversationKey) scheduleRehydration("history-state");
  }

  const messageObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => messageNear.set(entry.target, entry.isIntersecting));
        scheduleMessageWindow("intersection");
      }, { root: chatMessages, rootMargin: "1200px 0px", threshold: 0 })
    : null;

  const mediaObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          mediaNear.set(entry.target, entry.isIntersecting);
          applyMediaPolicy(entry.target, "intersection");
        });
      }, { root: chatMessages, rootMargin: "900px 0px", threshold: 0.01 })
    : null;

  const citationObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          setData(entry.target, "citationNear", entry.isIntersecting ? "true" : "false");
          processCitationPanel(entry.target, "intersection");
        });
      }, { root: chatMessages, rootMargin: "700px 0px", threshold: 0 })
    : null;

  const historyObserver = typeof IntersectionObserver === "function" && chatList instanceof HTMLElement
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => historyNear.set(entry.target, entry.isIntersecting));
        scheduleHistoryWindow("intersection");
      }, { root: chatList, rootMargin: "420px 0px", threshold: 0 })
    : null;

  observers.push(...[messageObserver, mediaObserver, citationObserver, historyObserver].filter(Boolean));

  function registerCurrentMessages() {
    getMessages().forEach((message) => {
      messageObserver?.observe(message);
      if (!measuredMessages.has(message)) {
        measuredMessages.add(message);
        messageResizeObserver?.observe(message);
      }
    });
  }

  function registerHistoryItems() {
    getHistoryItems().forEach((item) => historyObserver?.observe(item));
  }

  const messageResizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        entries.forEach((entry) => {
          if (!(entry.target instanceof HTMLElement)) return;
          const height = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height;
          if (height > 0) setStyle(entry.target, "--sentiq-message-intrinsic-size", `${Math.round(height)}px`);
        });
        scheduleMessageWindow("resize-observer");
        frameApi?.scheduleScrollAnchor?.("long-conversation:message-resize");
      })
    : null;
  if (messageResizeObserver) observers.push(messageResizeObserver);

  const chatMutationObserver = new MutationObserver((records) => {
    registerCurrentMessages();
    handleChatMutations(records);
  });
  chatMutationObserver.observe(chatMessages, { childList: true, subtree: true, characterData: true });
  observers.push(chatMutationObserver);

  if (chatList instanceof HTMLElement) {
    const historyMutationObserver = new MutationObserver(() => {
      registerHistoryItems();
      handleHistoryMutations();
    });
    historyMutationObserver.observe(chatList, { childList: true, subtree: false, attributes: true, attributeFilter: ["class", "aria-current"] });
    observers.push(historyMutationObserver);
    passive(chatList, "pointerdown", () => captureConversationSnapshot("history-intent"), { capture: true });
  }

  passive(chatMessages, "scroll", () => {
    scheduleMessageWindow("scroll");
    scheduleSnapshot("scroll");
  });
  passive(chatMessages, "wheel", () => scheduleSnapshot("wheel"));
  passive(chatMessages, "touchmove", () => scheduleSnapshot("touch"));
  listen(chatMessages, "toggle", (event) => {
    const panel = event.target;
    if (panel instanceof HTMLElement && panel.matches(CITATION_SELECTOR)) processCitationPanel(panel, "toggle-capture");
  }, true);
  listen(chatMessages, "click", (event) => {
    const trigger = event.target?.closest?.("[aria-expanded], summary, .websurf-v2-source-toggle, .citation-chip");
    if (!trigger) return;
    scheduleWrite("streaming", "citation-expansion", () => {
      const panel = trigger.closest?.(CITATION_SELECTOR) || trigger.parentElement?.querySelector?.(CITATION_SELECTOR);
      if (panel instanceof HTMLElement) processCitationPanel(panel, "interaction");
      scheduleMessageWindow("citation-expansion");
    });
  }, true);
  passive(window, "resize", () => {
    scheduleMessageWindow("viewport");
    scheduleHistoryWindow("viewport");
  });
  passive(window.visualViewport, "resize", () => scheduleMessageWindow("visual-viewport"));
  listen(document, "sentiq-stream-frame", () => scheduleMessageWindow("stream-frame"));
  listen(document, "sentiq-mobile-composer-change", () => scheduleMessageWindow("composer"));
  listen(newChatButton, "click", () => {
    captureConversationSnapshot("new-chat-intent");
    scheduleRehydration("new-chat");
  }, { capture: true });

  root.dataset.longConversationVersion = LONG_CONVERSATION_VERSION;
  chatMessages.dataset.longConversationVersion = LONG_CONVERSATION_VERSION;
  if (chatList instanceof HTMLElement) chatList.dataset.longConversationVersion = LONG_CONVERSATION_VERSION;

  currentConversationKey = readConversationKey();
  registerCurrentMessages();
  registerHistoryItems();
  processMedia(chatMessages, "initial");
  processCitations(chatMessages);
  scheduleMessageWindow("initial");
  scheduleHistoryWindow("initial");
  scheduleRehydration("initial");

  window.SentIQLongConversation = Object.freeze({
    version: LONG_CONVERSATION_VERSION,
    refresh(reason = "manual") {
      registerCurrentMessages();
      registerHistoryItems();
      processMedia(chatMessages, reason);
      processCitations(chatMessages);
      scheduleMessageWindow(reason);
      scheduleHistoryWindow(reason);
    },
    captureSnapshot: captureConversationSnapshot,
    rehydrate: scheduleRehydration,
    getState() {
      return Object.freeze({
        conversationKey: currentConversationKey,
        messageCount: lastMessageCount,
        historyCount: lastHistoryCount,
        snapshots: snapshots.size,
        generation,
      });
    },
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent === true) {
        listener(Object.freeze({
          version: LONG_CONVERSATION_VERSION,
          domain: "rehydration",
          reason: "subscribe",
          conversationKey: currentConversationKey,
          messageCount: lastMessageCount,
          historyCount: lastHistoryCount,
        }));
      }
      return () => subscribers.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(rehydrateTimer);
      window.clearTimeout(snapshotTimer);
      window.cancelAnimationFrame(fallbackFrame);
      window.cancelAnimationFrame(mutationFrame);
      observers.forEach((observer) => observer.disconnect());
      cleanup.splice(0).forEach((dispose) => dispose());
      subscribers.clear();
      root.dataset.longConversationActive = "false";
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeLongConversationOptimizer, { once: true });
} else {
  initializeLongConversationOptimizer();
}
