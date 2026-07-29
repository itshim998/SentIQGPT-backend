import {
  OPTIMISTIC_SEND_TIMEOUT_MS,
  UI_STABILITY_VERSION,
  isComposerSendCandidate,
  messageTextMatches,
  normalizeExecutionMode,
  normalizeUserDisplayText,
  shouldShowOptimisticUserMessage,
} from "./ui-stability-state.mjs";

function initializeUiStability() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQUIStability?.version === UI_STABILITY_VERSION) return;

  const root = document.documentElement;
  const chatInput = document.getElementById("chat-input");
  const sendButton = document.getElementById("send-btn");
  const chatMessages = document.getElementById("chat-messages");
  const welcomeScreen = document.getElementById("welcome-screen");
  const executionModeMenu = document.getElementById("execution-mode-menu");
  const imageModeBar = document.getElementById("image-mode-bar");
  const webModeBar = document.getElementById("web-search-mode-bar");
  const deepResearchModeBar = document.getElementById("deep-research-mode-bar");

  if (!(chatInput instanceof HTMLTextAreaElement) || !(chatMessages instanceof HTMLElement)) return;

  let pendingSend = null;
  let checkTimer = 0;
  let timeoutHandle = 0;
  let textareaSizeFrame = 0;

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || element.hidden) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    return window.getComputedStyle(element).display !== "none";
  }

  function readToolMode() {
    if (isVisible(deepResearchModeBar)) return "deep-research";
    if (isVisible(imageModeBar)) return "image";
    if (isVisible(webModeBar)) return "web";
    return "none";
  }

  function readExecutionMode() {
    const selected = executionModeMenu?.querySelector(
      "[data-execution-mode][aria-selected='true'], [data-execution-mode].active",
    );
    return normalizeExecutionMode(selected?.getAttribute("data-execution-mode"));
  }

  function parsePixelValue(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function stabilizeTextareaHeight(reason = "input") {
    if (textareaSizeFrame) window.cancelAnimationFrame(textareaSizeFrame);
    textareaSizeFrame = window.requestAnimationFrame(() => {
      textareaSizeFrame = 0;
      const computed = window.getComputedStyle(chatInput);
      const minHeight = Math.max(40, parsePixelValue(computed.minHeight, 44));
      const maxHeight = Math.max(minHeight, parsePixelValue(computed.maxHeight, 150));
      const measurementHeight = `${Math.round(minHeight)}px`;

      /* Temporarily constrain the authoritative CSS variable only inside this
         animation-frame callback. The final value is restored before paint,
         so scrollHeight can shrink as well as grow without a visible collapse. */
      chatInput.style.setProperty("--sentiq-stable-textarea-height", measurementHeight);
      const naturalHeight = Math.max(minHeight, chatInput.scrollHeight);
      const nextHeight = Math.min(naturalHeight, maxHeight);
      const nextValue = `${Math.round(nextHeight)}px`;
      chatInput.style.setProperty("--sentiq-stable-textarea-height", nextValue);
      chatInput.style.overflowY = naturalHeight > maxHeight + 1 ? "auto" : "hidden";
      chatInput.dataset.sentiqStableTextarea = reason;
    });
  }

  function getUserMessageText(message) {
    return message?.querySelector?.(".message-content")?.textContent || "";
  }

  function getRealUserMessages() {
    return Array.from(chatMessages.querySelectorAll(".message.user:not(.sentiq-optimistic-user)"));
  }

  function findNewRealMessage(record) {
    const messages = getRealUserMessages();
    if (messages.length <= record.baselineUserCount) return null;
    return messages
      .slice(record.baselineUserCount)
      .find((message) => messageTextMatches(getUserMessageText(message), record.matchText)) || null;
  }

  function clearTimers() {
    if (checkTimer) window.clearTimeout(checkTimer);
    if (timeoutHandle) window.clearTimeout(timeoutHandle);
    checkTimer = 0;
    timeoutHandle = 0;
  }

  function removeOptimisticBubble(record = pendingSend) {
    record?.optimisticBubble?.remove?.();
    if (record) record.optimisticBubble = null;
  }

  function syncProgrammaticComposerClear(record) {
    if (!record || record.clearEventDispatched || chatInput.value) return;
    record.clearEventDispatched = true;
    chatInput.dispatchEvent(new Event("input", { bubbles: true }));
    chatInput.dataset.sentiqSendState = "consumed";
  }

  async function flushContinuityDraft() {
    try {
      await window.SentIQConversationContinuity?.flush?.();
    } catch {
      // Draft persistence remains best-effort; normal continuity retries still apply.
    }
  }

  function settlePendingSend(realMessage = null) {
    const record = pendingSend;
    if (!record) return;
    removeOptimisticBubble(record);
    syncProgrammaticComposerClear(record);
    clearTimers();
    pendingSend = null;
    chatInput.removeAttribute("data-sentiq-send-state");
    root.dataset.sentiqOptimisticSend = realMessage ? "settled" : "cancelled";
    if (realMessage) {
      window.setTimeout(() => { void flushContinuityDraft(); }, 0);
      document.dispatchEvent(new CustomEvent("sentiq-composer-send-settled", {
        detail: {
          executionMode: record.executionMode,
          toolMode: record.toolMode,
          textLength: record.text.length,
        },
      }));
    }
  }

  function appendOptimisticBubble(record) {
    if (!record.optimisticEligible || record.optimisticBubble || !window.SentIQChat?.appendMessageBubble) return;
    const result = window.SentIQChat.appendMessageBubble("user", record.text);
    const bubble = result?.bubble;
    if (!(bubble instanceof HTMLElement)) return;
    bubble.classList.add("sentiq-optimistic-user");
    bubble.dataset.sentiqOptimisticSend = record.id;
    bubble.setAttribute("aria-busy", "true");
    record.optimisticBubble = bubble;
    chatMessages.classList.add("has-messages");
    if (welcomeScreen instanceof HTMLElement) welcomeScreen.style.display = "none";
    root.dataset.sentiqOptimisticSend = "pending";
  }

  function schedulePendingCheck(delay = 0) {
    if (!pendingSend || checkTimer) return;
    checkTimer = window.setTimeout(checkPendingSend, Math.max(0, delay));
  }

  function checkPendingSend() {
    checkTimer = 0;
    const record = pendingSend;
    if (!record) return;

    const realMessage = findNewRealMessage(record);
    if (realMessage) {
      settlePendingSend(realMessage);
      return;
    }

    const elapsedMs = performance.now() - record.startedAt;
    const composerCleared = chatInput.value.length === 0;
    if (composerCleared) syncProgrammaticComposerClear(record);

    if (record.optimisticEligible && shouldShowOptimisticUserMessage({
      executionMode: record.executionMode,
      composerCleared,
      matchingRealMessagePresent: false,
      elapsedMs,
    })) {
      appendOptimisticBubble(record);
    }

    if (elapsedMs >= OPTIMISTIC_SEND_TIMEOUT_MS) {
      settlePendingSend();
      return;
    }

    if (chatInput.value && elapsedMs > 250 && messageTextMatches(chatInput.value, record.text)) {
      settlePendingSend();
      return;
    }

    schedulePendingCheck(elapsedMs < 1_000 ? 32 : 150);
  }

  function captureSendAttempt({ composing = false } = {}) {
    const text = String(chatInput.value || "").trim();
    const matchText = normalizeUserDisplayText(text);
    const toolMode = readToolMode();
    if (!isComposerSendCandidate({
      text,
      sendDisabled: Boolean(sendButton?.disabled || sendButton?.getAttribute("aria-disabled") === "true"),
      stopMode: Boolean(sendButton?.classList.contains("is-stop")),
      composing,
    })) return;

    if (pendingSend) settlePendingSend();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    pendingSend = {
      id,
      text,
      matchText,
      toolMode,
      executionMode: readExecutionMode(),
      optimisticEligible: toolMode === "none" && Boolean(matchText),
      baselineUserCount: getRealUserMessages().length,
      optimisticBubble: null,
      clearEventDispatched: false,
      startedAt: performance.now(),
    };
    chatInput.dataset.sentiqSendState = "captured";
    timeoutHandle = window.setTimeout(() => settlePendingSend(), OPTIMISTIC_SEND_TIMEOUT_MS + 250);
    schedulePendingCheck();
  }

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("#send-btn")) return;
    captureSendAttempt();
  }, true);

  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.defaultPrevented) return;
    captureSendAttempt({ composing: Boolean(event.isComposing) });
  }, true);

  chatInput.addEventListener("input", () => {
    stabilizeTextareaHeight("input");
    if (pendingSend) schedulePendingCheck();
  }, { passive: true });
  chatInput.addEventListener("change", () => stabilizeTextareaHeight("change"), { passive: true });
  chatInput.addEventListener("compositionend", () => stabilizeTextareaHeight("compositionend"), { passive: true });
  window.addEventListener("resize", () => stabilizeTextareaHeight("viewport"), { passive: true });
  document.addEventListener("sentiq-mobile-composer-change", () => stabilizeTextareaHeight("mobile-composer"));

  const messageObserver = new MutationObserver((records) => {
    if (!pendingSend) return;
    const relevant = records.some((record) => Array.from(record.addedNodes).some((node) => (
      node instanceof Element
      && (node.matches?.(".message.user, .message-error-wrap")
        || node.querySelector?.(".message.user, .message-error-wrap"))
    )));
    if (relevant) schedulePendingCheck();
  });
  messageObserver.observe(chatMessages, { childList: true, subtree: true });

  window.addEventListener("pagehide", () => settlePendingSend(), { passive: true });

  window.SentIQUIStability = Object.freeze({
    version: UI_STABILITY_VERSION,
    hasPendingSend: () => Boolean(pendingSend),
    cancelPendingSend: () => settlePendingSend(),
    resizeTextarea: () => stabilizeTextareaHeight("manual"),
  });
  root.dataset.sentiqUiStabilityVersion = UI_STABILITY_VERSION;
  stabilizeTextareaHeight("initial");
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeUiStability, { once: true });
  } else {
    initializeUiStability();
  }
}
