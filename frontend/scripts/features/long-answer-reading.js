/* ============================================================
   SentIQ Liquid Glass V4 — Phase 6.5
   Long-answer reading mode and scroll-intent protection
   ============================================================ */

export const LONG_ANSWER_READING_VERSION = "6.5";

const READING_DISTANCE_THRESHOLD = 132;
const INTENT_WINDOW_MS = 720;
const SOURCE_TARGET_SELECTOR = [
  ".websurf-v2-source-explorer",
  ".websurf-v2-sources",
  ".web-search-details",
  ".web-search-results",
  ".web-search-source-fallback-list",
  ".deep-research-report-sources",
  ".deep-research-sources",
].join(", ");
const SOURCE_ITEM_SELECTOR = [
  ".websurf-v2-source",
  ".websurf-v2-featured-card",
  ".websurf-v2-explorer-source",
  ".web-search-card",
  ".web-search-source-link",
  "a[href]",
].join(", ");
const READING_BLOCK_SELECTOR = [
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
  ".code-block-wrap",
  ".math-display-shell",
  "table",
  ".message-image-container",
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(", ");

export function classifyLongAnswerProfile(profile = {}) {
  const textLength = Math.max(0, Number(profile.textLength) || 0);
  const blockCount = Math.max(0, Number(profile.blockCount) || 0);
  const heightRatio = Math.max(0, Number(profile.heightRatio) || 0);
  const codeBlocks = Math.max(0, Number(profile.codeBlocks) || 0);
  const mathBlocks = Math.max(0, Number(profile.mathBlocks) || 0);
  const tables = Math.max(0, Number(profile.tables) || 0);
  const images = Math.max(0, Number(profile.images) || 0);
  const sourceCount = Math.max(0, Number(profile.sourceCount) || 0);
  const richKinds = [codeBlocks, mathBlocks, tables, images, sourceCount]
    .filter((count) => count > 0).length;

  return Boolean(
    textLength >= 3600
    || (blockCount >= 22 && textLength >= 1500)
    || (heightRatio >= 1.6 && textLength >= 900)
    || (codeBlocks >= 2 && textLength >= 1200)
    || (mathBlocks >= 3 && textLength >= 850)
    || (tables >= 1 && textLength >= 1400)
    || (sourceCount >= 6 && textLength >= 1100)
    || (richKinds >= 3 && (textLength >= 800 || heightRatio >= 1.25))
  );
}

export function shouldBlockLatestRequest(state = {}) {
  return Boolean(
    state.readingEarlier
    && state.targetIsLatest
    && !state.intentional
    && !state.internal,
  );
}

function initLongAnswerReadingMode() {
  const chatMessages = document.getElementById("chat-messages");
  const scrollRegion = chatMessages?.closest(".chat-scroll-region");
  const latestButton = document.getElementById("scroll-anchor-pill");
  if (!(chatMessages instanceof HTMLElement) || !(scrollRegion instanceof HTMLElement) || !(latestButton instanceof HTMLButtonElement)) {
    return;
  }

  scrollRegion.dataset.readingModeVersion = LONG_ANSWER_READING_VERSION;
  latestButton.dataset.readingModeVersion = LONG_ANSWER_READING_VERSION;
  latestButton.innerHTML = [
    '<svg class="scroll-anchor-pill-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
    '<path d="M12 5v13"></path>',
    '<path d="m7 13 5 5 5-5"></path>',
    "</svg>",
    '<span class="scroll-anchor-pill-label">Latest</span>',
    '<span class="scroll-anchor-pill-dot" aria-hidden="true"></span>',
  ].join("");
  latestButton.setAttribute("aria-label", "Jump to latest");
  latestButton.setAttribute("title", "Jump to latest");

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") || { matches: false };
  const nativeScrollTo = typeof chatMessages.scrollTo === "function"
    ? chatMessages.scrollTo.bind(chatMessages)
    : null;
  const observedResizeNodes = new WeakSet();
  const pendingMessages = new Set();
  let messageFrame = 0;
  let sourceNavigationId = 0;
  let readingEarlier = false;
  let hasNewContent = false;
  let internalScroll = false;
  let intentionalLatestUntil = 0;
  let preservationSuspendedUntil = 0;
  let lastUserIntentAt = 0;
  let anchorElement = null;
  let anchorOffset = 0;
  let anchorSignature = "";
  let lockedScrollTop = 0;
  let preserveFrame = 0;
  let savedSourceReturn = null;

  function now() {
    return window.performance?.now?.() || Date.now();
  }

  function distanceFromLatest() {
    return Math.max(0, chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight);
  }

  function targetIsLatest(top) {
    if (!Number.isFinite(top)) return false;
    const maxTop = Math.max(0, chatMessages.scrollHeight - chatMessages.clientHeight);
    return top >= maxTop - 3;
  }

  function parseRequestedTop(args) {
    if (typeof args[0] === "number") return Number(args[1]);
    if (args[0] && typeof args[0] === "object" && Number.isFinite(Number(args[0].top))) {
      return Number(args[0].top);
    }
    return NaN;
  }

  function setLatestButtonVisible(visible) {
    latestButton.classList.toggle("visible", visible);
    latestButton.setAttribute("aria-hidden", visible ? "false" : "true");
    latestButton.tabIndex = visible ? 0 : -1;
  }

  function syncLatestButton() {
    const visible = readingEarlier && distanceFromLatest() > READING_DISTANCE_THRESHOLD;
    const label = latestButton.querySelector(".scroll-anchor-pill-label");
    if (label) label.textContent = hasNewContent ? "New" : "Latest";
    latestButton.dataset.hasNewContent = hasNewContent ? "true" : "false";
    const accessibleLabel = hasNewContent
      ? "New messages. Jump to latest."
      : "Jump to latest";
    latestButton.setAttribute("aria-label", accessibleLabel);
    latestButton.setAttribute("title", accessibleLabel);
    setLatestButtonVisible(visible);
  }

  function markUserIntent() {
    lastUserIntentAt = now();
  }

  function findReadingAnchor() {
    const scrollerRect = chatMessages.getBoundingClientRect();
    const x = Math.min(scrollerRect.right - 24, scrollerRect.left + Math.max(32, scrollerRect.width / 2));
    const y = Math.min(scrollerRect.bottom - 24, scrollerRect.top + 32);
    const atPoint = typeof document.elementsFromPoint === "function"
      ? document.elementsFromPoint(x, y)
      : [];
    const pointElement = atPoint.find((element) => (
      element instanceof HTMLElement
      && chatMessages.contains(element)
      && element.closest(".message")
      && !element.closest("button, a, input, textarea, [role='button'], .long-answer-source-nav")
    ));
    if (pointElement) {
      const block = pointElement.closest(READING_BLOCK_SELECTOR) || pointElement.closest(".message");
      if (block instanceof HTMLElement && chatMessages.contains(block)) return block;
    }

    const candidates = Array.from(chatMessages.querySelectorAll(":scope > .message, :scope > .virt-placeholder"));
    return candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 8 && rect.top < scrollerRect.bottom - 8;
    }) || null;
  }

  function getAnchorSignature(element) {
    if (!(element instanceof HTMLElement)) return "";
    return String(element.innerText || element.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  function findReplacementAnchor() {
    if (!anchorSignature) return null;
    return Array.from(chatMessages.querySelectorAll(READING_BLOCK_SELECTOR))
      .find((candidate) => getAnchorSignature(candidate) === anchorSignature) || null;
  }

  function captureReadingAnchor() {
    const nextAnchor = findReadingAnchor();
    const scrollerRect = chatMessages.getBoundingClientRect();
    if (nextAnchor instanceof HTMLElement) {
      anchorElement = nextAnchor;
      anchorOffset = nextAnchor.getBoundingClientRect().top - scrollerRect.top;
      anchorSignature = getAnchorSignature(nextAnchor);
    } else {
      anchorElement = null;
      anchorOffset = 0;
      anchorSignature = "";
    }
    lockedScrollTop = chatMessages.scrollTop;
  }

  function performInternalScroll(top, behavior = "auto") {
    const normalizedTop = Math.max(0, Number(top) || 0);
    internalScroll = true;
    if (nativeScrollTo) nativeScrollTo({ top: normalizedTop, behavior });
    else chatMessages.scrollTop = normalizedTop;
    requestAnimationFrame(() => {
      internalScroll = false;
    });
  }

  function preserveReadingPosition() {
    preserveFrame = 0;
    if (!readingEarlier || now() < preservationSuspendedUntil) return;
    const scrollerRect = chatMessages.getBoundingClientRect();
    if (!(anchorElement?.isConnected && chatMessages.contains(anchorElement))) {
      anchorElement = findReplacementAnchor();
    }
    if (anchorElement?.isConnected && chatMessages.contains(anchorElement)) {
      const currentOffset = anchorElement.getBoundingClientRect().top - scrollerRect.top;
      const delta = currentOffset - anchorOffset;
      if (Math.abs(delta) > 0.75) {
        performInternalScroll(chatMessages.scrollTop + delta, "auto");
      }
    } else if (Math.abs(chatMessages.scrollTop - lockedScrollTop) > 1) {
      performInternalScroll(lockedScrollTop, "auto");
    }
    requestAnimationFrame(captureReadingAnchor);
    syncLatestButton();
  }

  function schedulePreserveReadingPosition() {
    if (!readingEarlier || preserveFrame) return;
    preserveFrame = requestAnimationFrame(preserveReadingPosition);
  }

  function allowLatestNavigation(durationMs = INTENT_WINDOW_MS) {
    intentionalLatestUntil = now() + durationMs;
    preservationSuspendedUntil = intentionalLatestUntil;
    readingEarlier = false;
    hasNewContent = false;
    anchorElement = null;
    anchorSignature = "";
    syncLatestButton();
  }

  function guardedScrollTo(...args) {
    const requestedTop = parseRequestedTop(args);
    const intentional = now() <= intentionalLatestUntil;
    if (shouldBlockLatestRequest({
      readingEarlier,
      targetIsLatest: targetIsLatest(requestedTop),
      intentional,
      internal: internalScroll,
    })) {
      hasNewContent = true;
      syncLatestButton();
      schedulePreserveReadingPosition();
      return undefined;
    }
    if (nativeScrollTo) return nativeScrollTo(...args);
    if (Number.isFinite(requestedTop)) chatMessages.scrollTop = requestedTop;
    return undefined;
  }

  try {
    Object.defineProperty(chatMessages, "scrollTo", {
      configurable: true,
      writable: true,
      value: guardedScrollTo,
    });
  } catch {
    try { chatMessages.scrollTo = guardedScrollTo; } catch { /* native method remains available */ }
  }

  function getSourceTargets(message) {
    return Array.from(message.querySelectorAll(SOURCE_TARGET_SELECTOR))
      .filter((target) => !target.closest(".long-answer-source-nav"));
  }

  function countSources(message) {
    const targets = getSourceTargets(message);
    const urls = new Set();
    targets.forEach((target) => {
      target.querySelectorAll("a[href]").forEach((link) => {
        const href = String(link.getAttribute("href") || "").trim();
        if (href && href !== "#") urls.add(href);
      });
    });
    if (urls.size) return urls.size;
    return targets.reduce((total, target) => total + target.querySelectorAll(SOURCE_ITEM_SELECTOR).length, 0);
  }

  function collectLongAnswerProfile(message) {
    const content = message.querySelector(":scope > .message-content");
    if (!(content instanceof HTMLElement)) return null;
    const text = String(content.innerText || content.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const viewportHeight = Math.max(1, chatMessages.clientHeight || window.innerHeight || 1);
    return {
      content,
      profile: {
        textLength: text.length,
        blockCount: content.querySelectorAll("p, li, h1, h2, h3, h4, blockquote").length,
        heightRatio: content.scrollHeight / viewportHeight,
        codeBlocks: content.querySelectorAll(".code-block-wrap, pre").length,
        mathBlocks: content.querySelectorAll(".math-display-shell, .katex-display").length,
        tables: content.querySelectorAll("table").length,
        images: content.querySelectorAll(".message-image, .message-chart-image, .image-generation-card").length,
        sourceCount: countSources(message),
      },
    };
  }

  function restoreSavedSourcePosition() {
    if (!savedSourceReturn) return;
    preservationSuspendedUntil = now() + 420;
    let top = savedSourceReturn.scrollTop;
    if (savedSourceReturn.anchor?.isConnected && chatMessages.contains(savedSourceReturn.anchor)) {
      const currentOffset = savedSourceReturn.anchor.getBoundingClientRect().top - chatMessages.getBoundingClientRect().top;
      top = chatMessages.scrollTop + (currentOffset - savedSourceReturn.offset);
    }
    performInternalScroll(top, prefersReducedMotion.matches ? "auto" : "smooth");
    if (savedSourceReturn.returnButton) savedSourceReturn.returnButton.hidden = true;
    savedSourceReturn = null;
    readingEarlier = distanceFromLatest() > READING_DISTANCE_THRESHOLD;
    requestAnimationFrame(() => {
      captureReadingAnchor();
      syncLatestButton();
    });
  }

  function createSourceNavigation(message, content, sourceTarget, sourceCount) {
    let navigation = content.querySelector(":scope > .long-answer-source-nav");
    let sourceAnchor = sourceTarget.previousElementSibling;
    if (!sourceAnchor?.classList?.contains("long-answer-source-anchor")) {
      sourceNavigationId += 1;
      sourceAnchor = document.createElement("div");
      sourceAnchor.className = "long-answer-source-anchor";
      sourceAnchor.id = `response-sources-${sourceNavigationId}`;
      sourceAnchor.tabIndex = -1;
      sourceAnchor.setAttribute("role", "region");
      sourceAnchor.setAttribute("aria-label", "Sources");

      const returnButton = document.createElement("button");
      returnButton.className = "long-answer-source-return";
      returnButton.type = "button";
      returnButton.hidden = true;
      returnButton.innerHTML = '<span aria-hidden="true">↑</span><span>Back to answer</span>';
      returnButton.addEventListener("click", restoreSavedSourcePosition);
      sourceAnchor.appendChild(returnButton);
      sourceTarget.parentNode?.insertBefore(sourceAnchor, sourceTarget);
    }

    if (!navigation) {
      navigation = document.createElement("nav");
      navigation.className = "long-answer-source-nav";
      navigation.setAttribute("aria-label", "Sources");

      const sourceButton = document.createElement("button");
      sourceButton.className = "long-answer-source-jump";
      sourceButton.type = "button";
      sourceButton.innerHTML = [
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
        '<path d="M7 4h10"></path>',
        '<path d="M7 9h10"></path>',
        '<path d="M7 14h6"></path>',
        '<circle cx="5" cy="4" r="1"></circle>',
        '<circle cx="5" cy="9" r="1"></circle>',
        '<circle cx="5" cy="14" r="1"></circle>',
        "</svg>",
        '<span class="long-answer-source-jump-label"></span>',
      ].join("");
      sourceButton.addEventListener("click", () => {
        const currentAnchor = findReadingAnchor();
        const offset = currentAnchor instanceof HTMLElement
          ? currentAnchor.getBoundingClientRect().top - chatMessages.getBoundingClientRect().top
          : 0;
        const returnButton = sourceAnchor.querySelector(".long-answer-source-return");
        savedSourceReturn = {
          anchor: currentAnchor,
          offset,
          scrollTop: chatMessages.scrollTop,
          returnButton,
        };
        returnButton.hidden = false;
        preservationSuspendedUntil = now() + 620;
        readingEarlier = true;
        const targetTop = chatMessages.scrollTop
          + sourceAnchor.getBoundingClientRect().top
          - chatMessages.getBoundingClientRect().top
          - 18;
        performInternalScroll(targetTop, prefersReducedMotion.matches ? "auto" : "smooth");
        sourceAnchor.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          captureReadingAnchor();
          syncLatestButton();
        });
      });
      navigation.appendChild(sourceButton);
      content.insertBefore(navigation, content.firstChild);
    }

    const sourceButton = navigation.querySelector(".long-answer-source-jump");
    const countLabel = navigation.querySelector(".long-answer-source-jump-label");
    sourceButton?.setAttribute("aria-controls", sourceAnchor.id);
    sourceButton?.setAttribute("aria-label", `Jump to ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`);
    if (countLabel) countLabel.textContent = `Sources · ${sourceCount}`;
  }

  function removeSourceNavigation(content) {
    content.querySelector(":scope > .long-answer-source-nav")?.remove();
    content.querySelectorAll(".long-answer-source-anchor").forEach((anchor) => anchor.remove());
  }

  function observeMessageSize(message, content) {
    if (!resizeObserver) return;
    [message, content].forEach((node) => {
      if (!(node instanceof HTMLElement) || observedResizeNodes.has(node)) return;
      observedResizeNodes.add(node);
      resizeObserver.observe(node);
    });
  }

  function syncMessage(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains("assistant")) return;
    const result = collectLongAnswerProfile(message);
    if (!result) return;
    const { content, profile } = result;
    const longAnswer = classifyLongAnswerProfile(profile);
    message.dataset.readingModeVersion = LONG_ANSWER_READING_VERSION;
    message.dataset.longAnswer = longAnswer ? "true" : "false";
    observeMessageSize(message, content);

    const sourceTarget = getSourceTargets(message)[0];
    if (longAnswer && sourceTarget instanceof HTMLElement && profile.sourceCount > 0) {
      createSourceNavigation(message, content, sourceTarget, profile.sourceCount);
    } else {
      removeSourceNavigation(content);
    }
  }

  function flushMessages() {
    messageFrame = 0;
    const messages = Array.from(pendingMessages);
    pendingMessages.clear();
    messages.forEach(syncMessage);
  }

  function scheduleMessage(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains("assistant")) return;
    pendingMessages.add(message);
    if (!messageFrame) messageFrame = requestAnimationFrame(flushMessages);
  }

  function collectAffectedMessages(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    const message = element.matches(".message.assistant")
      ? element
      : element.closest(".message.assistant");
    if (message) scheduleMessage(message);
    element.querySelectorAll?.(".message.assistant").forEach(scheduleMessage);
  }

  function isLatestGrowingMessage(node) {
    const message = node instanceof Element
      ? (node.matches(".message") ? node : node.closest(".message"))
      : null;
    if (!(message instanceof HTMLElement)) return false;
    const messages = chatMessages.querySelectorAll(":scope > .message");
    const latest = messages[messages.length - 1];
    return message === latest || Boolean(message.querySelector(".typing-active, .streaming-tail, .deep-research-card.running"));
  }

  const resizeObserver = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
      let latestContentGrew = false;
      entries.forEach((entry) => {
        scheduleMessage(entry.target.closest?.(".message.assistant"));
        if (isLatestGrowingMessage(entry.target)) latestContentGrew = true;
      });
      if (readingEarlier) {
        if (latestContentGrew) hasNewContent = true;
        syncLatestButton();
        schedulePreserveReadingPosition();
      }
    })
    : null;

  const mutationObserver = new MutationObserver((records) => {
    let hasConversationContent = false;
    let latestContentChanged = false;
    records.forEach((record) => {
      collectAffectedMessages(record.target);
      if (record.type === "characterData") {
        hasConversationContent = true;
        if (isLatestGrowingMessage(record.target.parentElement)) latestContentChanged = true;
      }
      record.addedNodes.forEach((node) => {
        collectAffectedMessages(node);
        const isReadingUi = node instanceof Element
          && Boolean(node.closest?.(".long-answer-source-nav, .long-answer-source-anchor"));
        if (!isReadingUi) {
          hasConversationContent = true;
          if (isLatestGrowingMessage(node instanceof Element ? node : record.target)) latestContentChanged = true;
        }
      });
    });

    if (!chatMessages.querySelector(".message")) {
      readingEarlier = false;
      hasNewContent = false;
      anchorElement = null;
      anchorSignature = "";
      savedSourceReturn = null;
      syncLatestButton();
      return;
    }

    if (readingEarlier && hasConversationContent) {
      if (latestContentChanged) hasNewContent = true;
      syncLatestButton();
      schedulePreserveReadingPosition();
    }
  });

  mutationObserver.observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  chatMessages.addEventListener("wheel", markUserIntent, { passive: true });
  chatMessages.addEventListener("touchstart", markUserIntent, { passive: true });
  chatMessages.addEventListener("pointerdown", markUserIntent, { passive: true });
  chatMessages.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      markUserIntent();
    }
  });
  chatMessages.addEventListener("scroll", () => {
    if (internalScroll) return;
    const distance = distanceFromLatest();
    const recentUserIntent = now() - lastUserIntentAt <= INTENT_WINDOW_MS;
    if (distance > READING_DISTANCE_THRESHOLD) {
      readingEarlier = true;
      captureReadingAnchor();
    } else if (recentUserIntent || now() <= intentionalLatestUntil) {
      readingEarlier = false;
      hasNewContent = false;
      anchorElement = null;
      savedSourceReturn = null;
    } else if (readingEarlier) {
      schedulePreserveReadingPosition();
    }
    syncLatestButton();
  }, { passive: true });

  latestButton.addEventListener("click", () => allowLatestNavigation(), true);
  document.getElementById("send-btn")?.addEventListener("click", () => allowLatestNavigation(1100), true);
  document.getElementById("chat-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) allowLatestNavigation(1100);
  }, true);
  document.getElementById("new-chat-btn")?.addEventListener("click", () => allowLatestNavigation(1100), true);

  chatMessages.querySelectorAll(".message.assistant").forEach(scheduleMessage);
  resizeObserver?.observe(chatMessages);
  syncLatestButton();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initLongAnswerReadingMode();
}
