/* SentIQ Liquid Glass V4 — Phase 9.1 existing UI lifecycle bridge */

const UI_STATE_BRIDGE_VERSION = "9.1";
const STREAMING_SELECTOR = [
  ".message.assistant[data-response-status='generating']",
  ".message.assistant[data-streaming='true']",
  ".message.assistant .response-inline-loader",
  ".message.assistant .sentiq-loader",
  ".message.assistant [data-semantic-activity-state='thinking']",
  ".message.assistant [data-semantic-activity-state='reading-files']",
  ".message.assistant [data-semantic-activity-state='searching']",
  ".message.assistant [data-semantic-activity-state='comparing-sources']",
  ".message.assistant [data-semantic-activity-state='creating-image']",
  ".message.assistant [data-semantic-activity-state='preparing-document']",
  ".message.assistant [data-semantic-activity-state='generating-chart']",
].join(",");
const BACKGROUND_TASK_SELECTOR = [
  ".deep-research-card[data-deep-research-status='running']",
  ".deep-research-card.running[aria-busy='true']",
].join(",");
const UPLOADING_SELECTOR = [
  ".composer-attachment[data-attachment-state='processing']",
  ".composer-attachment[data-attachment-state='uploading']",
  ".composer-attachment.is-uploading",
].join(",");

