// Guest experience policy for SentIQ Chat.
//
// This module intentionally sits outside chat-controller so guest-only product
// rules can evolve without adding more responsibility to the main controller.
// It is loaded as a side effect from shared/brand.js and therefore registers
// its guards before the chat controller binds its own handlers.

const GUEST_HANDOFF_KEY = "sentiq-chat:guest-handoff-v1";
const GUEST_HANDOFF_TARGET_KEY = "sentiq-chat:guest-handoff-target-v1";
const GUEST_RECOVERY_DRAFT_KEY = "sentiq-chat:guest-recovery-draft";
const GUEST_TEXT_LIMIT_TOKENS = 8_000;
const SIGN_IN_TO_CONTINUE = "Sign in to continue";
const GUEST_WELCOME_NOTE = "Log in to save your chats, get smarter responses, generate images, and more.";

let guestMode = true;
let apiWrapped = false;
let migrationInFlight = false;
let quotaRefreshInFlight = null;
let guestQuotaState = {
  limit: GUEST_TEXT_LIMIT_TOKENS,
  used: 0,
  remaining: GUEST_TEXT_LIMIT_TOKENS,
  exhausted: false,
  loaded: false,
};
let applyScheduled = false;
let mutationObserver = null;

function safeParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readSession(key) {
  try {
    return window.sessionStorage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeSession(key, value) {
  try {
    window.sessionStorage?.setItem(key, value);
  } catch {
    // Session storage is a best-effort continuity layer only.
  }
}

function removeSession(key) {
  try {
    window.sessionStorage?.removeItem(key);
  } catch {
    // Best effort.
  }
}

function createRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeHandoffMessage(message) {
  if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
  const content = typeof message.content === "string" ? message.content : "";
  if (!content.trim()) return null;
  return {
    id: typeof message.id === "string" && message.id ? message.id : createRequestId(),
    role: message.role,
    content,
    timestamp: message.timestamp || message.created_at || new Date().toISOString(),
    ...(message.clientRequestId || message.client_request_id
      ? { clientRequestId: String(message.clientRequestId || message.client_request_id) }
      : {}),
    ...(message.meta && typeof message.meta === "object" ? { meta: message.meta } : {}),
  };
}

function loadHandoffState() {
  const stored = safeParse(readSession(GUEST_HANDOFF_KEY), null);
  if (stored && Array.isArray(stored.messages)) {
    return {
      version: 1,
      updatedAt: Number(stored.updatedAt || Date.now()),
      messages: stored.messages.map(normalizeHandoffMessage).filter(Boolean),
    };
  }

  // Bootstrap from the controller's existing guest recovery snapshot. This
  // covers a guest conversation that existed before this module captured its
  // first request, including OAuth redirects in the same browser tab.
  const recovery = safeParse(readSession(GUEST_RECOVERY_DRAFT_KEY), null);
  const recoveryMessages = Array.isArray(recovery?.chat?.messages)
    ? recovery.chat.messages.map(normalizeHandoffMessage).filter(Boolean)
    : [];
  return {
    version: 1,
    updatedAt: Date.now(),
    messages: recoveryMessages,
  };
}

function saveHandoffState(state) {
  const normalized = {
    version: 1,
    updatedAt: Date.now(),
    messages: Array.isArray(state?.messages)
      ? state.messages.map(normalizeHandoffMessage).filter(Boolean).slice(-120)
      : [],
  };
  if (normalized.messages.length === 0) {
    removeSession(GUEST_HANDOFF_KEY);
    return normalized;
  }
  writeSession(GUEST_HANDOFF_KEY, JSON.stringify(normalized));
  return normalized;
}

function upsertHandoffMessage(message, stableKey = "") {
  const normalized = normalizeHandoffMessage(message);
  if (!normalized) return;
  const state = loadHandoffState();
  const lookupKey = stableKey || normalized.id;
  const index = state.messages.findIndex((item) => {
    if (stableKey) {
      const itemKey = item.meta?.guestHandoffKey || "";
      return itemKey === stableKey;
    }
    return item.id === normalized.id;
  });
  normalized.meta = {
    ...(normalized.meta || {}),
    ...(stableKey ? { guestHandoffKey: stableKey } : {}),
  };
  if (index >= 0) state.messages[index] = { ...state.messages[index], ...normalized };
  else state.messages.push(normalized);
  saveHandoffState(state);
}

function clearGuestHandoff() {
  removeSession(GUEST_HANDOFF_KEY);
  removeSession(GUEST_HANDOFF_TARGET_KEY);
}

function getFirstExchange(messages) {
  const firstUser = messages.find((message) => message.role === "user")?.content || "";
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  const firstAssistant = firstUserIndex >= 0
    ? messages.slice(firstUserIndex + 1).find((message) => message.role === "assistant")?.content || ""
    : "";
  return { firstUser, firstAssistant };
}

function getStructuredReply(result) {
  if (!result || typeof result !== "object") return "";
  const candidates = [result.reply, result.answer, result.content, result.text];
  return candidates.find((value) => typeof value === "string" && value.trim()) || "";
}

function setDisabled(node, disabled) {
  if (!node) return;
  if (node.disabled !== Boolean(disabled)) node.disabled = Boolean(disabled);
  const ariaValue = disabled ? "true" : "false";
  if (node.getAttribute("aria-disabled") !== ariaValue) node.setAttribute("aria-disabled", ariaValue);
}

function setActionGuestState(id, subtitle, options = {}) {
  const button = document.getElementById(id);
  if (!button) return;
  const disabled = Boolean(options.disabled);
  setDisabled(button, disabled);
  button.classList.toggle("auth-disabled", disabled);
  button.classList.toggle("guest-auth-required", disabled);
  if (disabled) button.dataset.guestAuthRequired = "true";
  else delete button.dataset.guestAuthRequired;
  if (options.forceVisible && guestMode) {
    if (button.style.display === "none") button.style.display = "";
    button.hidden = false;
  }
  const subtitleNode = button.querySelector(".composer-action-subtitle");
  if (subtitleNode && subtitle && subtitleNode.textContent !== subtitle) {
    subtitleNode.textContent = subtitle;
  }
}

function applyGuestWelcomeCopy() {
  if (!guestMode) return;
  const heading = document.getElementById("welcome-heading");
  const subtitle = document.getElementById("welcome-subtitle");
  const note = document.getElementById("auth-welcome-note");
  if (heading && heading.textContent !== "How can I help?") heading.textContent = "How can I help?";
  if (subtitle) {
    subtitle.hidden = true;
    subtitle.setAttribute("aria-hidden", "true");
  }
  if (note) {
    if (note.textContent !== GUEST_WELCOME_NOTE) note.textContent = GUEST_WELCOME_NOTE;
    note.style.display = "block";
  }
}

function applyExecutionModePolicy() {
  const control = document.getElementById("execution-mode-control");
  const toggle = document.getElementById("execution-mode-toggle");
  const menu = document.getElementById("execution-mode-menu");
  const label = document.getElementById("execution-mode-label");
  if (!control || !toggle) return;

  if (guestMode) {
    control.classList.add("guest-fast-only");
    control.classList.remove("open");
    if (label) label.textContent = "Fast";
    setDisabled(toggle, true);
    toggle.setAttribute("aria-expanded", "false");
    toggle.title = "Guest chats use Fast mode";
    if (menu) {
      menu.setAttribute("aria-hidden", "true");
      menu.querySelectorAll("[data-execution-mode]").forEach((option) => {
        const fast = option.getAttribute("data-execution-mode") === "fast";
        option.classList.toggle("active", fast);
        option.setAttribute("aria-selected", fast ? "true" : "false");
        setDisabled(option, true);
      });
    }
  } else {
    control.classList.remove("guest-fast-only");
    if (toggle.title === "Guest chats use Fast mode") toggle.title = "Choose execution mode";
  }
}

function applyGuestToolPolicy() {
  if (!guestMode) return;
  setActionGuestState("file-attach-btn", "Sign in to attach files", { disabled: true, forceVisible: true });
  setActionGuestState("websurf-basic-btn", "Sign in to search the web", { disabled: true, forceVisible: true });
  setActionGuestState("image-gen-btn", "Sign in to create images", { disabled: true, forceVisible: true });
  setActionGuestState("deep-research-btn", "Sign in to start Deep Research", { disabled: true, forceVisible: true });

  document.querySelectorAll(".starter-action-btn[data-starter-action='file'], .starter-action-btn[data-starter-action='web']")
    .forEach((button) => {
      setDisabled(button, true);
      button.classList.add("guest-auth-required");
      button.title = "Sign in to use this action";
    });
}

function ensureQuotaLockLabel() {
  const wrapper = document.querySelector(".input-field-wrapper");
  if (!wrapper) return null;
  let label = document.getElementById("guest-quota-lock-label");
  if (!label) {
    label = document.createElement("div");
    label.id = "guest-quota-lock-label";
    label.className = "guest-quota-lock-label";
    label.textContent = SIGN_IN_TO_CONTINUE;
    label.setAttribute("aria-hidden", "true");
    wrapper.appendChild(label);
  }
  return label;
}

function applyQuotaLock() {
  const locked = guestMode && guestQuotaState.exhausted;
  const input = document.getElementById("chat-input");
  const plus = document.getElementById("composer-plus-btn");
  const send = document.getElementById("send-btn");
  const live = document.getElementById("live-beta-btn");
  const area = document.querySelector(".chat-input-area");
  const label = ensureQuotaLockLabel();

  if (area) area.classList.toggle("guest-quota-exhausted", locked);
  if (label) {
    label.classList.toggle("visible", locked);
    label.setAttribute("aria-hidden", locked ? "false" : "true");
  }
  if (input) {
    if (locked) {
      setDisabled(input, true);
      input.placeholder = SIGN_IN_TO_CONTINUE;
      input.setAttribute("aria-label", SIGN_IN_TO_CONTINUE);
    } else if (input.getAttribute("aria-label") === SIGN_IN_TO_CONTINUE) {
      input.setAttribute("aria-label", "Message SentIQ Chat");
    }
  }
  if (locked) {
    setDisabled(plus, true);
    if (!send?.classList.contains("is-stop")) setDisabled(send, true);
    setDisabled(live, true);
  }
}

function applyGuestUi() {
  if (!guestMode) return;
  applyGuestWelcomeCopy();
  applyExecutionModePolicy();
  applyGuestToolPolicy();
  applyQuotaLock();
}

function scheduleApplyGuestUi() {
  if (!guestMode || applyScheduled) return;
  applyScheduled = true;
  queueMicrotask(() => {
    applyScheduled = false;
    applyGuestUi();
  });
}

function releaseGuestUi() {
  const subtitle = document.getElementById("welcome-subtitle");
  if (subtitle) {
    subtitle.hidden = false;
    subtitle.removeAttribute("aria-hidden");
  }
  document.getElementById("execution-mode-control")?.classList.remove("guest-fast-only");
  document.querySelector(".chat-input-area")?.classList.remove("guest-quota-exhausted");
  document.getElementById("guest-quota-lock-label")?.classList.remove("visible");
  document.querySelectorAll(".guest-auth-required").forEach((node) => {
    node.classList.remove("guest-auth-required");
    delete node.dataset.guestAuthRequired;
  });
}

function extractGuestQuota(payload) {
  const summary = payload?.summary || {};
  const quota = summary.guest_text_allowance || summary.text_allowance || null;
  if (!quota || typeof quota !== "object") return null;
  const limit = Number(quota.limit_tokens ?? quota.limit ?? GUEST_TEXT_LIMIT_TOKENS);
  const used = Number(quota.used_tokens ?? quota.tokens_consumed ?? quota.used ?? 0);
  const remaining = Number(quota.remaining_tokens ?? quota.tokens_remaining ?? quota.remaining ?? Math.max(0, limit - used));
  if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) return null;
  return {
    limit,
    used,
    remaining,
    exhausted: quota.exhausted === true || remaining <= 0,
    loaded: true,
  };
}

async function refreshGuestQuota() {
  if (!guestMode || !window.SentIQAPI?.getBillingMe) return guestQuotaState;
  if (quotaRefreshInFlight) return quotaRefreshInFlight;
  quotaRefreshInFlight = window.SentIQAPI.getBillingMe()
    .then((payload) => {
      const parsed = extractGuestQuota(payload);
      if (parsed) guestQuotaState = parsed;
      applyQuotaLock();
      return guestQuotaState;
    })
    .catch(() => guestQuotaState)
    .finally(() => {
      quotaRefreshInFlight = null;
    });
  return quotaRefreshInFlight;
}

function markQuotaExhaustedFromError(error) {
  if (!guestMode || !error) return false;
  const code = String(error.code || error.details?.code || "");
  const type = String(error.details?.type || "");
  const remaining = Number(error.details?.remaining_tokens ?? error.details?.remaining);
  const quotaFailure = code === "quota_exceeded"
    || code === "unified_text_quota_exhausted"
    || code === "guest_text_quota_exhausted"
    || type === "quota_exceeded";
  if (!quotaFailure) return false;
  guestQuotaState = {
    ...guestQuotaState,
    remaining: Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
    exhausted: true,
    loaded: true,
  };
  applyQuotaLock();
  return true;
}

function forceGuestContext(context = {}) {
  if (!guestMode) return context;
  return {
    ...context,
    executionMode: "fast",
    execution_mode: "fast",
    webSearchMode: null,
    web_search_mode: null,
    fileReferences: [],
    imageAttachments: [],
  };
}

function wrapApiForGuestPolicy() {
  if (apiWrapped || !window.SentIQAPI) return;
  const API = window.SentIQAPI;
  apiWrapped = true;

  const originalStream = API.sendMessageStream?.bind(API);
  if (originalStream) {
    API.sendMessageStream = async (message, context = {}, callbacks = {}, signal = null) => {
      if (!guestMode) return originalStream(message, context, callbacks, signal);
      if (guestQuotaState.exhausted) {
        const error = new Error(SIGN_IN_TO_CONTINUE);
        error.code = "guest_text_quota_exhausted";
        error.details = { code: error.code, type: "quota_exceeded", remaining_tokens: 0 };
        throw error;
      }

      const requestId = String(context.clientRequestId || context.client_request_id || createRequestId());
      upsertHandoffMessage({
        id: `guest-user-${requestId}`,
        role: "user",
        content: String(message || ""),
        timestamp: new Date().toISOString(),
        clientRequestId: requestId,
      }, `user:${requestId}`);

      let assistantText = "";
      const wrappedCallbacks = {
        ...callbacks,
        onToken(text) {
          assistantText += String(text || "");
          upsertHandoffMessage({
            id: `guest-assistant-${requestId}`,
            role: "assistant",
            content: assistantText,
            timestamp: new Date().toISOString(),
            clientRequestId: requestId,
            meta: { responseStatus: "generating" },
          }, `assistant:${requestId}`);
          callbacks.onToken?.(text);
        },
        onStructuredResponse(result) {
          const reply = getStructuredReply(result);
          if (reply) assistantText = reply;
          if (assistantText) {
            upsertHandoffMessage({
              id: `guest-assistant-${requestId}`,
              role: "assistant",
              content: assistantText,
              timestamp: new Date().toISOString(),
              clientRequestId: requestId,
              meta: { responseStatus: "complete" },
            }, `assistant:${requestId}`);
          }
          callbacks.onStructuredResponse?.(result);
        },
        onDone() {
          if (assistantText) {
            upsertHandoffMessage({
              id: `guest-assistant-${requestId}`,
              role: "assistant",
              content: assistantText,
              timestamp: new Date().toISOString(),
              clientRequestId: requestId,
              meta: { responseStatus: "complete" },
            }, `assistant:${requestId}`);
          }
          callbacks.onDone?.();
        },
        onError(error, details) {
          if (assistantText) {
            upsertHandoffMessage({
              id: `guest-assistant-${requestId}`,
              role: "assistant",
              content: assistantText,
              timestamp: new Date().toISOString(),
              clientRequestId: requestId,
              meta: { responseStatus: details?.interrupted ? "interrupted" : "error" },
            }, `assistant:${requestId}`);
          }
          markQuotaExhaustedFromError(error);
          callbacks.onError?.(error, details);
        },
      };

      try {
        const result = await originalStream(
          message,
          { ...forceGuestContext(context), clientRequestId: requestId },
          wrappedCallbacks,
          signal,
        );
        void refreshGuestQuota();
        return result;
      } catch (error) {
        markQuotaExhaustedFromError(error);
        void refreshGuestQuota();
        throw error;
      }
    };
  }

  const originalSend = API.sendMessage?.bind(API);
  if (originalSend) {
    API.sendMessage = async (message, context = {}) => {
      if (!guestMode) return originalSend(message, context);
      if (guestQuotaState.exhausted) {
        const error = new Error(SIGN_IN_TO_CONTINUE);
        error.code = "guest_text_quota_exhausted";
        error.details = { code: error.code, type: "quota_exceeded", remaining_tokens: 0 };
        throw error;
      }
      const requestId = String(context.clientRequestId || context.client_request_id || createRequestId());
      upsertHandoffMessage({
        id: `guest-user-${requestId}`,
        role: "user",
        content: String(message || ""),
        timestamp: new Date().toISOString(),
        clientRequestId: requestId,
      }, `user:${requestId}`);
      try {
        const result = await originalSend(message, { ...forceGuestContext(context), clientRequestId: requestId });
        const reply = getStructuredReply(result);
        if (reply) {
          upsertHandoffMessage({
            id: `guest-assistant-${requestId}`,
            role: "assistant",
            content: reply,
            timestamp: new Date().toISOString(),
            clientRequestId: requestId,
            meta: { responseStatus: "complete" },
          }, `assistant:${requestId}`);
        }
        void refreshGuestQuota();
        return result;
      } catch (error) {
        markQuotaExhaustedFromError(error);
        void refreshGuestQuota();
        throw error;
      }
    };
  }
}

function cleanMessagesForServer(messages) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.clientRequestId ? { clientRequestId: message.clientRequestId } : {}),
    ...(message.meta ? {
      meta: Object.fromEntries(Object.entries(message.meta).filter(([key]) => key !== "guestHandoffKey")),
    } : {}),
  }));
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/(["\\#.:[\]()])/g, "\\$1");
}

async function focusMigratedConversation(conversationId) {
  writeSession(GUEST_HANDOFF_TARGET_KEY, conversationId);
  try {
    await window.SentIQChat?.loadChatList?.(true);
  } catch {
    // The server-side conversation already exists. A later list refresh can recover it.
  }
  const item = document.querySelector(`.chat-list-item[data-id="${cssEscape(conversationId)}"]`);
  if (item instanceof HTMLElement) {
    item.click();
    removeSession(GUEST_HANDOFF_TARGET_KEY);
    return true;
  }
  return false;
}

async function migrateGuestConversationAfterSignIn() {
  if (guestMode || migrationInFlight || !window.SentIQAPI) return false;
  const state = loadHandoffState();
  const messages = cleanMessagesForServer(state.messages || []);
  if (messages.length === 0 || !messages.some((message) => message.role === "user")) return false;

  migrationInFlight = true;
  try {
    const createResult = await window.SentIQAPI.createConversation("New Chat");
    const conversation = createResult?.conversation || createResult;
    const conversationId = String(conversation?.id || "").trim();
    if (!conversationId) throw new Error("Guest chat migration could not create a conversation.");

    await window.SentIQAPI.syncChatMessages({
      conversationId,
      title: "New Chat",
      messages,
    });

    const { firstUser, firstAssistant } = getFirstExchange(messages);
    if (firstUser) {
      await window.SentIQAPI.generateTitle(firstUser, firstAssistant, conversationId);
    }

    clearGuestHandoff();
    removeSession(GUEST_RECOVERY_DRAFT_KEY);
    await focusMigratedConversation(conversationId);
    window.SentIQChat?.showToast?.("Your guest chat is saved. You can continue here.", "success", 3000);
    return true;
  } catch (error) {
    // Profile-name capture can legitimately block workspace writes immediately
    // after sign-up. Keep the transcript intact and retry when the gate closes.
    const code = String(error?.code || error?.details?.code || "");
    if (code !== "profile_name_required") {
      window.SentIQChat?.debugWarn?.("[Guest handoff] Migration deferred:", error);
    }
    return false;
  } finally {
    migrationInFlight = false;
  }
}

function retryPendingHandoffTarget() {
  if (guestMode) return;
  const conversationId = readSession(GUEST_HANDOFF_TARGET_KEY);
  if (conversationId) void focusMigratedConversation(conversationId);
}

function handleAuthState(session) {
  const nextGuestMode = !session;
  const changed = guestMode !== nextGuestMode;
  guestMode = nextGuestMode;
  if (guestMode) {
    guestQuotaState = {
      limit: GUEST_TEXT_LIMIT_TOKENS,
      used: 0,
      remaining: GUEST_TEXT_LIMIT_TOKENS,
      exhausted: false,
      loaded: false,
    };
    scheduleApplyGuestUi();
    void refreshGuestQuota();
    return;
  }

  releaseGuestUi();
  if (changed || readSession(GUEST_HANDOFF_KEY)) {
    window.setTimeout(() => void migrateGuestConversationAfterSignIn(), 250);
  }
  window.setTimeout(retryPendingHandoffTarget, 500);
}

function installGuestInteractionGuards() {
  document.addEventListener("click", (event) => {
    if (!guestMode) return;
    const target = event.target instanceof Element ? event.target : null;
    const gated = target?.closest?.(
      "#file-attach-btn, #websurf-basic-btn, #image-gen-btn, #deep-research-btn, " +
      ".starter-action-btn[data-starter-action='file'], .starter-action-btn[data-starter-action='web']",
    );
    if (!gated) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("drop", (event) => {
    if (!guestMode || !event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.getElementById("new-chat-btn")?.addEventListener("click", () => {
    if (!guestMode) return;
    clearGuestHandoff();
  }, true);
}

function installStyles() {
  if (document.getElementById("guest-experience-styles")) return;
  const style = document.createElement("style");
  style.id = "guest-experience-styles";
  style.textContent = `
    .execution-mode-control.guest-fast-only .execution-mode-toggle {
      cursor: default;
      opacity: 0.72;
    }
    .execution-mode-control.guest-fast-only .execution-mode-toggle svg {
      display: none;
    }
    .composer-action-option.guest-auth-required,
    .starter-action-btn.guest-auth-required {
      opacity: 0.42 !important;
      filter: grayscale(0.28);
      cursor: not-allowed !important;
      transform: none !important;
    }
    .composer-action-option.guest-auth-required:hover,
    .starter-action-btn.guest-auth-required:hover {
      background: transparent !important;
      border-color: transparent !important;
      transform: none !important;
    }
    .guest-quota-lock-label {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      padding: 0 2px;
      color: var(--text-secondary);
      font-size: 0.92rem;
      pointer-events: none;
      z-index: 2;
    }
    .guest-quota-lock-label.visible {
      display: flex;
    }
    .chat-input-area.guest-quota-exhausted {
      border-color: rgba(255, 255, 255, 0.09);
      background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.022));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.035);
    }
    .chat-input-area.guest-quota-exhausted #chat-input {
      color: transparent !important;
      -webkit-text-fill-color: transparent !important;
    }
    .chat-input-area.guest-quota-exhausted #composer-hint-overlay {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function installMutationGuard() {
  const root = document.querySelector(".main-content");
  if (!root || mutationObserver) return;
  mutationObserver = new MutationObserver(() => scheduleApplyGuestUi());
  mutationObserver.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled", "aria-hidden", "style", "class"],
  });
}

function initializeGuestExperience() {
  installStyles();
  wrapApiForGuestPolicy();
  installGuestInteractionGuards();
  installMutationGuard();
  applyGuestUi();

  document.addEventListener("sentiq-auth-changed", (event) => {
    handleAuthState(event.detail?.session || null);
  });
  window.addEventListener("sentiq-billing-refresh", () => {
    if (guestMode) void refreshGuestQuota();
  });

  const nameModal = document.getElementById("name-modal");
  if (nameModal) {
    new MutationObserver(() => {
      if (!guestMode && nameModal.style.display === "none") {
        window.setTimeout(() => void migrateGuestConversationAfterSignIn(), 100);
      }
    }).observe(nameModal, { attributes: true, attributeFilter: ["style", "aria-hidden"] });
  }

  Promise.resolve(window.SentIQAuth?.getSession?.())
    .then((session) => handleAuthState(session || null))
    .catch(() => handleAuthState(null));
}

// The HTML shell exists before the main module executes, so applying the copy
// immediately avoids a visible guest-home text swap on normal loads.
installStyles();
applyGuestUi();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeGuestExperience, { once: true });
} else {
  queueMicrotask(initializeGuestExperience);
}

window.SentIQGuestExperience = {
  refreshQuota: refreshGuestQuota,
  migratePendingChat: migrateGuestConversationAfterSignIn,
  getQuotaState: () => ({ ...guestQuotaState }),
  isGuest: () => guestMode,
};
