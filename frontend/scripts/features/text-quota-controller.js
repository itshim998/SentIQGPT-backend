import {
  canRetryIntuitiveRequestInFast,
  normalizeTextAllowance,
  resolveTextQuotaView,
} from "./text-quota-state.mjs";

const PATCH_MARK = Symbol.for("sentiq.textQuotaController.patched");
const REFRESH_INTERVAL_MS = 60_000;
const NOTICE_DURATION_MS = 7_000;

(function initializeTextQuotaController() {
  const API = window.SentIQAPI;
  if (!API || API[PATCH_MARK]) return;
  API[PATCH_MARK] = true;

  let quotaUiEnabled = false;
  let allowance = null;
  let latestPayload = null;
  let refreshPromise = null;
  let refreshTimer = 0;
  let countdownTimer = 0;
  let notice = "";
  let noticeUntil = 0;
  let statusNode = null;
  let statusTitle = null;
  let statusDetail = null;
  let lastView = null;

  const originalSendMessageStream = API.sendMessageStream.bind(API);
  const originalSendMessage = API.sendMessage.bind(API);

  function currentExecutionMode() {
    return document.querySelector('[data-execution-mode="intuitive"].active') ? "intuitive" : "fast";
  }

  function hasHeavyComposerContext() {
    const preview = document.getElementById("file-preview-area");
    return Boolean(preview && !preview.hidden && preview.children.length > 0);
  }

  function ensureStatusNode() {
    if (statusNode?.isConnected) return statusNode;
    const wrapper = document.querySelector(".chat-input-wrapper");
    const composer = wrapper?.querySelector(".chat-input-area");
    if (!wrapper || !composer) return null;

    statusNode = document.createElement("div");
    statusNode.id = "text-quota-status";
    statusNode.className = "text-quota-status";
    statusNode.setAttribute("role", "status");
    statusNode.setAttribute("aria-live", "polite");
    statusNode.hidden = true;

    statusTitle = document.createElement("span");
    statusTitle.className = "text-quota-status-title";
    statusDetail = document.createElement("span");
    statusDetail.className = "text-quota-status-detail";
    statusNode.append(statusTitle, statusDetail);
    wrapper.appendChild(statusNode);
    return statusNode;
  }

  function setComposerBlocked(blocked) {
    const wrapper = document.querySelector(".chat-input-wrapper");
    const composer = wrapper?.querySelector(".chat-input-area");
    const input = document.getElementById("chat-input");
    wrapper?.classList.toggle("is-text-quota-exhausted", blocked);
    if (composer) {
      if (blocked) {
        if (!composer.hasAttribute("inert")) {
          composer.dataset.textQuotaInert = "true";
          composer.setAttribute("inert", "");
        }
        if (!composer.dataset.textQuotaAriaDisabled) {
          composer.dataset.textQuotaAriaDisabled = composer.getAttribute("aria-disabled") ?? "__absent__";
        }
        composer.setAttribute("aria-disabled", "true");
      } else {
        if (composer.dataset.textQuotaInert === "true") {
          composer.removeAttribute("inert");
          delete composer.dataset.textQuotaInert;
        }
        if (composer.dataset.textQuotaAriaDisabled) {
          const previous = composer.dataset.textQuotaAriaDisabled;
          if (previous === "__absent__") composer.removeAttribute("aria-disabled");
          else composer.setAttribute("aria-disabled", previous);
          delete composer.dataset.textQuotaAriaDisabled;
        }
      }
    }
    if (input) {
      if (blocked && !input.readOnly) {
        input.dataset.textQuotaReadOnly = "true";
        input.readOnly = true;
        input.blur();
      } else if (!blocked && input.dataset.textQuotaReadOnly === "true") {
        input.readOnly = false;
        delete input.dataset.textQuotaReadOnly;
      }
    }
  }

  function syncIntuitiveOption(selectable) {
    const option = document.querySelector('[data-execution-mode="intuitive"]');
    if (!option) return;
    const isGuestFastOnly = document.getElementById("execution-mode-control")?.classList.contains("guest-fast-only");
    const isToolLocked = document.getElementById("execution-mode-control")?.classList.contains("tool-fast-locked")
      || option.classList.contains("is-tool-locked");
    const allowed = selectable && !isGuestFastOnly && !isToolLocked;
    if (option.classList.contains("is-quota-unavailable") !== !allowed) {
      option.classList.toggle("is-quota-unavailable", !allowed);
    }
    const ariaVal = allowed ? "false" : "true";
    if (option.getAttribute("aria-disabled") !== ariaVal) {
      option.setAttribute("aria-disabled", ariaVal);
    }
    if (!isGuestFastOnly && !isToolLocked) {
      const nextTitle = allowed ? "Intuitive" : "Intuitive returns when tokens refresh";
      if (option.title !== nextTitle) option.title = nextTitle;
    }
  }

  function switchToFast(message = "Switched to Fast. Tokens are running low.") {
    const fastOption = document.querySelector('[data-execution-mode="fast"]');
    if (currentExecutionMode() !== "fast") fastOption?.click();
    notice = message;
    noticeUntil = Date.now() + NOTICE_DURATION_MS;
    render();
  }

  function render(now = Date.now()) {
    const node = ensureStatusNode();
    const view = resolveTextQuotaView({
      quotaUiEnabled,
      allowance,
      executionMode: currentExecutionMode(),
      heavyContext: hasHeavyComposerContext(),
      now,
    });
    lastView = view;
    syncIntuitiveOption(view.intuitiveSelectable);
    setComposerBlocked(view.blockComposer);

    if (!node || !view.visible) {
      if (node) node.hidden = true;
      return view;
    }

    node.hidden = false;
    node.dataset.state = view.state;
    node.classList.toggle("has-notice", Boolean(notice && noticeUntil > now));
    statusTitle.textContent = notice && noticeUntil > now ? notice : view.title;
    statusDetail.textContent = view.detail;

    if (view.shouldSwitchToFast && !view.blockComposer) {
      queueMicrotask(() => switchToFast());
    }
    return view;
  }

  function ingestBillingPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    latestPayload = payload;
    if (typeof payload.quota_ui_enabled === "boolean") {
      quotaUiEnabled = payload.quota_ui_enabled;
    }
    const summary = payload.summary && typeof payload.summary === "object" ? payload.summary : payload;
    const normalized = normalizeTextAllowance(summary?.text_allowance);
    if (normalized) allowance = summary.text_allowance;
    else if (typeof payload.quota_ui_enabled === "boolean" && !payload.quota_ui_enabled) allowance = null;
    render();
  }

  function allowanceFromError(error) {
    const details = error?.details;
    if (!details || typeof details !== "object" || details.policy_version !== "unified-text-tokens-v2") return null;
    return {
      policy_version: details.policy_version,
      plan_code: details.plan_code || "free",
      limit_tokens: details.limit_tokens,
      window_seconds: 18_000,
      used_tokens: details.used_tokens,
      reserved_tokens: details.reserved_tokens,
      remaining_tokens: details.remaining_tokens,
      fast_reserve_tokens: details.fast_reserve_tokens,
      fast_available_tokens: details.fast_available_tokens,
      intuitive_available_tokens: details.intuitive_available_tokens,
      intuitive_allowed: Number(details.intuitive_available_tokens || 0) > 0,
      required_mode: details.required_mode,
      exhausted: details.code === "unified_text_quota_exhausted" || Number(details.remaining_tokens || 0) <= 0,
      next_recovery_at: details.next_recovery_at || details.reset_at || null,
      full_reset_at: null,
    };
  }

  async function refresh(force = false) {
    if (!force && refreshPromise) return refreshPromise;
    refreshPromise = API.getBillingUsage()
      .then((payload) => {
        ingestBillingPayload(payload);
        return payload;
      })
      .catch(() => null)
      .finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function prepareFastRetry(error, originalMode, alreadyRetried) {
    const errorAllowance = allowanceFromError(error);
    if (errorAllowance) allowance = errorAllowance;
    render();
    if (!quotaUiEnabled) await refresh(true);
    const retryAllowance = allowance || allowanceFromError(error);
    if (!canRetryIntuitiveRequestInFast({
      error,
      originalMode,
      quotaUiEnabled,
      allowance: retryAllowance,
      alreadyRetried,
    })) return false;
    switchToFast();
    return true;
  }

  API.sendMessageStream = async function sendMessageStreamWithQuotaRetry(message, context = {}, callbacks = {}, signal = null) {
    const originalMode = context.executionMode === "intuitive" || context.execution_mode === "intuitive"
      ? "intuitive"
      : "fast";
    const alreadyRetried = context.__sentiqQuotaRetry === true;
    let suppressedError = null;
    const guardedCallbacks = {
      ...callbacks,
      onError(error, meta) {
        if (!alreadyRetried && originalMode === "intuitive" && error?.code && [
          "intuitive_fast_required",
          "unified_text_insufficient_for_request",
        ].includes(error.code)) {
          suppressedError = { error, meta };
          return;
        }
        callbacks.onError?.(error, meta);
      },
    };

    try {
      return await originalSendMessageStream(message, context, guardedCallbacks, signal);
    } catch (error) {
      if (await prepareFastRetry(error, originalMode, alreadyRetried)) {
        return await originalSendMessageStream(message, {
          ...context,
          executionMode: "fast",
          execution_mode: "fast",
          __sentiqQuotaRetry: true,
        }, callbacks, signal);
      }
      if (suppressedError) callbacks.onError?.(suppressedError.error, suppressedError.meta);
      throw error;
    } finally {
      void refresh(true);
    }
  };

  API.sendMessage = async function sendMessageWithQuotaRetry(message, context = {}) {
    const originalMode = context.executionMode === "intuitive" || context.execution_mode === "intuitive"
      ? "intuitive"
      : "fast";
    const alreadyRetried = context.__sentiqQuotaRetry === true;
    try {
      return await originalSendMessage(message, context);
    } catch (error) {
      if (await prepareFastRetry(error, originalMode, alreadyRetried)) {
        return await originalSendMessage(message, {
          ...context,
          executionMode: "fast",
          execution_mode: "fast",
          __sentiqQuotaRetry: true,
        });
      }
      throw error;
    } finally {
      void refresh(true);
    }
  };

  function handleComposerCapture(event) {
    const target = event.target instanceof Element ? event.target : null;
    const isSendAction = target?.closest("#send-btn")
      || (event.type === "keydown" && target?.id === "chat-input" && event.key === "Enter" && !event.shiftKey);
    const isModeAction = target?.closest("[data-execution-mode]");
    if (!isSendAction && !isModeAction) return;

    const isToolLocked = document.getElementById("execution-mode-control")?.classList.contains("tool-fast-locked")
      || document.querySelector('[data-execution-mode="intuitive"]')?.classList.contains("is-tool-locked");
    if (isModeAction?.getAttribute("data-execution-mode") === "intuitive" && isToolLocked) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    const view = render();
    if (view.blockComposer) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (isModeAction?.getAttribute("data-execution-mode") === "intuitive" && !view.intuitiveSelectable) {
      event.preventDefault();
      event.stopImmediatePropagation();
      switchToFast("Intuitive returns when your tokens refresh. Fast is still available.");
      return;
    }
    if (isSendAction && view.shouldSwitchToFast) switchToFast();
  }

  document.addEventListener("click", handleComposerCapture, true);
  document.addEventListener("keydown", handleComposerCapture, true);
  window.addEventListener("sentiq-billing-refresh", () => { void refresh(true); });
  window.addEventListener("sentiq-billing-summary", (event) => ingestBillingPayload(event.detail));
  document.addEventListener("sentiq-auth-changed", () => { void refresh(true); });
  window.addEventListener("focus", () => { void refresh(); });
  window.addEventListener("online", () => { void refresh(true); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  const observer = new MutationObserver(() => render());
  const start = () => {
    ensureStatusNode();
    const modeMenu = document.getElementById("execution-mode-menu");
    const filePreview = document.getElementById("file-preview-area");
    if (modeMenu) observer.observe(modeMenu, { attributes: true, subtree: true, attributeFilter: ["class", "aria-selected"] });
    if (filePreview) observer.observe(filePreview, { attributes: true, childList: true, subtree: false, attributeFilter: ["hidden"] });
    void refresh(true);
    refreshTimer = window.setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
    countdownTimer = window.setInterval(() => {
      if (notice && noticeUntil <= Date.now()) notice = "";
      if (lastView?.visible) render();
    }, 1_000);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  window.SentIQTextQuota = Object.freeze({
    refresh,
    getState: () => Object.freeze({ quotaUiEnabled, allowance: normalizeTextAllowance(allowance), view: lastView, payload: latestPayload }),
    switchToFast,
    destroy() {
      clearInterval(refreshTimer);
      clearInterval(countdownTimer);
      observer.disconnect();
    },
  });
})();