function initializeUIStateBridge() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const state = window.SentIQUIState;
  if (!state || document.documentElement.dataset.sentiqUiBridgeVersion === UI_STATE_BRIDGE_VERSION) return;
  document.documentElement.dataset.sentiqUiBridgeVersion = UI_STATE_BRIDGE_VERSION;

  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const composer = chatInput?.closest(".chat-input-wrapper");
  const filePreview = document.getElementById("file-preview-area");
  const scrollRegion = document.querySelector(".chat-scroll-region");
  const livePanel = document.getElementById("live-beta-panel");
  const accountButton = document.getElementById("account-btn");
  const authUserChip = document.getElementById("auth-user-chip");
  const selectedContext = document.getElementById("selected-context-bar");
  const imageModeBar = document.getElementById("image-mode-bar");
  const webModeBar = document.getElementById("web-search-mode-bar");
  const researchModeBar = document.getElementById("deep-research-mode-bar");
  const imageModeButton = document.getElementById("image-gen-btn");
  const webModeButton = document.getElementById("websurf-basic-btn");
  const researchModeButton = document.getElementById("deep-research-btn");
  const sendButton = document.getElementById("send-btn");

  let authKnown = false;
  let explicitAuthenticated = false;
  let frame = 0;
  let lastSignature = "";

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    try {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    } catch {
      return element.style.display !== "none";
    }
  }

  function activeTool() {
    if (isVisible(researchModeBar) || researchModeButton?.getAttribute("aria-pressed") === "true") return "deep-research";
    if (isVisible(imageModeBar) || imageModeButton?.getAttribute("aria-pressed") === "true") return "image";
    if (isVisible(webModeBar) || webModeButton?.getAttribute("aria-pressed") === "true") return "websurf";
    return "";
  }

  function messageElements() {
    if (!(chatMessages instanceof HTMLElement)) return [];
    return Array.from(chatMessages.querySelectorAll(":scope > .message, .message.user, .message.assistant"));
  }

  function sendButtonSignalsStreaming() {
    if (!(sendButton instanceof HTMLElement)) return false;
    const label = [sendButton.getAttribute("aria-label"), sendButton.title, sendButton.textContent, sendButton.className]
      .filter(Boolean)
      .join(" ");
    return /\b(stop|cancel)\b/i.test(label) || sendButton.getAttribute("aria-pressed") === "true";
  }

  function hasForegroundStream(last) {
    if (!(chatMessages instanceof HTMLElement)) return false;
    if (sendButtonSignalsStreaming()) return true;
    if (last instanceof HTMLElement && last.matches(".message.assistant")) {
      return Boolean(last.matches(STREAMING_SELECTOR) || last.querySelector(STREAMING_SELECTOR));
    }
    return false;
  }

  function hasBackgroundTask() {
    return Boolean(chatMessages?.querySelector(BACKGROUND_TASK_SELECTOR));
  }

  function hasRecoverableError(last) {
    if (composer?.querySelector(".failure-recovery-tray, .composer-attachment[data-attachment-state='failed'] .composer-attachment-retry")) return true;
    if (!(last instanceof HTMLElement)) return false;
    return Boolean(last.querySelector(
      ".failure-recovery-panel, [data-failure-recovery-action='true'], [data-response-status='interrupted'], [data-response-status='failed']",
    ));
  }

  function isReadingHistory(hasMessages) {
    if (!hasMessages || !(scrollRegion instanceof HTMLElement)) return false;
    const distanceFromEnd = scrollRegion.scrollHeight - scrollRegion.clientHeight - scrollRegion.scrollTop;
    return distanceFromEnd > Math.max(96, scrollRegion.clientHeight * 0.14);
  }

  function liveIsActive() {
    if (!isVisible(livePanel)) return false;
    return !["ended", "idle"].includes(livePanel?.dataset.state || "");
  }

  function inferAuthenticated() {
    if (authKnown) return explicitAuthenticated;
    return isVisible(accountButton) || isVisible(authUserChip);
  }

  function collectFacts() {
    const messages = messageElements();
    const last = messages[messages.length - 1] || null;
    const attachments = filePreview instanceof HTMLElement
      ? Array.from(filePreview.querySelectorAll(".composer-attachment"))
      : [];
    const uploadingCount = composer instanceof HTMLElement ? composer.querySelectorAll(UPLOADING_SELECTOR).length : 0;
    const hasMessages = messages.length > 0;
    return {
      authKnown,
      authenticated: inferAuthenticated(),
      hasMessages,
      draftLength: chatInput instanceof HTMLTextAreaElement ? chatInput.value.trim().length : 0,
      attachmentCount: attachments.filter((attachment) => attachment.getAttribute("data-attachment-state") !== "failed").length,
      uploadingCount,
      hasSelectionContext: isVisible(selectedContext),
      selectedTool: activeTool(),
      streaming: hasForegroundStream(last),
      backgroundTask: hasBackgroundTask(),
      recoverableError: hasRecoverableError(last),
      readingHistory: isReadingHistory(hasMessages),
      liveActive: liveIsActive(),
    };
  }

  function signatureOf(facts) {
    return Object.keys(facts).map((key) => `${key}:${String(facts[key])}`).join("|");
  }

  function flush(reason = "dom-sync") {
    frame = 0;
    const facts = collectFacts();
    const signature = signatureOf(facts);
    if (signature === lastSignature) return;
    lastSignature = signature;
    state.patch(facts, { source: "ui-state-bridge", reason });
  }

  function schedule(reason = "dom-mutation") {
    if (frame) return;
    frame = window.requestAnimationFrame(() => flush(reason));
  }

  chatInput?.addEventListener("input", () => schedule("composer-input"), { passive: true });
  scrollRegion?.addEventListener("scroll", () => schedule("history-scroll"), { passive: true });
  window.addEventListener("resize", () => schedule("viewport-resize"), { passive: true });
  window.addEventListener("pageshow", () => schedule("page-show"), { passive: true });
  document.addEventListener("visibilitychange", () => schedule("visibility-change"));

  document.addEventListener("sentiq-auth-changed", (event) => {
    authKnown = true;
    explicitAuthenticated = Boolean(event?.detail?.session);
    schedule("auth-change");
  });
  document.addEventListener("sentiq-panel-opened", () => schedule("panel-opened"));
  document.addEventListener("sentiq-panel-closed", () => schedule("panel-closed"));
  document.addEventListener("sentiq-panel-stack-restored", () => schedule("panel-stack-restored"));

  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => (
      record.type === "childList"
      || [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "aria-pressed",
        "aria-busy",
        "data-state",
        "data-response-status",
        "data-attachment-state",
        "data-deep-research-status",
        "data-semantic-activity-state",
      ].includes(record.attributeName)
    ));
    if (relevant) schedule("observed-ui-change");
  });

  [chatMessages, composer, livePanel, accountButton, authUserChip].forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "aria-pressed",
        "aria-busy",
        "data-state",
        "data-response-status",
        "data-attachment-state",
        "data-deep-research-status",
        "data-semantic-activity-state",
      ],
    });
  });

  if (typeof ResizeObserver === "function" && scrollRegion instanceof HTMLElement) {
    const resizeObserver = new ResizeObserver(() => schedule("history-resize"));
    resizeObserver.observe(scrollRegion);
    if (chatMessages instanceof HTMLElement) resizeObserver.observe(chatMessages);
  }

  window.SentIQUIStateBridge = Object.freeze({
    version: UI_STATE_BRIDGE_VERSION,
    sync: (reason = "manual-sync") => flush(reason),
    collectFacts,
  });

  flush("initial-sync");
}

initializeUIStateBridge();
