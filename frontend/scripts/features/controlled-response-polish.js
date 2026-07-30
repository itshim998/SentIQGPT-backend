import {
  BLOCK_REVEAL_FALLBACK_MS,
  CONTROLLED_RESPONSE_POLISH_VERSION,
  buildRevealBlockKey,
} from "./controlled-response-polish-state.mjs";

const MESSAGE_SELECTOR = ".message.assistant";
const RICH_STREAM_SELECTOR = ":scope > .message-content > .streaming-rendered";
const REVEALABLE_SELECTOR = ":scope > :is(p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table, .code-block-wrap, .table-wrap, .katex-display, .math-block, .websurf-v2-featured-card, .deep-research-card)";
const CHART_SELECTOR = ".message-chart-container";

function initializeControlledResponsePolish() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQControlledResponsePolish?.version === CONTROLLED_RESPONSE_POLISH_VERSION) return;

  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const messageStates = new WeakMap();
  const pendingMessages = new Set();
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce), (update: slow)") || { matches: false };
  let frame = 0;

  function getMessageState(message) {
    let state = messageStates.get(message);
    if (state) return state;
    state = { seenBlockKeys: new Set() };
    messageStates.set(message, state);
    return state;
  }

  function settleBlock(block) {
    if (!(block instanceof HTMLElement)) return;
    block.classList.remove("sentiq-block-reveal");
    block.classList.add("sentiq-block-settled");
  }

  function revealBlock(block) {
    if (!(block instanceof HTMLElement)) return;
    if (reducedMotion.matches) {
      settleBlock(block);
      return;
    }
    block.classList.remove("sentiq-block-settled");
    block.classList.add("sentiq-block-reveal");
    block.addEventListener("animationend", () => settleBlock(block), { once: true });
    window.setTimeout(() => settleBlock(block), BLOCK_REVEAL_FALLBACK_MS);
  }

  function syncRichBlocks(message) {
    const stream = message.querySelector(RICH_STREAM_SELECTOR);
    if (!(stream instanceof HTMLElement)) return;
    const content = stream.parentElement;
    const streaming = Boolean(
      content?.classList.contains("typing-active")
      || content?.dataset.sentiqStreamingPhase === "streaming",
    );
    const state = getMessageState(message);
    const blocks = Array.from(stream.querySelectorAll(REVEALABLE_SELECTOR));

    blocks.forEach((block, index) => {
      if (!(block instanceof HTMLElement)) return;
      const key = buildRevealBlockKey({
        index,
        tagName: block.tagName,
        className: block.className,
      });
      block.dataset.sentiqRevealBlockKey = key;
      block.dataset.sentiqControlledResponse = CONTROLLED_RESPONSE_POLISH_VERSION;
      if (!streaming || state.seenBlockKeys.has(key)) {
        settleBlock(block);
        state.seenBlockKeys.add(key);
        return;
      }
      state.seenBlockKeys.add(key);
      revealBlock(block);
    });
  }

  function createChartWireframe() {
    const wireframe = document.createElement("div");
    wireframe.className = "sentiq-chart-wireframe";
    wireframe.setAttribute("aria-hidden", "true");
    const plot = document.createElement("div");
    plot.className = "sentiq-chart-wireframe-plot";
    [42, 68, 54, 82, 62, 74].forEach((height) => {
      const bar = document.createElement("span");
      bar.style.setProperty("--sentiq-wire-bar", `${height}%`);
      plot.appendChild(bar);
    });
    wireframe.appendChild(plot);
    return wireframe;
  }

  function syncChartWireframe(container) {
    if (!(container instanceof HTMLElement)) return;
    const frameHost = container.querySelector(":scope > .message-chart-frame") || container;
    const ready = container.classList.contains("is-ready")
      || Boolean(container.querySelector("canvas, .js-plotly-plot, .message-chart-image.loaded"));
    const failed = container.classList.contains("is-failed") || Boolean(container.querySelector(".message-chart-error"));
    const loading = container.classList.contains("is-loading") && !ready && !failed;
    let wireframe = container.querySelector(".sentiq-chart-wireframe");

    if (!loading) {
      wireframe?.remove();
      return;
    }
    if (!wireframe) wireframe = createChartWireframe();
    if (wireframe.parentElement !== frameHost) frameHost.appendChild(wireframe);
    container.dataset.sentiqReservedMedia = "16:9";
  }

  function syncMessage(message) {
    if (!(message instanceof HTMLElement) || !message.matches(MESSAGE_SELECTOR) || !message.isConnected) return;
    message.dataset.sentiqControlledResponse = CONTROLLED_RESPONSE_POLISH_VERSION;
    syncRichBlocks(message);
    message.querySelectorAll(CHART_SELECTOR).forEach(syncChartWireframe);
  }

  function scheduleMessage(message) {
    if (!(message instanceof HTMLElement) || !message.matches(MESSAGE_SELECTOR)) return;
    pendingMessages.add(message);
    if (frame) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      const batch = Array.from(pendingMessages);
      pendingMessages.clear();
      batch.forEach(syncMessage);
    });
  }

  function findMessage(node) {
    const element = node instanceof Element
      ? node
      : node?.parentElement instanceof Element
        ? node.parentElement
        : null;
    if (!element) return null;
    const message = element.matches(MESSAGE_SELECTOR) ? element : element.closest(MESSAGE_SELECTOR);
    return message instanceof HTMLElement ? message : null;
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      const message = findMessage(record.target);
      if (message) scheduleMessage(message);
      record.addedNodes.forEach((node) => {
        const addedMessage = findMessage(node);
        if (addedMessage) scheduleMessage(addedMessage);
        if (node instanceof Element) node.querySelectorAll?.(MESSAGE_SELECTOR).forEach(scheduleMessage);
      });
    });
  });

  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-sentiq-streaming-phase"],
  });
  chatMessages.querySelectorAll(MESSAGE_SELECTOR).forEach(scheduleMessage);

  window.SentIQControlledResponsePolish = Object.freeze({
    version: CONTROLLED_RESPONSE_POLISH_VERSION,
    sync() {
      chatMessages.querySelectorAll(MESSAGE_SELECTOR).forEach(scheduleMessage);
    },
  });
}

initializeControlledResponsePolish();
