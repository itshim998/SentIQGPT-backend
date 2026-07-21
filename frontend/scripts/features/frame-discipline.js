/* SentIQ Chat — Pass 11.4 JavaScript frame discipline runtime */

import {
  FRAME_DISCIPLINE_DEFAULTS,
  FRAME_DISCIPLINE_VERSION,
  createFrameCoordinator,
  deriveAttachmentMetrics,
  deriveScrollAnchorState,
  deriveTextareaSizing,
  deriveViewportMetrics,
  summarizeMutationRecords,
} from "./frame-discipline-state.mjs";

const STREAMING_SURFACE_SELECTOR = [
  ".message.assistant",
  ".typing-active",
  "[data-request-id]",
  "[data-response-state='streaming']",
  "[data-tool-state='running']",
].join(",");

function initializeFrameDiscipline() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQFrameDiscipline?.version === FRAME_DISCIPLINE_VERSION) return;

  const root = document.documentElement;
  const chatInput = document.getElementById("chat-input");
  const chatMessages = document.getElementById("chat-messages");
  const scrollAnchorPill = document.getElementById("scroll-anchor-pill");
  const sidebar = document.getElementById("sidebar");
  const appContainer = document.querySelector(".app-container");
  const filePreviewArea = document.getElementById("file-preview-area");
  const chatInputArea = document.querySelector(".chat-input-area");
  const subscribers = new Set();
  const cleanup = [];
  const observers = [];

  const coordinator = createFrameCoordinator({
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (handle) => window.clearTimeout(handle),
    onError(error, context) {
      if (window.SENTIQ_DEBUG) console.warn("[Frame discipline]", context, error);
    },
  });

  let scrollPinned = true;
  let lastScrollMetrics = null;
  let programmaticScrollUntil = 0;
  let streamFrameNumber = 0;
  let pendingStreamSummary = summarizeMutationRecords([]);
  let lastViewportSignature = "";
  let lastSidebarSignature = "";
  let lastAttachmentSignature = "";
  let destroyed = false;

  function setDataset(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    const next = String(value);
    if (element.dataset[name] !== next) element.dataset[name] = next;
  }

  function setStyleProperty(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
  }

  function listen(target, type, listener, options) {
    if (!target?.addEventListener || typeof listener !== "function") return;
    target.addEventListener(type, listener, options);
    cleanup.push(() => target.removeEventListener(type, listener, options));
  }

  function listenPassive(target, type, listener, options = {}) {
    listen(target, type, listener, { ...options, passive: true });
  }

  function notify(domain, reason, detail = {}) {
    if (!subscribers.size) return;
    const payload = Object.freeze({
      version: FRAME_DISCIPLINE_VERSION,
      domain,
      reason,
      timestamp: performance.now(),
      ...detail,
    });
    subscribers.forEach((listener) => {
      try { listener(payload); } catch { /* subscriber isolation */ }
    });
  }

  function isMobileComposerActive() {
    try { return Boolean(window.SentIQMobileComposer?.isActive?.()); } catch { return false; }
  }

  function scheduleTextareaAutosize(reason = "input") {
    if (!(chatInput instanceof HTMLTextAreaElement)) return;

    coordinator.write("textarea", "prepare", () => {
      if (isMobileComposerActive()) {
        window.SentIQMobileComposer?.resizeTextarea?.();
        notify("textarea", reason, { delegated: true });
        return;
      }

      if (chatInput.style.height !== "auto") chatInput.style.height = "auto";
      coordinator.measure("textarea", "measure", () => {
        const computed = window.getComputedStyle(chatInput);
        const minHeight = Number.parseFloat(computed.minHeight)
          || FRAME_DISCIPLINE_DEFAULTS.textareaFallbackMinPx;
        const cssMaxHeight = Number.parseFloat(computed.maxHeight);
        const viewportBound = Math.max(120, Math.min(320, (window.visualViewport?.height || window.innerHeight || 720) * 0.34));
        const maxHeight = Number.isFinite(cssMaxHeight) && cssMaxHeight > 0
          ? Math.min(cssMaxHeight, viewportBound)
          : Math.min(FRAME_DISCIPLINE_DEFAULTS.textareaFallbackMaxPx, viewportBound);
        return deriveTextareaSizing({
          scrollHeight: chatInput.scrollHeight,
          minHeight,
          maxHeight,
        });
      }, (sizing) => {
        if (isMobileComposerActive()) {
          window.SentIQMobileComposer?.resizeTextarea?.();
          return;
        }
        const height = `${Math.round(sizing.height)}px`;
        if (chatInput.style.height !== height) chatInput.style.height = height;
        const overflowY = sizing.overflowing ? "auto" : "hidden";
        if (chatInput.style.overflowY !== overflowY) chatInput.style.overflowY = overflowY;
        setDataset(chatInput, "sentiqFrameAutosize", sizing.overflowing ? "scroll" : "fit");
        notify("textarea", reason, sizing);
        scheduleAttachmentMeasurement("textarea-resized");
      });
    });
  }

  function readScrollMetrics() {
    if (!(chatMessages instanceof HTMLElement)) return null;
    return {
      scrollTop: chatMessages.scrollTop,
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
    };
  }

  function applyScrollAnchor(metrics, reason, userInitiated = false, forceBottom = false) {
    if (!metrics || !(chatMessages instanceof HTMLElement)) return;
    const derived = deriveScrollAnchorState({
      ...metrics,
      threshold: FRAME_DISCIPLINE_DEFAULTS.scrollAnchorThresholdPx,
      previousPinned: forceBottom ? true : scrollPinned,
      userInitiated,
    });

    if (userInitiated) scrollPinned = derived.atBottom;
    else if (forceBottom) scrollPinned = true;

    if (scrollPinned && Math.abs(chatMessages.scrollTop - derived.maximumScrollTop) > 0.5) {
      programmaticScrollUntil = performance.now() + 80;
      chatMessages.scrollTop = derived.maximumScrollTop;
    }

    lastScrollMetrics = {
      scrollTop: chatMessages.scrollTop,
      scrollHeight: metrics.scrollHeight,
      clientHeight: metrics.clientHeight,
    };
    setDataset(root, "sentiqScrollAnchor", scrollPinned ? "bottom" : "reading");
    notify("scroll", reason, {
      pinned: scrollPinned,
      distanceFromBottom: derived.distanceFromBottom,
      scrollHeight: derived.scrollHeight,
    });
  }

  function scheduleScrollAnchor(reason = "content", options = {}) {
    if (!(chatMessages instanceof HTMLElement)) return;
    coordinator.measure("scroll", "anchor", readScrollMetrics, (metrics) => {
      applyScrollAnchor(
        metrics,
        reason,
        Boolean(options.userInitiated),
        Boolean(options.forceBottom),
      );
    });
  }

  function handleChatScroll() {
    const userInitiated = performance.now() > programmaticScrollUntil;
    if (userInitiated) scrollPinned = false;
    scheduleScrollAnchor("scroll", { userInitiated });
  }

  function readViewport() {
    const visualViewport = window.visualViewport;
    return deriveViewportMetrics({
      layoutWidth: window.innerWidth || root.clientWidth || 1,
      layoutHeight: window.innerHeight || root.clientHeight || 1,
      visualWidth: visualViewport?.width,
      visualHeight: visualViewport?.height,
      offsetTop: visualViewport?.offsetTop,
      offsetLeft: visualViewport?.offsetLeft,
    });
  }

  function applyViewport(metrics, reason) {
    const signature = [
      Math.round(metrics.visualWidth),
      Math.round(metrics.visualHeight),
      Math.round(metrics.offsetTop),
      Math.round(metrics.offsetLeft),
      Math.round(metrics.keyboardInset),
      metrics.orientation,
    ].join("|");
    if (signature === lastViewportSignature && reason !== "settled") return;
    lastViewportSignature = signature;

    setStyleProperty(root, "--sentiq-visual-viewport-width", `${Math.round(metrics.visualWidth)}px`);
    setStyleProperty(root, "--sentiq-visual-viewport-height", `${Math.round(metrics.visualHeight)}px`);
    setStyleProperty(root, "--sentiq-visual-viewport-top", `${Math.round(metrics.offsetTop)}px`);
    setStyleProperty(root, "--sentiq-visual-viewport-left", `${Math.round(metrics.offsetLeft)}px`);
    setStyleProperty(root, "--sentiq-keyboard-inset", `${Math.round(metrics.keyboardInset)}px`);
    setDataset(root, "sentiqViewportOrientation", metrics.orientation);
    setDataset(root, "sentiqViewportKeyboard", metrics.keyboardOpen ? "open" : "closed");
    notify("viewport", reason, metrics);
  }

  function scheduleViewportMeasurement(reason = "viewport") {
    coordinator.measure("viewport", "measure", readViewport, (metrics) => {
      applyViewport(metrics, reason);
      scheduleScrollAnchor("viewport");
      scheduleSidebarMeasurement("viewport");
      scheduleAttachmentMeasurement("viewport");
    });
    if (reason !== "settled") {
      coordinator.debounce(
        "viewport",
        "settled",
        () => scheduleViewportMeasurement("settled"),
        FRAME_DISCIPLINE_DEFAULTS.viewportSettleMs,
      );
    }
  }

  function readSidebarMetrics() {
    if (!(sidebar instanceof HTMLElement)) return null;
    const rect = sidebar.getBoundingClientRect();
    const style = window.getComputedStyle(sidebar);
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      open: sidebar.classList.contains("open"),
      collapsed: Boolean(appContainer?.classList.contains("sidebar-collapsed")),
      transform: style.transform === "none" ? "" : style.transform,
      mobile: window.matchMedia?.("(max-width: 768px)")?.matches ?? window.innerWidth <= 768,
    };
  }

  function applySidebarMetrics(metrics, reason) {
    if (!metrics || !(sidebar instanceof HTMLElement)) return;
    const state = metrics.mobile
      ? (metrics.open ? "mobile-open" : "mobile-closed")
      : (metrics.collapsed ? "desktop-collapsed" : "desktop-open");
    const signature = `${Math.round(metrics.width)}|${Math.round(metrics.height)}|${state}|${metrics.transform}`;
    if (signature === lastSidebarSignature && reason !== "settled") return;
    lastSidebarSignature = signature;

    setStyleProperty(root, "--sentiq-sidebar-measured-width", `${Math.round(metrics.width)}px`);
    setStyleProperty(root, "--sentiq-sidebar-measured-height", `${Math.round(metrics.height)}px`);
    setDataset(sidebar, "sentiqFrameState", state);
    notify("sidebar", reason, { ...metrics, state });
  }

  function scheduleSidebarMeasurement(reason = "sidebar") {
    if (!(sidebar instanceof HTMLElement)) return;
    coordinator.measure("sidebar", "measure", readSidebarMetrics, (metrics) => {
      applySidebarMetrics(metrics, reason);
    });
    if (reason !== "settled") {
      coordinator.debounce(
        "sidebar",
        "settled",
        () => coordinator.measure("sidebar", "settled-measure", readSidebarMetrics, (metrics) => {
          applySidebarMetrics(metrics, "settled");
          coordinator.write("sidebar", "settled-state", () => setDataset(sidebar, "sentiqFrameTransition", "settled"));
        }),
        FRAME_DISCIPLINE_DEFAULTS.sidebarSettleMs,
      );
    }
  }

  function readAttachmentMetrics() {
    const previewRect = filePreviewArea instanceof HTMLElement
      ? filePreviewArea.getBoundingClientRect()
      : { height: 0 };
    const composerRect = chatInputArea instanceof HTMLElement
      ? chatInputArea.getBoundingClientRect()
      : { height: 0 };
    const itemCount = filePreviewArea instanceof HTMLElement
      ? Array.from(filePreviewArea.children).filter((child) => (
        child instanceof HTMLElement
        && !child.hidden
        && child.getAttribute("aria-hidden") !== "true"
      )).length
      : 0;
    return deriveAttachmentMetrics({
      previewHeight: previewRect.height,
      composerHeight: composerRect.height,
      itemCount,
    });
  }

  function applyAttachmentMetrics(metrics, reason) {
    const signature = `${Math.round(metrics.previewHeight)}|${Math.round(metrics.composerHeight)}|${metrics.itemCount}|${metrics.density}`;
    if (signature === lastAttachmentSignature && reason !== "settled") return;
    lastAttachmentSignature = signature;

    setStyleProperty(root, "--sentiq-attachment-preview-height", `${Math.round(metrics.previewHeight)}px`);
    setStyleProperty(root, "--sentiq-composer-measured-height", `${Math.round(metrics.composerHeight)}px`);
    setStyleProperty(root, "--sentiq-attachment-count", String(metrics.itemCount));
    if (filePreviewArea instanceof HTMLElement) {
      setDataset(filePreviewArea, "sentiqAttachmentDensity", metrics.density);
      setDataset(filePreviewArea, "sentiqFrameMeasured", metrics.visible ? "visible" : "empty");
    }
    notify("attachments", reason, metrics);
  }

  function scheduleAttachmentMeasurement(reason = "attachments") {
    if (!(filePreviewArea instanceof HTMLElement) && !(chatInputArea instanceof HTMLElement)) return;
    coordinator.measure("attachments", "measure", readAttachmentMetrics, (metrics) => {
      applyAttachmentMetrics(metrics, reason);
      scheduleScrollAnchor("attachment-layout");
    });
    if (reason !== "settled") {
      coordinator.debounce(
        "attachments",
        "settled",
        () => coordinator.measure("attachments", "settled-measure", readAttachmentMetrics, (metrics) => {
          applyAttachmentMetrics(metrics, "settled");
        }),
        FRAME_DISCIPLINE_DEFAULTS.attachmentSettleMs,
      );
    }
  }

  function mergeStreamSummary(next) {
    pendingStreamSummary = Object.freeze({
      childList: pendingStreamSummary.childList + next.childList,
      characterData: pendingStreamSummary.characterData + next.characterData,
      attributes: pendingStreamSummary.attributes + next.attributes,
      addedNodes: pendingStreamSummary.addedNodes + next.addedNodes,
      removedNodes: pendingStreamSummary.removedNodes + next.removedNodes,
    });
  }

  function scheduleStreamingFrame(reason = "mutation") {
    if (!(chatMessages instanceof HTMLElement)) return;
    coordinator.measure("streaming", "frame", () => ({
      scroll: readScrollMetrics(),
      summary: pendingStreamSummary,
    }), ({ scroll, summary }) => {
      pendingStreamSummary = summarizeMutationRecords([]);
      streamFrameNumber += 1;
      setDataset(root, "sentiqStreamFrame", streamFrameNumber);
      setDataset(chatMessages, "sentiqStreamBatch", streamFrameNumber);
      applyScrollAnchor(scroll, "streaming", false, false);
      const detail = {
        frame: streamFrameNumber,
        ...summary,
        pinned: scrollPinned,
      };
      notify("streaming", reason, detail);
      document.dispatchEvent(new CustomEvent("sentiq-stream-frame", {
        detail: Object.freeze({ version: FRAME_DISCIPLINE_VERSION, reason, ...detail }),
      }));
    });
  }

  function scheduleStreamingUpdate(key, update, options = {}) {
    if (typeof update !== "function") return false;
    coordinator.write("streaming", key || "external", () => {
      update();
      mergeStreamSummary({ childList: 1, characterData: 0, attributes: 0, addedNodes: 1, removedNodes: 0 });
      scheduleStreamingFrame(options.reason || "scheduled-update");
    });
    return true;
  }

  function handleStreamMutations(records) {
    const relevant = records.filter((record) => {
      const node = record.target?.nodeType === Node.TEXT_NODE
        ? record.target.parentElement
        : record.target;
      return node instanceof Element && Boolean(node.closest(STREAMING_SURFACE_SELECTOR));
    });
    const summary = summarizeMutationRecords(relevant.length ? relevant : records);
    mergeStreamSummary(summary);
    scheduleStreamingFrame(relevant.length ? "stream" : "messages");
  }

  function handleViewportEvent(event) {
    scheduleViewportMeasurement(event?.type || "viewport");
  }

  function handleSidebarTransitionStart(event) {
    if (event.target !== sidebar) return;
    coordinator.write("sidebar", "transition-state", () => setDataset(sidebar, "sentiqFrameTransition", "active"));
    scheduleSidebarMeasurement("transition-start");
  }

  function handleSidebarTransitionEnd(event) {
    if (event.target !== sidebar) return;
    scheduleSidebarMeasurement(event.type || "transition-end");
  }

  root.dataset.sentiqFrameDisciplineVersion = FRAME_DISCIPLINE_VERSION;
  root.dataset.sentiqFrameDiscipline = "active";

  if (chatInput instanceof HTMLTextAreaElement) {
    listenPassive(chatInput, "input", () => scheduleTextareaAutosize("input"));
    listenPassive(chatInput, "change", () => scheduleTextareaAutosize("change"));
    listenPassive(chatInput, "compositionend", () => scheduleTextareaAutosize("compositionend"));
  }

  if (chatMessages instanceof HTMLElement) {
    listenPassive(chatMessages, "scroll", handleChatScroll);
    const streamObserver = new MutationObserver(handleStreamMutations);
    streamObserver.observe(chatMessages, { childList: true, characterData: true, subtree: true });
    observers.push(streamObserver);
  }

  if (scrollAnchorPill instanceof HTMLElement) {
    listenPassive(scrollAnchorPill, "click", () => scheduleScrollAnchor("anchor-control", { forceBottom: true }));
  }

  if (sidebar instanceof HTMLElement) {
    for (const type of ["transitionrun", "transitionstart"]) {
      listenPassive(sidebar, type, handleSidebarTransitionStart);
    }
    for (const type of ["transitionend", "transitioncancel"]) {
      listenPassive(sidebar, type, handleSidebarTransitionEnd);
    }
    const sidebarObserver = new MutationObserver(() => scheduleSidebarMeasurement("mutation"));
    sidebarObserver.observe(sidebar, {
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "aria-modal", "data-state"],
    });
    observers.push(sidebarObserver);
  }

  if (appContainer instanceof HTMLElement) {
    const appObserver = new MutationObserver(() => scheduleSidebarMeasurement("container-state"));
    appObserver.observe(appContainer, { attributes: true, attributeFilter: ["class"] });
    observers.push(appObserver);
  }

  if (filePreviewArea instanceof HTMLElement) {
    const attachmentObserver = new MutationObserver(() => scheduleAttachmentMeasurement("mutation"));
    attachmentObserver.observe(filePreviewArea, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "aria-hidden", "data-state"],
    });
    observers.push(attachmentObserver);
  }

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver((entries) => {
      let sidebarChanged = false;
      let attachmentsChanged = false;
      for (const entry of entries) {
        if (entry.target === sidebar) sidebarChanged = true;
        if (entry.target === filePreviewArea || entry.target === chatInputArea || entry.target === chatInput) {
          attachmentsChanged = true;
        }
      }
      if (sidebarChanged) scheduleSidebarMeasurement("resize-observer");
      if (attachmentsChanged) scheduleAttachmentMeasurement("resize-observer");
    });
    if (sidebar instanceof HTMLElement) resizeObserver.observe(sidebar);
    if (filePreviewArea instanceof HTMLElement) resizeObserver.observe(filePreviewArea);
    if (chatInputArea instanceof HTMLElement) resizeObserver.observe(chatInputArea);
    if (chatInput instanceof HTMLTextAreaElement) resizeObserver.observe(chatInput);
    observers.push(resizeObserver);
  }

  listenPassive(window, "resize", handleViewportEvent);
  listenPassive(window, "orientationchange", handleViewportEvent);
  listenPassive(window.visualViewport, "resize", handleViewportEvent);
  listenPassive(window.visualViewport, "scroll", handleViewportEvent);
  listenPassive(document, "sentiq-mobile-composer-change", () => {
    scheduleTextareaAutosize("mobile-composer");
    scheduleViewportMeasurement("mobile-composer");
  });
  listenPassive(document, "sentiq-mobile-navigation-change", () => scheduleSidebarMeasurement("mobile-navigation"));

  window.SentIQFrameDiscipline = Object.freeze({
    version: FRAME_DISCIPLINE_VERSION,
    scheduleRead: coordinator.read,
    scheduleMeasure: coordinator.measure,
    scheduleWrite: coordinator.write,
    debounce: coordinator.debounce,
    scheduleTextareaAutosize,
    scheduleScrollAnchor,
    scheduleSidebarMeasurement,
    scheduleViewportMeasurement,
    scheduleAttachmentMeasurement,
    scheduleStreamingUpdate,
    getState() {
      return Object.freeze({
        ...coordinator.getState(),
        scrollPinned,
        lastScrollMetrics: lastScrollMetrics ? { ...lastScrollMetrics } : null,
        streamFrameNumber,
        viewportSignature: lastViewportSignature,
        sidebarSignature: lastSidebarSignature,
        attachmentSignature: lastAttachmentSignature,
      });
    },
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (options.emitCurrent === true) {
        listener(Object.freeze({
          version: FRAME_DISCIPLINE_VERSION,
          domain: "viewport",
          reason: "subscribe",
          ...readViewport(),
        }));
      }
      return () => subscribers.delete(listener);
    },
    flushNow: coordinator.flushNow,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanup.splice(0).forEach((dispose) => dispose());
      observers.splice(0).forEach((observer) => observer.disconnect());
      subscribers.clear();
      coordinator.destroy();
      root.dataset.sentiqFrameDiscipline = "inactive";
    },
  });

  scheduleViewportMeasurement("initial");
  scheduleSidebarMeasurement("initial");
  scheduleAttachmentMeasurement("initial");
  scheduleTextareaAutosize("initial");
  scheduleScrollAnchor("initial");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeFrameDiscipline, { once: true });
} else {
  initializeFrameDiscipline();
}
