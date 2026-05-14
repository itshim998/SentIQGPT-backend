import {
  COMPOSER_HINTS,
  DEFAULT_IMAGE_ANALYSIS_PROMPT,
  MAX_SELECTION_CONTEXT_LINES,
  MAX_SELECTION_LINES,
  MEMORY_SYNC_STALE_MS,
  SELECTION_BUTTON_ID,
  SYNC_JOB_TYPES,
  WELCOME_GREETINGS,
  WELCOME_GREETING_STORAGE_PREFIX,
} from "./chat/constants.js";
import { getChatDomRefs } from "./chat/dom-refs.js";
import {
  buildGuestFileGenerationInstruction,
  detectClarificationDownloadFormat,
  detectLoaderKindForPrompt,
  detectRequestedFileFormat,
  isChartRequest,
  isImageRequest,
  isLikelyBufferedReasoningPrompt,
  isLikelyFileGenerationRequest,
} from "./chat/intent-detection.js";
import {
  MAX_CLIENT_UPLOAD_BYTES,
  SUPPORTED_UPLOAD_EXTENSIONS,
  SUPPORTED_UPLOAD_MIME_PREFIXES,
  SUPPORTED_UPLOAD_MIME_TYPES,
} from "./chat/upload-config.js";

// ================================================================
// 3. Chat UI Controller
// ================================================================
(function () {
  const Storage = window.SentIQStorage;
  const API = window.SentIQAPI;

  let currentChatId = null;
  let imageMode = false;
  let pendingFiles = [];
  let composerDragDepth = 0;
  let currentSessionFile = null; // Tracks the most recently uploaded file for priority context
  let currentSessionImageAttachments = []; // Tracks recent image inputs for follow-up questions
  const pendingClarifications = new Map();
  let selectionButton = null;
  let pendingSelectionPayload = null;
  let webSearchModeOverride = null;
  const externalScriptPromises = new Map();

  // ---- Per-chat state isolation ----
  // Each chat maintains its own state so switching chats doesn't bleed UI.
  const chatStates = new Map(); // chatId → { isThinking, currentResponse, requestId, responseBuffer, thinkingSteps, abortController, activityMode, activityLoaderKind }

  function getChatState(chatId) {
    if (!chatId) return null;
    if (!chatStates.has(chatId)) {
      chatStates.set(chatId, {
        isThinking: false,
        currentResponse: "",
        requestId: null,
        responseBuffer: "",
        thinkingSteps: [],
        abortController: null,
        activityMode: "thinking",
        activityLoaderKind: "loader-text",
      });
    }
    return chatStates.get(chatId);
  }

  function newRequestId(chatId) {
    const id = crypto.randomUUID();
    const state = getChatState(chatId);
    if (state) state.requestId = id;
    return id;
  }

  function isRequestStale(chatId, requestId) {
    const state = getChatState(chatId);
    return !state || state.requestId !== requestId;
  }

  // DOM references
  const {
    chatMessages,
    chatInput,
    sendBtn,
    newChatBtn,
    chatList,
    chatSearchInput,
    typingIndicator,
    welcomeScreen,
    welcomeHeading,
    welcomeSubtitle,
    starterActions,
    fileInput,
    composerPlusBtn,
    composerActionMenu,
    composerHintOverlay,
    composerHintText,
    fileAttachBtn,
    imageGenBtn,
    webSurfBasicBtn,
    voiceBtn,
    imageModeBar,
    cancelImageMode,
    webSearchModeBar,
    webSearchModeLabel,
    cancelWebSearchMode,
    filePreviewArea,
    chatInputArea,
    settingsBtn,
    settingsModal,
    closeSettingsBtn,
    sidebarToggle,
    sidebar,
    scrollAnchorPill,
    toastContainer,
    typingTextEl,
    appContainer,
    authActions,
    authLoginBtn,
    authSignupBtn,
    authLogoutBtn,
    authUserChip,
    authUserEmail,
    authMenuToggle,
    authMenuPanel,
    authMenuName,
    authMenuEmail,
    authMenuLogoutBtn,
    authModal,
    authCloseBtn,
    authForm,
    authEmailInput,
    authPasswordInput,
    authPasswordToggle,
    authPasswordEye,
    authModalTitle,
    authModalHeading,
    authModalSubtitle,
    authSubmitBtn,
    authSwitchLabel,
    authSwitchBtn,
    authForgotRow,
    authForgotBtn,
    authStatus,
    authGateMessage,
    authWelcomeNote,
    nameModal,
    nameForm,
    nameInput,
    nameStatus,
    nameSubmitBtn,
    nameLogoutBtn,
  } = getChatDomRefs();

  let authView = "login";
  let authSessionState = null;
  let authProfileState = {
    displayName: null,
    requiresName: false,
    fetchFailed: false,
    loaded: false,
    userId: "",
  };
  let profileRefreshPromise = null;
  let profileRefreshUserId = "";
  let profileNameGatePromise = null;
  let composerHintTimer = 0;
  let composerHintIndex = 0;
  let composerHintCycleId = 0;
  let greetingUserScope = "";
  let pendingChatListLoad = null;
  let sidebarBackdrop = null;
  let sidebarTouchSession = null;
  let authMenuOpen = false;
  let syncQueuePromise = null;
  let memorySyncPromise = null;
  let memoryLastSyncedAt = 0;
  const chatRenderSignatures = new Map();
  const pendingChatCreatePromises = new Map();
  const welcomeGreetingByChatId = new Map();
  let guestChatState = null;
  let guestMemoryState = [];
  const SENTIQ_DEBUG = (() => {
    try {
      return Boolean(window.SENTIQ_DEBUG || localStorage.getItem("sentiq_debug") === "1");
    } catch {
      return Boolean(window.SENTIQ_DEBUG);
    }
  })();

  function debugLog(...args) {
    if (SENTIQ_DEBUG) console.log(...args);
  }

  function debugWarn(...args) {
    if (SENTIQ_DEBUG) console.warn(...args);
  }

  function getSafeErrorMessage(error) {
    if (!error) return "Unknown error";
    if (error instanceof Error) return error.message || error.name || "Error";
    if (typeof error === "string") return error;
    if (typeof error?.message === "string") return error.message;
    return "Unexpected error";
  }

  function markPerf(label, extra = {}) {
    if (!SENTIQ_DEBUG) return;
    const details = Object.entries(extra)
      .filter(([, value]) => value !== null && typeof value !== "undefined" && value !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    console.log(`[Perf] ${label}${details ? ` ${details}` : ""}`);
  }

  function startPerf(label, extra = {}) {
    const startedAt = performance.now();
    markPerf(`${label}.start`, extra);
    return (status = "ok", more = {}) => {
      const durationMs = Math.round(performance.now() - startedAt);
      markPerf(`${label}.${status}`, { ...extra, duration_ms: durationMs, ...more });
      return durationMs;
    };
  }

  function isPasswordResetRequestView(mode = authView) {
    return mode === "forgot-password-request";
  }

  function isPasswordRecoveryView(mode = authView) {
    return mode === "password-recovery";
  }

  function isPasswordAuthView(mode = authView) {
    return mode === "login" || mode === "signup" || mode === "password-recovery";
  }

  function getAuthPrimaryFocus(mode = authView) {
    return isPasswordRecoveryView(mode) ? authPasswordInput : authEmailInput;
  }

  function isMobileSidebarViewport() {
    return window.matchMedia?.("(max-width: 768px)")?.matches ?? (window.innerWidth <= 768);
  }

  function isModalVisible(modal) {
    return Boolean(modal && modal.style.display !== "none");
  }

  const MODAL_FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function getActiveModal() {
    if (isModalVisible(nameModal)) return nameModal;
    if (isModalVisible(authModal)) return authModal;
    if (isModalVisible(settingsModal)) return settingsModal;
    return null;
  }

  function trapFocusInModal(event) {
    if (event.key !== "Tab") return false;
    const activeModal = getActiveModal();
    if (!activeModal) return false;
    const focusable = Array.from(activeModal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return false;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return true;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
      return true;
    }
    return false;
  }

  function ensureSidebarBackdrop() {
    if (!sidebarBackdrop) {
      sidebarBackdrop = document.createElement("button");
      sidebarBackdrop.type = "button";
      sidebarBackdrop.className = "sidebar-backdrop";
      sidebarBackdrop.setAttribute("aria-label", "Close sidebar");
      sidebarBackdrop.addEventListener("click", () => closeSidebar());
    }
    if (appContainer && sidebarBackdrop.parentElement !== appContainer) {
      appContainer.appendChild(sidebarBackdrop);
    }
    return sidebarBackdrop;
  }

  function updateOverlayLocks() {
    const sidebarOpen = Boolean(sidebar && sidebar.classList.contains("open") && isMobileSidebarViewport());
    const modalOpen = isModalVisible(authModal) || isModalVisible(nameModal) || isModalVisible(settingsModal);
    const backdrop = ensureSidebarBackdrop();
    backdrop.classList.toggle("visible", sidebarOpen);
    document.body.classList.toggle("body-sidebar-open", sidebarOpen);
    document.body.classList.toggle("body-modal-open", modalOpen);
    syncAuthBlurState();
  }

  function isMobileAuthMenuViewport() {
    return window.matchMedia?.("(max-width: 768px)")?.matches ?? (window.innerWidth <= 768);
  }

  function syncActiveChatItem() {
    if (!chatList) return;
    chatList.querySelectorAll(".chat-list-item").forEach((item) => {
      item.classList.toggle("active", item.getAttribute("data-id") === currentChatId);
    });
  }

  function getChatMessageSignature(chat) {
    const messages = collapseAdjacentDuplicateChatMessages(Array.isArray(chat?.messages) ? chat.messages : []);
    const count = messages.length;
    if (count === 0) return "0";
    const first = messages[0] || {};
    const last = messages[count - 1] || {};
    const firstRole = first.role || "";
    const lastRole = last.role || "";
    const firstText = String(first.content || "").slice(0, 64);
    const lastText = String(last.content || "").slice(0, 96);
    const lastMetaType = last.meta?.type || "";
    return `${count}|${firstRole}|${lastRole}|${firstText}|${lastText}|${lastMetaType}`;
  }

  function shouldApplyChatTransition(meta = {}) {
    if (!chatMessages) return false;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return false;
    return Boolean(meta.switchedChats || meta.contentChanged);
  }

  function closeAuthMenu() {
    authMenuOpen = false;
    if (authMenuToggle) {
      authMenuToggle.dataset.open = "false";
      authMenuToggle.setAttribute("aria-expanded", "false");
    }
    authMenuPanel?.classList.remove("visible");
  }

  function openAuthMenu() {
    if (!authSessionState || !isMobileAuthMenuViewport()) return;
    authMenuOpen = true;
    if (authMenuToggle) {
      authMenuToggle.dataset.open = "true";
      authMenuToggle.setAttribute("aria-expanded", "true");
    }
    authMenuPanel?.classList.add("visible");
  }

  function toggleAuthMenu() {
    if (authMenuOpen) closeAuthMenu();
    else openAuthMenu();
  }

  function openSidebar() {
    if (!sidebar || !isMobileSidebarViewport()) return;
    closeAuthMenu();
    sidebar.classList.add("open");
    sidebarToggle?.setAttribute("aria-expanded", "true");
    updateOverlayLocks();
  }

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove("open");
    sidebarToggle?.setAttribute("aria-expanded", "false");
    updateOverlayLocks();
  }

  function toggleSidebar() {
    if (!sidebar || !isMobileSidebarViewport()) return;
    if (sidebar.classList.contains("open")) closeSidebar();
    else openSidebar();
  }

  function shouldIgnoreSidebarGestureStart(target) {
    return Boolean(
      target?.closest?.(
        "input, textarea, select, button, a, [contenteditable='true'], .modal-container, .code-block-wrap, .message-image-container, .generated-file-panel"
      )
    );
  }

  function initMobileSidebarGestures() {
    if (!window.addEventListener) return;
    window.addEventListener("touchstart", (event) => {
      if (!isMobileSidebarViewport() || isModalVisible(authModal) || isModalVisible(nameModal) || isModalVisible(settingsModal)) return;
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const target = event.target;
      const sidebarOpen = Boolean(sidebar?.classList.contains("open"));
      const startedInSidebar = Boolean(sidebar && target instanceof Node && sidebar.contains(target));
      const startedNearEdge = touch.clientX <= 28;

      if (shouldIgnoreSidebarGestureStart(target)) return;
      if ((!sidebarOpen && !startedNearEdge) || (sidebarOpen && !startedInSidebar)) return;

      sidebarTouchSession = {
        startX: touch.clientX,
        currentX: touch.clientX,
        startY: touch.clientY,
        openAtStart: sidebarOpen,
        cancelled: false,
      };
    }, { passive: true });

    window.addEventListener("touchmove", (event) => {
      if (!sidebarTouchSession || event.touches.length !== 1) return;
      const touch = event.touches[0];
      sidebarTouchSession.currentX = touch.clientX;
      const deltaX = touch.clientX - sidebarTouchSession.startX;
      const deltaY = Math.abs(touch.clientY - sidebarTouchSession.startY);
      if (deltaY > 24 && deltaY > Math.abs(deltaX)) {
        sidebarTouchSession.cancelled = true;
      }
    }, { passive: true });

    window.addEventListener("touchend", () => {
      if (!sidebarTouchSession) return;
      const session = sidebarTouchSession;
      sidebarTouchSession = null;
      if (session.cancelled) return;
      const deltaX = session.currentX - session.startX;
      if (!session.openAtStart && deltaX >= 56) openSidebar();
      if (session.openAtStart && deltaX <= -56) closeSidebar();
    }, { passive: true });
  }

  function isAuthenticatedSession() {
    return Boolean(authSessionState);
  }

  function isGuestSession() {
    return !isAuthenticatedSession();
  }

  function createGuestChatState(title = "New Chat", id = null) {
    return {
      id: id || `guest-${Storage.generateId()}`,
      title: title || "New Chat",
      messages: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "guest",
    };
  }

  function ensureGuestChatState(chatId) {
    if (!guestChatState) {
      guestChatState = createGuestChatState("New Chat", chatId || null);
    }
    return guestChatState;
  }

  function resetGuestChatState() {
    guestChatState = createGuestChatState("New Chat");
    guestMemoryState = [];
    return guestChatState;
  }

  function getGuestChat(chatId) {
    if (!guestChatState) return null;
    if (!chatId) return guestChatState;
    return guestChatState.id === chatId ? guestChatState : null;
  }

  function addGuestMessage(chatId, role, content, meta) {
    const chat = ensureGuestChatState(chatId);
    if (!chat || (chatId && chat.id !== chatId)) return chat;
    const msg = { id: Storage.generateId(), role, content, timestamp: new Date().toISOString() };
    if (meta) msg.meta = meta;
    chat.messages.push(msg);
    chat.updated = msg.timestamp;
    if (!chat.title || chat.title === "New Chat") {
      const firstUser = chat.messages.find((m) => m.role === "user");
      if (firstUser?.content) {
        chat.title = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
      }
    }
    return chat;
  }

  async function persistChatMessage(chatId, role, content, meta) {
    if (isAuthenticatedSession()) {
      return Storage.addMessageToChat(chatId, role, content, meta);
    }
    return addGuestMessage(chatId, role, content, meta);
  }

  function storeGuestMemory(memory) {
    if (!memory?.summary) return null;
    const memoryId = memory.id || `guest-mem-${Storage.generateId()}`;
    const normalized = {
      ...memory,
      id: memoryId,
      importance: typeof memory.importance === "number" ? memory.importance : 5,
      scope: normalizeMemoryScope(memory),
      timestamp: memory.timestamp || new Date().toISOString(),
    };
    const existingIndex = guestMemoryState.findIndex((item) => item.id === memoryId);
    if (existingIndex >= 0) guestMemoryState[existingIndex] = normalized;
    else guestMemoryState.push(normalized);
    return normalized;
  }

  function getGuestTopMemories(limit, chatId = null) {
    return guestMemoryState
      .filter((memory) => {
        const scope = normalizeMemoryScope(memory);
        return scope === "global" || (scope === "chat" && !!chatId && memory.chat_id === chatId);
      })
      .sort((a, b) => b.importance - a.importance || new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit || 20);
  }

  async function storeMemoryForContext(scopedMemory) {
    if (!scopedMemory) return null;
    if (isAuthenticatedSession()) {
      return Storage.storeMemory(scopedMemory);
    }
    return storeGuestMemory(scopedMemory);
  }


  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  }

  function getActiveAuthUserId() {
    return authSessionState?.user?.id || authSessionState?.user?.sub || "";
  }

  function normalizeDisplayName(value) {
    if (typeof value !== "string") return null;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > 80) return null;
    return normalized;
  }

  function isNameCaptureRequired() {
    return Boolean(isAuthenticatedSession() && authProfileState.requiresName && !authProfileState.fetchFailed);
  }

  function getPreferredAccountLabel() {
    if (authProfileState.displayName) return authProfileState.displayName;
    if (isNameCaptureRequired()) return "Add your name";
    return authSessionState?.user?.email || "";
  }

  function getGreetingName() {
    const displayName = authProfileState.displayName;
    if (!displayName) return "";
    return displayName.split(/\s+/)[0] || displayName;
  }

  function syncAuthBlurState() {
    if (!appContainer) return;
    appContainer.classList.toggle("auth-blurred", isModalVisible(authModal) || isModalVisible(nameModal));
  }

  function setNameStatus(message = "", type = "") {
    if (!nameStatus) return;
    nameStatus.textContent = message;
    nameStatus.classList.toggle("is-error", type === "error");
    nameStatus.classList.toggle("is-success", type === "success");
  }

  function openRequiredNameModal() {
    if (!nameModal) return;
    if (nameInput && !nameInput.value) {
      nameInput.value = authProfileState.displayName || "";
    }
    closeAuthMenu();
    closeSidebar();
    closeComposerMenu();
    nameModal.style.display = "flex";
    nameModal.setAttribute("aria-hidden", "false");
    syncAuthBlurState();
    updateOverlayLocks();
    requestAnimationFrame(() => nameInput?.focus());
  }

  function closeRequiredNameModal() {
    if (nameModal) {
      nameModal.style.display = "none";
      nameModal.setAttribute("aria-hidden", "true");
    }
    if (nameForm) nameForm.reset();
    setNameStatus("");
    syncAuthBlurState();
    updateOverlayLocks();
  }

  function resetAuthProfileState() {
    authProfileState = {
      displayName: null,
      requiresName: false,
      fetchFailed: false,
      loaded: false,
      userId: "",
    };
    profileRefreshPromise = null;
    profileRefreshUserId = "";
    greetingUserScope = "";
    welcomeGreetingByChatId.clear();
    closeRequiredNameModal();
  }

  function isProfileNameRequiredError(error) {
    return Boolean(
      error && (
        error.code === "profile_name_required" ||
        error.requiresName === true ||
        error.requires_name === true
      )
    );
  }

  async function handleProfileNameRequired(source = "api") {
    if (!isAuthenticatedSession()) return;
    if (profileNameGatePromise) return profileNameGatePromise;
    profileNameGatePromise = (async () => {
      stopFileAnalysisUpdates();
      pendingChatListLoad = null;
      syncQueuePromise = null;
      memorySyncPromise = null;
      pendingChatCreatePromises.clear();
      authProfileState = {
        ...authProfileState,
        requiresName: true,
        fetchFailed: false,
        loaded: true,
        userId: getActiveAuthUserId(),
      };
      hideActivityIndicator(currentChatId);
      setSendMode();
      setChatAccess(true);
      openRequiredNameModal();
      try {
        await refreshProfileState({ force: true, silent: true });
      } catch (error) {
      debugWarn(`[UI] profile refresh after ${source} gate failed:`, getSafeErrorMessage(error));
        authProfileState = {
          ...authProfileState,
          requiresName: true,
          fetchFailed: false,
          loaded: true,
          userId: getActiveAuthUserId(),
        };
        openRequiredNameModal();
        setChatAccess(true);
      }
      await syncConversationStateForAuth(true);
      setChatAccess(true);
    })().finally(() => {
      profileNameGatePromise = null;
    });
    return profileNameGatePromise;
  }

  async function maybeHandleProfileNameRequiredError(error, source = "api") {
    if (!isProfileNameRequiredError(error)) return false;
    await handleProfileNameRequired(source);
    return true;
  }

  function getGreetingStorageKey() {
    const scope = getActiveAuthUserId() || "guest";
    return `${WELCOME_GREETING_STORAGE_PREFIX}${scope}`;
  }

  function readGreetingIndex() {
    try {
      const raw = localStorage.getItem(getGreetingStorageKey());
      const parsed = Number.parseInt(raw || "0", 10);
      if (!Number.isFinite(parsed) || parsed < 0) return 0;
      return parsed % WELCOME_GREETINGS.length;
    } catch {
      return 0;
    }
  }

  function writeGreetingIndex(index) {
    try {
      localStorage.setItem(getGreetingStorageKey(), String(index % WELCOME_GREETINGS.length));
    } catch { /* ignore storage failures */ }
  }

  function refreshWelcomeCopy() {
    if (!welcomeHeading || !welcomeSubtitle) return;
    const scope = getActiveAuthUserId() || "guest";
    if (scope !== greetingUserScope) {
      greetingUserScope = scope;
      welcomeGreetingByChatId.clear();
    }

    let greetingIndex = readGreetingIndex();
    if (currentChatId) {
      if (!welcomeGreetingByChatId.has(currentChatId)) {
        welcomeGreetingByChatId.set(currentChatId, greetingIndex);
        writeGreetingIndex((greetingIndex + 1) % WELCOME_GREETINGS.length);
      }
      greetingIndex = welcomeGreetingByChatId.get(currentChatId) ?? greetingIndex;
    }

    const greetingTemplate = WELCOME_GREETINGS[greetingIndex] || WELCOME_GREETINGS[0];
    const suffix = getGreetingName() ? `, ${getGreetingName()}` : "";
    welcomeHeading.textContent = greetingTemplate.replace("{suffix}", suffix);
    welcomeSubtitle.textContent = authProfileState.displayName
      ? "Ask a question, inspect a file, or keep a conversation moving."
      : "Ask a question, work through a file, or pick up a thread from earlier.";
  }

  function clearComposerHintTimer() {
    clearTimeout(composerHintTimer);
    composerHintTimer = 0;
  }

  function cancelComposerHintAnimation() {
    clearComposerHintTimer();
    composerHintCycleId += 1;
  }

  function getBaseComposerPlaceholder() {
    if (isNameCaptureRequired()) return "Add your name to continue...";
    if (getPendingClarification()) return "Enter your custom answer...";
    if (imageMode) return "Describe the image you want to generate...";
    if (webSearchModeOverride) return "Ask about something current on the web...";
    return "";
  }

  function shouldShowComposerHint() {
    return Boolean(
      composerHintOverlay
      && composerHintText
      && chatInput
      && !chatInput.disabled
      && !chatInput.value.trim()
      && pendingFiles.length === 0
      && !getPendingClarification()
      && !imageMode
      && !webSearchModeOverride
      && !isNameCaptureRequired()
    );
  }

  function syncComposerHint() {
    if (chatInput) {
      chatInput.placeholder = getBaseComposerPlaceholder();
    }
    if (!composerHintOverlay || !composerHintText) return;

    if (!shouldShowComposerHint()) {
      cancelComposerHintAnimation();
      composerHintText.textContent = "";
      composerHintOverlay.classList.remove("visible");
      return;
    }

    composerHintOverlay.classList.add("visible");
    if (prefersReducedMotion()) {
      clearComposerHintTimer();
      composerHintText.textContent = COMPOSER_HINTS[composerHintIndex % COMPOSER_HINTS.length];
      return;
    }

    cancelComposerHintAnimation();
    const runId = composerHintCycleId;
    let hintIndex = composerHintIndex % COMPOSER_HINTS.length;
    let charIndex = 0;
    let deleting = false;

    const step = () => {
      if (runId !== composerHintCycleId) return;
      if (!shouldShowComposerHint()) {
        composerHintText.textContent = "";
        composerHintOverlay.classList.remove("visible");
        return;
      }

      const hint = COMPOSER_HINTS[hintIndex];
      if (!deleting) {
        charIndex = Math.min(charIndex + 1, hint.length);
        composerHintText.textContent = hint.slice(0, charIndex);
        if (charIndex < hint.length) {
          composerHintTimer = window.setTimeout(step, 52);
          return;
        }
        deleting = true;
        composerHintTimer = window.setTimeout(step, 1200);
        return;
      }

      charIndex = Math.max(charIndex - 1, 0);
      composerHintText.textContent = hint.slice(0, charIndex);
      if (charIndex > 0) {
        composerHintTimer = window.setTimeout(step, 28);
        return;
      }

      hintIndex = (hintIndex + 1) % COMPOSER_HINTS.length;
      composerHintIndex = hintIndex;
      deleting = false;
      composerHintTimer = window.setTimeout(step, 220);
    };

    step();
  }

  function ensureNameCapture(message = "Add your name to continue.") {
    if (!isNameCaptureRequired()) return false;
    openRequiredNameModal();
    showToast(message, "info", 2600);
    return true;
  }

  function setComposerDraft(value) {
    if (!chatInput) return;
    chatInput.value = value;
    autoResizeInput();
    syncComposerHint();
    chatInput.focus();
    chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
  }

  function handleStarterAction(action) {
    if (ensureNameCapture()) return;
    closeComposerMenu();

    if (action === "file") {
      fileInput?.click();
      return;
    }

    if (action === "web") {
      setWebSearchModeOverride("basic");
      setComposerDraft("Research the latest reliable information about ");
      return;
    }

    if (action === "math") {
      setComposerDraft("Solve this step by step: ");
      return;
    }

    if (action === "code") {
      setComposerDraft("Debug this code and explain the fix:\n\n");
    }
  }

  let fileUpdatesPromise = null;
  let fileUpdatesAbort = null;
  const pendingFileUploadUi = new Map();
  const fileAnalysisUi = new Map();
  const pendingFileAnalysisEvents = new Map();

  function attachFileAnalysisStatus(contentDiv, status, label) {
    if (!contentDiv) return null;
    const statusEl = document.createElement("div");
    statusEl.className = `file-analysis-status ${status}`;
    const dot = document.createElement("span");
    dot.className = "file-analysis-dot";
    const text = document.createElement("span");
    text.className = "file-analysis-text";
    text.textContent = label;
    statusEl.appendChild(dot);
    statusEl.appendChild(text);
    contentDiv.appendChild(statusEl);
    return { statusEl, textEl: text };
  }

  function setFileAnalysisStatus(entry, status, label) {
    if (!entry?.statusEl || !entry?.textEl) return;
    entry.statusEl.className = `file-analysis-status ${status}`;
    entry.textEl.textContent = label;
  }

  function applyFileAnalysisEvent(event) {
    const entry = fileAnalysisUi.get(event.analysis_id);
    if (!entry) return false;
    const status = event.status || "processing";
    const label = status === "complete"
      ? "Analysis ready"
      : status === "error"
        ? "Analysis failed"
        : "Analyzing file...";
    setFileAnalysisStatus(entry, status, label);
    if (status === "complete" && event.extracted_text) {
      if (currentSessionFile?.analysis_id === event.analysis_id) {
        currentSessionFile = {
          ...currentSessionFile,
          extracted_text: event.extracted_text,
          size_bytes: event.size_bytes || currentSessionFile.size_bytes,
          type: event.file_type || currentSessionFile.type,
          updated_at: new Date().toISOString(),
        };
        showToast("File analysis ready.", "success", 2500);
      }
    }
    if (status === "error" && event.error) {
      showToast(`File analysis failed: ${event.error}`, "error", 3500);
    }
    return true;
  }

  function handleFileAnalysisEvent(event) {
    if (!event || event.type !== "file_analysis") return;
    if (!applyFileAnalysisEvent(event)) {
      pendingFileAnalysisEvents.set(event.analysis_id, event);
    }
  }

  function startFileAnalysisUpdates() {
    if (fileUpdatesPromise || !isAuthenticatedSession()) return;
    const controller = new AbortController();
    fileUpdatesAbort = controller;
    fileUpdatesPromise = API.subscribeFileUpdates({
      onEvent: handleFileAnalysisEvent,
      onClose: () => {
        fileUpdatesPromise = null;
        fileUpdatesAbort = null;
      },
    }, controller.signal).catch((err) => {
      if (err?.name !== "AbortError" && !isProfileNameRequiredError(err)) {
        debugWarn("[UI] File update stream closed:", getSafeErrorMessage(err));
      }
    }).finally(() => {
      fileUpdatesPromise = null;
      fileUpdatesAbort = null;
    });
  }

  function stopFileAnalysisUpdates() {
    if (fileUpdatesAbort) {
      fileUpdatesAbort.abort();
    }
    fileUpdatesAbort = null;
    fileUpdatesPromise = null;
  }

  function normalizeServerConversation(chat) {
    const lastActivity = chat.last_activity_at || chat.lastActivityAt || chat.updated || chat.updated_at || chat.created_at;
    return {
      id: chat.id,
      title: chat.title || "New Chat",
      created: chat.created || chat.created_at || new Date().toISOString(),
      updated: lastActivity || new Date().toISOString(),
      source: "server",
      pending_server_sync: Boolean(chat.pending_server_sync),
      last_synced_at: chat.last_synced_at || new Date().toISOString(),
      pending_title_sync: Boolean(chat.pending_title_sync),
      title_sync_error: chat.title_sync_error || null,
      last_title_synced_at: chat.last_title_synced_at || new Date().toISOString(),
    };
  }

  function normalizeServerMessage(message) {
    const messageType = message.message_type || message.messageType || "";
    const imageUrl = message.image_url || message.imageUrl || "";
    const storagePath = message.storage_path || message.storagePath || "";
    let meta = message.meta;
    if (!meta && messageType === "image" && imageUrl) {
      meta = {
        type: "image",
        imageUrl,
        prompt: message.prompt || "",
        provider: message.provider || "",
        storagePath: storagePath || "",
        fileSizeBytes: message.file_size_bytes || message.fileSizeBytes || null,
      };
    }
    if (!meta && messageType === "file") {
      meta = normalizeGeneratedFileMeta({
        id: message.file_id || message.fileId || message.id,
        file_id: message.generated_file_id || message.generatedFileId || message.file_id || message.fileId,
        format: message.file_format || message.fileFormat,
        file_name: message.file_name || message.fileName,
        mime_type: message.mime_type || message.mimeType,
        file_url: message.file_url || message.fileUrl,
        storage_path: storagePath,
        file_size_bytes: message.file_size_bytes || message.fileSizeBytes,
        preview: message.preview_json || message.previewJson,
        model_used: message.provider || "",
      }, { chatId: message.conversation_id || message.conversationId || null });
    }
    return {
      id: message.id,
      role: message.role,
      content: message.content || "",
      timestamp: message.timestamp || message.created_at || new Date().toISOString(),
      meta,
    };
  }

  function normalizeServerMemory(memory) {
    return {
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      importance: memory.importance || 5,
      timestamp: memory.timestamp || memory.created_at || new Date().toISOString(),
      scope: memory.scope === "chat" ? "chat" : "global",
      chat_id: typeof memory.chat_id === "string" && memory.chat_id.trim() ? memory.chat_id.trim() : null,
      embedding: Array.isArray(memory.embedding) ? memory.embedding : undefined,
      persisted: true,
      source_conversation_id: memory.source_conversation_id || memory.chat_id || null,
      source: "server",
      pending_server_sync: false,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
    };
  }

  function isServerBackedChat(chat) {
    return Boolean(chat && chat.source === "server");
  }

  async function getCachedServerChats() {
    const chats = await Storage.getAllChats();
    return chats.filter((chat) => isServerBackedChat(chat));
  }

  function logAuthenticatedConversationError(scope, error) {
    const message = getSafeErrorMessage(error);
    debugWarn(`[UI] ${scope} failed: ${message}`);
  }

  async function cacheServerConversation(chat, messages) {
    const normalizedChat = normalizeServerConversation(chat);
    await Storage.upsertServerChat(normalizedChat);
    if (Array.isArray(messages)) {
      await Storage.replaceChatMessages(
        normalizedChat.id,
        messages.map(normalizeServerMessage),
      );
    }
    return Storage.getChat(normalizedChat.id);
  }

  async function fetchAuthenticatedChatList(options = {}) {
    const { silent = false } = options;
    const stopMeasure = startPerf("ui.chat_list.fetch", { silent });
    try {
      const response = await API.getConversations();
      const chats = Array.isArray(response?.conversations)
        ? response.conversations.map(normalizeServerConversation)
        : [];
      await Promise.all(chats.map((chat) => Storage.upsertServerChat(chat)));
      stopMeasure("ok", { chat_count: chats.length });
      return chats;
    } catch (error) {
      stopMeasure("error");
      logAuthenticatedConversationError("fetchAuthenticatedChatList", error);
      if (isProfileNameRequiredError(error)) {
        return getCachedServerChats();
      }
      if (!silent) {
        showToast("Couldn't load your conversations right now. Please try again.", "error");
      }
      return getCachedServerChats();
    }
  }

  async function fetchAuthenticatedChat(chatId, options = {}) {
    const { silent = false } = options;
    try {
      const response = await API.getConversationMessages(chatId);
      const cachedChat = await Storage.getChat(chatId);
      
      // Extract title from server response - this ensures titles persist across devices
      const serverTitle = response?.conversation?.title || response?.title;
      const chatTitle = serverTitle || cachedChat?.title || "New Chat";
      
      // Upsert chat with proper title from server
      await Storage.upsertServerChat({
        id: chatId,
        title: chatTitle,
        created_at: response?.conversation?.created_at || cachedChat?.created || new Date().toISOString(),
        last_activity_at: response?.conversation?.last_activity_at || response?.conversation?.created_at || null,
      });
      
      const messages = Array.isArray(response?.messages)
        ? response.messages.map(normalizeServerMessage)
        : [];
      await Storage.replaceChatMessages(chatId, messages);
      return Storage.getChat(chatId);
    } catch (error) {
      logAuthenticatedConversationError("fetchAuthenticatedChat", error);
      if (isProfileNameRequiredError(error)) {
        return Storage.getChat(chatId);
      }
      if (!silent) {
        showToast("Couldn't open that conversation right now. Please try again.", "error");
      }
      const cachedChat = await Storage.getChat(chatId);
      if (isServerBackedChat(cachedChat)) {
        return cachedChat;
      }
      throw error;
    }
  }

  async function refreshCanonicalChatAfterImageGeneration(chatId) {
    if (!isAuthenticatedSession() || !chatId) return null;
    try {
      const refreshedChat = await fetchAuthenticatedChat(chatId, { silent: true });
      if (refreshedChat && currentChatId === chatId) {
        renderLoadedChat(chatId, refreshedChat, { forceRender: true });
      }
      return refreshedChat;
    } catch (error) {
      logAuthenticatedConversationError("refreshCanonicalChatAfterImageGeneration", error);
      return null;
    }
  }

  function settleImageGenerationUi(chatId, state) {
    if (state) {
      state.isThinking = false;
      state.activityMode = "thinking";
      state.abortController = null;
    }
    hideActivityIndicator(chatId);
    setSendMode();
    updateImageButtonState();
  }

  let chatListRefreshTimer = null;
  function scheduleChatListRefresh(delayMs = 80) {
    if (chatListRefreshTimer) clearTimeout(chatListRefreshTimer);
    chatListRefreshTimer = setTimeout(() => {
      chatListRefreshTimer = null;
      loadChatList(true).catch((error) => {
        logAuthenticatedConversationError("chatList.deferredRefresh", error);
      });
    }, delayMs);
  }

  function isPlaceholderServerChat(chat) {
    return Boolean(chat?.source === "server" && chat?.pending_server_sync);
  }

  async function createPendingServerChat(title = "New Chat") {
    const chat = {
      id: `pending-${Storage.generateId()}`,
      title,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: "server",
      pending_server_sync: true,
      pending_title_sync: false,
      title_sync_error: null,
      last_title_synced_at: null,
    };
    await Storage.upsertServerChat(chat);
    return chat;
  }

  async function reconcilePendingServerChat(pendingChatId, actualChat) {
    if (!pendingChatId || !actualChat?.id) return actualChat;
    const pendingChat = await Storage.getChat(pendingChatId);
    const pendingMessages = Array.isArray(pendingChat?.messages) ? pendingChat.messages : [];
    if (welcomeGreetingByChatId.has(pendingChatId) && !welcomeGreetingByChatId.has(actualChat.id)) {
      welcomeGreetingByChatId.set(actualChat.id, welcomeGreetingByChatId.get(pendingChatId));
    }
    welcomeGreetingByChatId.delete(pendingChatId);
    await Storage.deleteChat(pendingChatId);
    await Storage.upsertServerChat({
      ...actualChat,
      title: pendingChat?.title || actualChat.title,
      pending_server_sync: false,
      pending_title_sync: Boolean(pendingChat?.pending_title_sync),
      title_sync_error: pendingChat?.title_sync_error || null,
      last_title_synced_at: pendingChat?.last_title_synced_at || null,
    });
    if (pendingMessages.length > 0) {
      await Storage.replaceChatMessages(actualChat.id, pendingMessages);
    }
    if (currentChatId === pendingChatId) currentChatId = actualChat.id;
    return actualChat;
  }

  async function removePendingServerChat(chatId) {
    if (!chatId) return;
    const chat = await Storage.getChat(chatId);
    if (isPlaceholderServerChat(chat)) {
      await Storage.deleteChat(chatId);
      if (currentChatId === chatId) currentChatId = null;
    }
  }

  async function createAuthenticatedChat(title = "New Chat") {
    const stopMeasure = startPerf("ui.authenticated_chat.create", { title });
    try {
      const response = await API.createConversation(title);
      const chat = normalizeServerConversation(response?.conversation || { id: "", title });
      if (!chat.id) throw new Error("Failed to create conversation");
      await Storage.upsertServerChat(chat);
      stopMeasure("ok", { chat_id: chat.id });
      return chat;
    } catch (error) {
      stopMeasure("error");
      throw error;
    }
  }

  function backoffDelayMs(attemptCount) {
    return Math.min(5 * 60 * 1000, 1000 * Math.pow(2, Math.max(0, attemptCount || 0)));
  }

  async function queueSyncJob(type, payload, overrides = {}) {
    return Storage.putSyncJob({
      id: overrides.id || `${type}:${payload?.conversationId || payload?.memoryId || payload?.id || payload?.pendingChatId || Storage.generateId()}`,
      type,
      payload,
      status: overrides.status || "pending",
      attempt_count: overrides.attempt_count || 0,
      next_retry_at: overrides.next_retry_at || new Date().toISOString(),
      sync_error: overrides.sync_error || null,
    });
  }

  async function syncCloudMemoriesFromServer(options = {}) {
    const { force = false, silent = true } = options;
    if (!isAuthenticatedSession()) return [];
    if (!force && memorySyncPromise) return memorySyncPromise;
    if (!force && (Date.now() - memoryLastSyncedAt) < MEMORY_SYNC_STALE_MS) {
      return Storage.getAllMemories();
    }

    const run = (async () => {
      try {
        const response = await API.getMemories();
        const memories = Array.isArray(response?.memories) ? response.memories.map(normalizeServerMemory) : [];
        await Promise.all(memories.map((memory) => Storage.storeMemory(memory)));
        memoryLastSyncedAt = Date.now();
        return memories;
      } catch (error) {
        logAuthenticatedConversationError("syncCloudMemoriesFromServer", error);
        if (isProfileNameRequiredError(error)) {
          return Storage.getAllMemories();
        }
        if (!silent) {
          showToast("Couldn't refresh your memories right now.", "error");
        }
        return Storage.getAllMemories();
      } finally {
        memorySyncPromise = null;
      }
    })();

    memorySyncPromise = run;
    return run;
  }

  async function ensureRemoteConversationForChat(chatId) {
    if (!isAuthenticatedSession() || !chatId) return chatId;
    const existingChat = await Storage.getChat(chatId);
    if (!isPlaceholderServerChat(existingChat)) {
      return existingChat?.id || chatId;
    }
    if (pendingChatCreatePromises.has(chatId)) {
      return pendingChatCreatePromises.get(chatId);
    }

    const createPromise = (async () => {
      const title = existingChat?.title || "New Chat";
      try {
        const actualChat = await createAuthenticatedChat(title);
        await reconcilePendingServerChat(chatId, actualChat);
        await loadChatList(true);
        return actualChat.id;
      } catch (error) {
        await queueSyncJob(SYNC_JOB_TYPES.chatCreate, { pendingChatId: chatId, title });
        throw error;
      } finally {
        pendingChatCreatePromises.delete(chatId);
      }
    })();

    pendingChatCreatePromises.set(chatId, createPromise);
    return createPromise;
  }

  async function processSyncQueue() {
    if (syncQueuePromise) return syncQueuePromise;
    syncQueuePromise = (async () => {
      if (!isAuthenticatedSession()) return;
      const allJobs = await Storage.getAllSyncJobs();
      const now = Date.now();
      const dueJobs = allJobs.filter((job) => new Date(job.next_retry_at || 0).getTime() <= now);

      for (const job of dueJobs) {
        try {
          if (job.type === SYNC_JOB_TYPES.chatCreate) {
            const pendingChat = await Storage.getChat(job.payload?.pendingChatId);
            if (!pendingChat || !isPlaceholderServerChat(pendingChat)) {
              await Storage.deleteSyncJob(job.id);
              continue;
            }
            const actualChat = await createAuthenticatedChat(job.payload?.title || pendingChat.title || "New Chat");
            await reconcilePendingServerChat(job.payload?.pendingChatId, actualChat);
            await Storage.deleteSyncJob(job.id);
            await loadChatList(true);
            continue;
          }

          if (job.type === SYNC_JOB_TYPES.chatDelete) {
            await API.deleteConversation(job.payload?.conversationId);
            await Storage.deleteSyncJob(job.id);
            continue;
          }

          if (job.type === SYNC_JOB_TYPES.chatTitle) {
            const conversationId = typeof job.payload?.conversationId === "string" ? job.payload.conversationId.trim() : "";
            const title = typeof job.payload?.title === "string" ? job.payload.title.trim() : "";
            if (!conversationId || !title) {
              await Storage.deleteSyncJob(job.id);
              continue;
            }
            // Skip title sync if conversation is still a placeholder (pending creation)
            const chat = await Storage.getChat(conversationId);
            if (chat && isPlaceholderServerChat(chat)) {
              // Don't attempt title update - conversation doesn't exist on server yet
              // Job will be retried on next sync cycle after chatCreate completes
              continue;
            }
            await API.updateConversationTitle(conversationId, title);
            await Storage.updateChatTitle(conversationId, title, {
              pendingTitleSync: false,
              titleSyncError: null,
              lastTitleSyncedAt: new Date().toISOString(),
            });
            await Storage.deleteSyncJob(job.id);
            continue;
          }

          if (job.type === SYNC_JOB_TYPES.memoryDelete) {
            await API.deleteMemory(job.payload?.memoryId);
            await Storage.deleteSyncJob(job.id);
            continue;
          }

          await Storage.deleteSyncJob(job.id);
        } catch (error) {
          const nextAttempt = (job.attempt_count || 0) + 1;
          if (job.type === SYNC_JOB_TYPES.chatTitle) {
            const conversationId = typeof job.payload?.conversationId === "string" ? job.payload.conversationId.trim() : "";
            const title = typeof job.payload?.title === "string" ? job.payload.title : "";
            if (conversationId && title) {
              await Storage.updateChatTitle(conversationId, title, {
                pendingTitleSync: true,
                titleSyncError: error?.message || String(error),
              });
            }
          }
          await Storage.putSyncJob({
            ...job,
            status: "pending",
            attempt_count: nextAttempt,
            next_retry_at: new Date(Date.now() + backoffDelayMs(nextAttempt)).toISOString(),
            sync_error: error?.message || String(error),
          });
          logAuthenticatedConversationError(`processSyncQueue.${job.type}`, error);
        }
      }
    })().finally(() => {
      syncQueuePromise = null;
    });

    return syncQueuePromise;
  }

  async function syncRemoteChatListInBackground(options = {}) {
    const { selectFirstIfEmpty = false } = options;
    if (!isAuthenticatedSession()) return [];
    const chats = await fetchAuthenticatedChatList({ silent: true });
    scheduleChatListRefresh();
    if (!currentChatId && selectFirstIfEmpty && Array.isArray(chats) && chats.length > 0) {
      await loadChat(chats[0].id, { silent: true });
    }
    markPerf("ui.bootstrap.remote_merge_done", { signed_in: true, chat_count: Array.isArray(chats) ? chats.length : 0 });
    return chats;
  }

  async function syncConversationStateForAuth(signedIn) {
    const stopMeasure = startPerf("ui.auth.sync_state", { signed_in: signedIn });
    currentChatId = null;
    currentSessionFile = null;
    currentSessionImageAttachments = [];
    pendingClarifications.clear();
    if (!signedIn) {
      guestChatState = null;
      guestMemoryState = [];
    }
    if (chatMessages) chatMessages.innerHTML = "";
    showWelcome();
    updateHtmlTitle("");

    if (signedIn && isNameCaptureRequired()) {
      if (chatList) chatList.innerHTML = "";
      syncActiveChatItem();
      stopMeasure("blocked", { requires_name: true });
      return [];
    }

    let chats = [];
    try {
      chats = await loadChatList(signedIn);
    } catch (error) {
      stopMeasure("error");
      logAuthenticatedConversationError("syncConversationStateForAuth.loadChatList", error);
      if (signedIn) {
        showToast("Signed in, but we couldn't sync your conversations yet.", "error");
        return [];
      }
      throw error;
    }

    if (signedIn) {
      syncRemoteChatListInBackground().catch((error) => {
        logAuthenticatedConversationError("syncConversationStateForAuth.remoteChats", error);
      });
      syncCloudMemoriesFromServer({ silent: true }).catch((error) => {
        logAuthenticatedConversationError("syncConversationStateForAuth.memories", error);
      });
      processSyncQueue().catch((error) => {
        logAuthenticatedConversationError("syncConversationStateForAuth.queue", error);
      });
      stopMeasure("ok", { chat_count: Array.isArray(chats) ? chats.length : 0 });
      return chats;
    }

    stopMeasure("ok", { chat_count: Array.isArray(chats) ? chats.length : 0 });
    return chats;
  }

  // ---- Smart scroll: only auto-scroll if user is near bottom ----
  let _userScrolledUp = false;
  const SCROLL_THRESHOLD = 120; // px from bottom to count as "at bottom"

  if (chatMessages) {
    chatMessages.addEventListener("scroll", () => {
      const distFromBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight;
      _userScrolledUp = distFromBottom > SCROLL_THRESHOLD;
      if (!_userScrolledUp && scrollAnchorPill) scrollAnchorPill.classList.remove("visible");
    }, { passive: true });
  }
  if (scrollAnchorPill) {
    scrollAnchorPill.addEventListener("click", () => {
      _userScrolledUp = false;
      scrollAnchorPill.classList.remove("visible");
      if (chatMessages) chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "smooth" });
    });
  }

  // ---- Toast notification system ----
  function showToast(message, type = "info", durationMs = 4000) {
    if (!toastContainer) return;
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add("show")));
    setTimeout(() => {
      toast.classList.remove("show");
      toast.addEventListener("transitionend", () => toast.remove(), { once: true });
      setTimeout(() => toast.remove(), 400); // fallback cleanup
    }, durationMs);
  }

  function setAuthStatus(message = "", type = "") {
    if (!authStatus) return;
    authStatus.textContent = message;
    authStatus.classList.toggle("is-error", type === "error");
    authStatus.classList.toggle("is-success", type === "success");
  }

  function setAuthView(mode) {
    authView = ["login", "signup", "forgot-password-request", "password-recovery"].includes(mode)
      ? mode
      : "login";
    const isSignup = authView === "signup";
    const isResetRequest = isPasswordResetRequestView(authView);
    const isRecovery = isPasswordRecoveryView(authView);
    if (authModalTitle) {
      authModalTitle.textContent = isSignup
        ? "Create your account"
        : isResetRequest
          ? "Reset your password"
          : isRecovery
            ? "Set a new password"
            : "Log in to SentIQGPT";
    }
    if (authModalHeading) {
      authModalHeading.textContent = isSignup
        ? "Sign up"
        : isResetRequest
          ? "Forgot Password"
          : isRecovery
            ? "Set New Password"
            : "Log in";
    }
    if (authModalSubtitle) {
      authModalSubtitle.textContent = isSignup
        ? "Create an account with your email and password to keep chatting."
        : isResetRequest
          ? "Enter your email and we'll send you a password reset link."
          : isRecovery
            ? "Choose a new password for your SentIQGPT account."
            : "Continue with your email and password to unlock the full chat experience.";
    }
    if (authSubmitBtn) {
      authSubmitBtn.textContent = isSignup
        ? "Create Account"
        : isResetRequest
          ? "Send Reset Link"
          : isRecovery
            ? "Update Password"
            : "Log in";
    }
    if (authSwitchLabel) {
      authSwitchLabel.textContent = isSignup
        ? "Already have an account?"
        : (isResetRequest || isRecovery)
          ? "Remembered your password?"
          : "New to SentIQGPT?";
    }
    if (authSwitchBtn) {
      authSwitchBtn.textContent = isSignup
        ? "Sign in."
        : (isResetRequest || isRecovery)
          ? "Back to sign in."
          : "Create new account.";
    }
    if (authPasswordInput) {
      authPasswordInput.autocomplete = isSignup || isRecovery ? "new-password" : "current-password";
      authPasswordInput.required = isPasswordAuthView(authView);
      authPasswordInput.placeholder = isRecovery ? "New password" : "Password";
      authPasswordInput.value = "";
      authPasswordInput.closest(".auth-field").style.display = isPasswordAuthView(authView) ? "" : "none";
    }
    if (authPasswordToggle) authPasswordToggle.style.display = isPasswordAuthView(authView) ? "" : "none";
    if (authForgotRow) authForgotRow.style.display = authView === "login" ? "flex" : "none";
    if (authEmailInput) {
      authEmailInput.required = !isRecovery;
      authEmailInput.disabled = isRecovery;
      if (isRecovery) {
        authEmailInput.value = authSessionState?.user?.email || authEmailInput.value || "";
      }
    }
    setAuthStatus("");
  }

  function setPasswordVisibility(visible) {
    if (!authPasswordInput || !authPasswordEye || !authPasswordToggle) return;
    authPasswordInput.type = visible ? "text" : "password";
    authPasswordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
    authPasswordEye.innerHTML = visible
      ? '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a21.77 21.77 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.79 21.79 0 0 1-3.22 4.19"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>'
      : '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle>';
  }

  function openAuthModal(mode = authView) {
    setAuthView(mode);
    if (authModal) {
      authModal.style.display = "flex";
      authModal.setAttribute("aria-hidden", "false");
    }
    setPasswordVisibility(false);
    closeSidebar();
    syncAuthBlurState();
    updateOverlayLocks();
    requestAnimationFrame(() => getAuthPrimaryFocus(mode)?.focus());
  }

  function closeAuthModal() {
    if (authModal) {
      authModal.style.display = "none";
      authModal.setAttribute("aria-hidden", "true");
    }
    setAuthStatus("");
    if (authForm) authForm.reset();
    setPasswordVisibility(false);
    setAuthView("login");
    syncAuthBlurState();
    updateOverlayLocks();
  }

  function setChatAccess(enabled) {
    const signedIn = !!enabled;
    const requiresName = signedIn && isNameCaptureRequired();
    if (!signedIn || requiresName) hideSelectionButton();
    if (chatInput) {
      chatInput.disabled = requiresName;
    }
    if (sendBtn) sendBtn.disabled = requiresName;
    if (newChatBtn) newChatBtn.disabled = requiresName;
    if (composerPlusBtn) composerPlusBtn.disabled = requiresName;
    if (fileAttachBtn) fileAttachBtn.disabled = requiresName;
    if (webSurfBasicBtn) webSurfBasicBtn.disabled = requiresName;
    if (voiceBtn) voiceBtn.disabled = requiresName;
    if (imageGenBtn) {
      imageGenBtn.disabled = !signedIn || requiresName;
      imageGenBtn.style.display = signedIn ? "" : "none";
    }
    sendBtn?.classList.remove("auth-disabled");
    newChatBtn?.classList.remove("auth-disabled");
    fileAttachBtn?.classList.remove("auth-disabled");
    imageGenBtn?.classList.toggle("auth-disabled", !signedIn || requiresName);
    voiceBtn?.classList.remove("auth-disabled");
    if (authGateMessage) {
      authGateMessage.textContent = requiresName
        ? "Add your name to unlock your signed-in workspace."
        : "Sign in for access to higher intelligence, image generation.";
      authGateMessage.classList.toggle("visible", !signedIn || requiresName);
    }
    if (authWelcomeNote) {
      authWelcomeNote.textContent = requiresName
        ? "Add your name to personalize SentIQGPT and continue."
        : "Sign in for access to higher intelligence, image generation, and synced conversations.";
      authWelcomeNote.style.display = (!signedIn || requiresName) ? "block" : "none";
    }
    document.querySelectorAll(".settings-tab[data-tab=\"memory\"], #compress-memories-btn").forEach((el) => {
      const node = el;
      node.style.display = signedIn && !requiresName ? "" : "none";
    });
    syncComposerHint();
    refreshWelcomeCopy();
  }

  async function refreshProfileState(options = {}) {
    const { force = false, silent = true } = options;
    const userId = getActiveAuthUserId();
    if (!isAuthenticatedSession() || !userId) {
      resetAuthProfileState();
      return authProfileState;
    }

    if (!force && profileRefreshPromise && profileRefreshUserId === userId) {
      return profileRefreshPromise;
    }

    profileRefreshUserId = userId;
    profileRefreshPromise = (async () => {
      try {
        const response = await API.getProfile();
        if (profileRefreshUserId !== userId) {
          return authProfileState;
        }
        const displayName = normalizeDisplayName(response?.profile?.display_name);
        authProfileState = {
          displayName,
          requiresName: Boolean(response?.requires_name) || !displayName,
          fetchFailed: false,
          loaded: true,
          userId,
        };
        if (authProfileState.requiresName) {
          openRequiredNameModal();
        } else {
          closeRequiredNameModal();
        }
      } catch (error) {
        if (profileRefreshUserId !== userId) {
          return authProfileState;
        }
        authProfileState = {
          displayName: null,
          requiresName: false,
          fetchFailed: true,
          loaded: true,
          userId,
        };
        closeRequiredNameModal();
        if (!silent) {
          showToast(error?.message || "Couldn't load your profile right now.", "error");
        }
      } finally {
        if (profileRefreshUserId === userId) {
          if (authUserEmail) authUserEmail.textContent = getPreferredAccountLabel() || "Signed in";
          if (authMenuName) authMenuName.textContent = getPreferredAccountLabel() || "Signed in";
          if (authMenuEmail) authMenuEmail.textContent = authSessionState?.user?.email || "";
          setChatAccess(Boolean(authSessionState));
        }
      }

      return authProfileState;
    })();

    try {
      return await profileRefreshPromise;
    } finally {
      if (profileRefreshUserId === userId) {
        profileRefreshPromise = null;
      }
    }
  }

  async function refreshAuthUI(sessionOverride) {
    let session = typeof sessionOverride === "undefined" ? null : sessionOverride;
    if (typeof sessionOverride === "undefined") {
      try {
        session = await window.SentIQAuth?.getSession?.();
      } catch {
        session = null;
      }
    }
    authSessionState = session || null;
    const email = authSessionState?.user?.email || "";
    const signedIn = Boolean(authSessionState);
    const activeUserId = getActiveAuthUserId();
    const cachedProfile = authProfileState.userId === activeUserId ? authProfileState : null;
    const initialAccountLabel = signedIn
      ? (cachedProfile?.displayName || (cachedProfile?.fetchFailed ? email : "Signed in"))
      : "";
    if (authActions) authActions.dataset.state = signedIn ? "signed-in" : "signed-out";
    if (authLoginBtn) authLoginBtn.style.display = signedIn ? "none" : "";
    if (authSignupBtn) authSignupBtn.style.display = signedIn ? "none" : "";
    if (authUserChip) authUserChip.style.display = signedIn ? "inline-flex" : "none";
    if (authLogoutBtn) authLogoutBtn.style.display = signedIn ? "" : "none";
    if (!signedIn) {
      resetAuthProfileState();
    }
    if (authUserEmail) authUserEmail.textContent = signedIn ? initialAccountLabel : "";
    if (authMenuName) authMenuName.textContent = signedIn ? initialAccountLabel : "";
    if (authMenuEmail) authMenuEmail.textContent = signedIn ? email : "";
    if (authMenuToggle) authMenuToggle.style.display = signedIn ? "" : "none";
    closeAuthMenu();
    if (signedIn) {
      closeAuthModal();
      await refreshProfileState({ silent: true });
      if (isNameCaptureRequired()) stopFileAnalysisUpdates();
      else startFileAnalysisUpdates();
    } else {
      stopFileAnalysisUpdates();
      setChatAccess(false);
    }
  }

  async function requireAuthAccess(message = "Log in to start chatting.") {
    let session = authSessionState;
    if (!session && window.SentIQAuth?.getSession) {
      try {
        session = await window.SentIQAuth.getSession();
      } catch {
        session = null;
      }
    }
    authSessionState = session || null;
    if (authSessionState) {
      if (isNameCaptureRequired()) {
        openRequiredNameModal();
        showToast("Add your name to continue.", "info", 2600);
        return null;
      }
      return authSessionState;
    }
    setAuthStatus("");
    openAuthModal("login");
    showToast(message, "info", 3200);
    return null;
  }

  function getAuthReturnUrlState() {
    const url = new URL(window.location.href);
    const authMode = url.searchParams.get(window.SentIQAuth?.AUTH_RETURN_MODE_PARAM || "auth_mode");
    const hashParams = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
    return {
      url,
      authMode,
      hasAccessToken: hashParams.has("access_token") || hashParams.has("refresh_token"),
      authType: (hashParams.get("type") || "").toLowerCase(),
    };
  }

  function clearAuthReturnUrlState() {
    const { url } = getAuthReturnUrlState();
    url.searchParams.delete(window.SentIQAuth?.AUTH_RETURN_MODE_PARAM || "auth_mode");
    url.hash = "";
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
  }

  async function handleAuthReturnFlow() {
    const authReturn = getAuthReturnUrlState();
    const shouldOpenSignIn = authReturn.authMode === (window.SentIQAuth?.AUTH_RETURN_LOGIN_MODE || "signin");
    const shouldOpenRecovery = authReturn.authMode === (window.SentIQAuth?.AUTH_RETURN_RECOVERY_MODE || "recovery");
    if (!shouldOpenSignIn && !shouldOpenRecovery) return;

    const shouldResetSession = authReturn.hasAccessToken && authReturn.authType === "signup";
    if (shouldResetSession) {
      try {
        await window.SentIQAuth?.signOut?.();
      } catch (error) {
        debugWarn("[UI] Unable to clear post-verification session:", getSafeErrorMessage(error));
      }
      await refreshAuthUI(null);
    }

    if (shouldOpenRecovery) {
      clearAuthReturnUrlState();
      openAuthModal("password-recovery");
      setAuthStatus("Set a new password to finish resetting your account.", "success");
      return;
    }

    clearAuthReturnUrlState();
    openAuthModal("login");
    setAuthStatus("Email verified. Sign in to continue.", "success");
  }

  const ACTIVITY_BASE_TEXT = {
    thinking: "Thinking...",
    web_search: "Surfing the web",
    reasoning: "Thinking a bit longer...",
    image_generation: "Generating image...",
    file_generation: "Analysing...",
  };
  const ACTIVITY_LOADER_KIND = {
    thinking: "loader-text",
    web_search: "loader-generic",
    reasoning: "loader-generic",
    image_generation: "loader-image",
    file_generation: "loader-generic",
  };
  const ACTIVITY_TIMER_MODES = new Set(["thinking", "web_search", "image_generation", "file_generation"]);

  function getActivityBaseText(mode = "thinking") {
    return ACTIVITY_BASE_TEXT[mode] || ACTIVITY_BASE_TEXT.thinking;
  }

  function ensureTypingDotMatrix() {
    if (!typingIndicator) return;
    const dots = typingIndicator.querySelector(".typing-dots");
    if (!dots || dots.dataset.matrixReady === "1") return;
    dots.innerHTML = "";
    const total = 24;
    for (let index = 0; index < total; index += 1) {
      const dot = document.createElement("span");
      dot.className = "typing-dot";
      dot.style.setProperty("--dot-delay", String(index));
      dots.appendChild(dot);
    }
    dots.dataset.matrixReady = "1";
  }

  function applyActivityIndicatorMode(mode = "thinking", loaderKind = ACTIVITY_LOADER_KIND.thinking) {
    if (!typingIndicator) return;
    ensureTypingDotMatrix();
    typingIndicator.classList.remove("mode-thinking", "mode-web-search", "mode-reasoning", "mode-file-generation");
    typingIndicator.classList.add(`mode-${mode}`);
    typingIndicator.classList.remove("loader-text", "loader-image", "loader-chart", "loader-generic");
    typingIndicator.classList.add(loaderKind || ACTIVITY_LOADER_KIND[mode] || ACTIVITY_LOADER_KIND.thinking);
    typingIndicator.dataset.loaderKind = loaderKind || ACTIVITY_LOADER_KIND[mode] || ACTIVITY_LOADER_KIND.thinking;
    if (typingTextEl) typingTextEl.textContent = getActivityBaseText(mode);
  }

  // ---- Thinking indicator elapsed timer ----
  let _thinkingTimer = null;
  function startThinkingTimer(mode = "thinking", loaderKind = ACTIVITY_LOADER_KIND.thinking) {
    const start = Date.now();
    applyActivityIndicatorMode(mode, loaderKind);
    clearInterval(_thinkingTimer);
    if (!ACTIVITY_TIMER_MODES.has(mode)) return;
    _thinkingTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed >= 5 && typingTextEl) typingTextEl.textContent = `${getActivityBaseText(mode)} ${elapsed}s`;
    }, 1000);
  }
  function stopThinkingTimer(resetMode = "thinking", loaderKind = ACTIVITY_LOADER_KIND.thinking) {
    clearInterval(_thinkingTimer);
    _thinkingTimer = null;
    if (typingTextEl) typingTextEl.textContent = getActivityBaseText(resetMode);
    applyActivityIndicatorMode(resetMode, loaderKind);
  }

  function showActivityIndicator(mode = "thinking", options = {}) {
    const {
      chatId = currentChatId,
      withTimer = ACTIVITY_TIMER_MODES.has(mode),
      persist = true,
      loaderKind = ACTIVITY_LOADER_KIND[mode] || ACTIVITY_LOADER_KIND.thinking,
    } = options;
    if (persist && chatId) {
      const state = getChatState(chatId);
      if (state) {
        state.activityMode = mode;
        state.activityLoaderKind = loaderKind;
      }
    }
    if (typingIndicator) {
      typingIndicator.style.display = "flex";
      requestAnimationFrame(() => typingIndicator.classList.add("is-visible"));
    }
    if (withTimer) startThinkingTimer(mode, loaderKind);
    else {
      stopThinkingTimer(mode, loaderKind);
      applyActivityIndicatorMode(mode, loaderKind);
    }
  }

  function updateActivityIndicator(routeOrMode, options = {}) {
    const normalized = String(routeOrMode || "thinking");
    const mode = normalized === "web_search"
      ? "web_search"
      : normalized === "image_generation" || normalized === "image"
        ? "image_generation"
      : normalized === "file_generation"
        ? "file_generation"
      : normalized === "math_reasoning" || normalized === "reasoning"
        ? "reasoning"
        : "thinking";
    const inferredLoaderKind = normalized === "image_generation"
      ? "loader-image"
      : normalized === "chart_generation"
        ? "loader-chart"
        : normalized === "math_reasoning" || normalized === "reasoning" || normalized === "web_search" || normalized === "file_generation"
          ? "loader-generic"
          : normalized === "image_generation" || normalized === "image"
            ? "loader-image"
          : ACTIVITY_LOADER_KIND[mode] || ACTIVITY_LOADER_KIND.thinking;
    showActivityIndicator(mode, {
      ...options,
      withTimer: options.withTimer ?? ACTIVITY_TIMER_MODES.has(mode),
      loaderKind: options.loaderKind || inferredLoaderKind,
    });
  }

  function hideActivityIndicator(chatId = currentChatId) {
    stopThinkingTimer("thinking", ACTIVITY_LOADER_KIND.thinking);
    applyActivityIndicatorMode("thinking", ACTIVITY_LOADER_KIND.thinking);
    if (chatId) {
      const state = getChatState(chatId);
      if (state) {
        state.activityMode = "thinking";
        state.activityLoaderKind = "loader-text";
      }
    }
    if (typingIndicator) {
      typingIndicator.classList.remove("is-visible");
      setTimeout(() => {
        if (!typingIndicator.classList.contains("is-visible")) {
          typingIndicator.style.display = "none";
        }
      }, 170);
    }
  }

  // Reusable loader controller used across send, stream, and image flows.
  const SentIQLoaderEngine = {
    resolveKind(prompt, options = {}) {
      return detectLoaderKindForPrompt(prompt, options);
    },
    showForPrompt(prompt, options = {}) {
      const loaderKind = this.resolveKind(prompt, options);
      showActivityIndicator("thinking", {
        ...options,
        loaderKind,
      });
      return loaderKind;
    },
    showForRoute(routeOrMode, options = {}) {
      updateActivityIndicator(routeOrMode, options);
      return typingIndicator?.dataset?.loaderKind || "loader-text";
    },
    hide(chatId = currentChatId) {
      hideActivityIndicator(chatId);
    },
  };

  // ---- Send / Stop button toggle ----
  const SEND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  function setSendMode() {
    if (!sendBtn) return;
    sendBtn.classList.remove("is-stop");
    sendBtn.innerHTML = SEND_SVG;
    sendBtn.title = "Send message";
    sendBtn.setAttribute("aria-label", "Send message");
  }

  function setStopMode() {
    if (!sendBtn) return;
    sendBtn.classList.add("is-stop");
    sendBtn.innerHTML = "";  // CSS ::before draws square stop icon
    sendBtn.title = "Stop generating";
    sendBtn.setAttribute("aria-label", "Stop generating");
  }

  function abortCurrentGeneration() {
    if (!currentChatId) return;
    const state = getChatState(currentChatId);
    if (!state || !state.isThinking) return;
    debugLog("[UI] abortCurrentGeneration", { hasChat: Boolean(currentChatId) });
    if (state.abortController) {
      state.abortController.abort();
      state.abortController = null;
    }
    state.requestId = null; // mark stale
    state.isThinking = false;
    hideActivityIndicator(currentChatId);
    setSendMode();
  }

  // ---- Image Quota & Cooldown (localStorage-backed) ----
  const IMAGE_QUOTA_KEY = "sentiq_image_quota";
  const IMAGE_COOLDOWN_KEY = "sentiq_image_cooldown";
  const IMAGE_QUOTA_LIMIT = 30;
  const IMAGE_COOLDOWN_MS = 5000;
  const IMAGE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

  // Migrate legacy quota formats on startup
  (function migrateImageQuota() {
    try {
      const raw = localStorage.getItem(IMAGE_QUOTA_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      // Legacy format: { imageCount, lastReset }
      if (typeof data.imageCount === "number" && !Array.isArray(data.timestamps)) {
        const now = Date.now();
        if (data.lastReset && (now - data.lastReset) >= IMAGE_QUOTA_WINDOW_MS) {
          localStorage.setItem(IMAGE_QUOTA_KEY, JSON.stringify({ timestamps: [] }));
        } else {
          const count = Math.min(data.imageCount, IMAGE_QUOTA_LIMIT);
          const ts = [];
          for (let i = 0; i < count; i++) ts.push(now - i * 1000);
          localStorage.setItem(IMAGE_QUOTA_KEY, JSON.stringify({ timestamps: ts }));
        }
        return;
      }
      // Corrupt or unrecognized — reset
      if (!Array.isArray(data.timestamps)) {
        localStorage.setItem(IMAGE_QUOTA_KEY, JSON.stringify({ timestamps: [] }));
      }
    } catch { localStorage.removeItem(IMAGE_QUOTA_KEY); }
  })();

  function getImageQuotaData() {
    try {
      const raw = localStorage.getItem(IMAGE_QUOTA_KEY);
      if (!raw) return { timestamps: [] };
      const data = JSON.parse(raw);
      const now = Date.now();
      data.timestamps = (data.timestamps || []).filter(ts => now - ts < IMAGE_QUOTA_WINDOW_MS);
      return data;
    } catch { return { timestamps: [] }; }
  }

  function checkImageQuota() {
    const data = getImageQuotaData();
    return {
      used: data.timestamps.length,
      remaining: Math.max(0, IMAGE_QUOTA_LIMIT - data.timestamps.length),
      limit: IMAGE_QUOTA_LIMIT,
      exhausted: data.timestamps.length >= IMAGE_QUOTA_LIMIT,
    };
  }

  function incrementImageQuota() {
    const data = getImageQuotaData();
    data.timestamps.push(Date.now());
    localStorage.setItem(IMAGE_QUOTA_KEY, JSON.stringify(data));
    updateImageButtonState();
  }

  function checkImageCooldown() {
    try {
      const last = parseInt(localStorage.getItem(IMAGE_COOLDOWN_KEY) || "0", 10);
      const elapsed = Date.now() - last;
      return { active: elapsed < IMAGE_COOLDOWN_MS, waitMs: Math.max(0, IMAGE_COOLDOWN_MS - elapsed) };
    } catch { return { active: false, waitMs: 0 }; }
  }

  function updateImageCooldown() {
    localStorage.setItem(IMAGE_COOLDOWN_KEY, String(Date.now()));
  }

  function hideImageButton() {
    if (imageGenBtn) imageGenBtn.style.display = "none";
    setImageMode(false);
  }

  function showImageButton() {
    if (imageGenBtn) imageGenBtn.style.display = authSessionState ? "" : "none";
  }

  function showQuotaWarning(message) {
    showToast(message, "error", 5000);
    appendMessageBubble("assistant", `⚠️ ${message}`);
  }

  function updateImageButtonState() {
    if (!authSessionState) {
      hideImageButton();
      return;
    }
    const quota = checkImageQuota();
    if (quota.exhausted) hideImageButton();
    else showImageButton();
  }

  function getThemeColor(variableName, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    return value || fallback;
  }

  function safeParseJson(value) {
    if (!value) return null;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function loadExternalScriptOnce(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (externalScriptPromises.has(src)) return externalScriptPromises.get(src);

    const promise = new Promise((resolve, reject) => {
      const existing = Array.from(document.scripts).find((script) => script.src === src);
      if (existing) {
        existing.addEventListener("load", () => resolve(globalName ? window[globalName] : true), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve(globalName ? window[globalName] : true);
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });

    externalScriptPromises.set(src, promise);
    return promise;
  }

  function normalizeTextForSelection(text) {
    return String(text || "").replace(/\r\n?/g, "\n");
  }

  function normalizeChartRenderer(renderer, payload) {
    const value = String(renderer || "").toLowerCase();
    if (value === "chart.js") return "chartjs";
    if (value === "plotly.js") return "plotly";
    if (value) return value;
    if (payload?.plotly_json || payload?.plotlyJson || payload?.figure || payload?.data || payload?.layout) return "plotly";
    if (payload?.chartjs_config || payload?.chartjsConfig || payload?.chart_config || payload?.chartConfig) return "chartjs";
    return "matplotlib";
  }

  function extractChartJsConfigFromCode(code) {
    if (!code || typeof code !== "string") return null;
    debugWarn("[Chart] Ignoring executable Chart.js code fallback; backend should provide chartjs_config.");
    return null;
  }

  function normalizeChartMeta(chartPayload) {
    if (!chartPayload) return null;
    const renderer = normalizeChartRenderer(chartPayload.renderer, chartPayload);
    const plotlySpec =
      renderer === "plotly"
        ? safeParseJson(chartPayload.plotly_json || chartPayload.plotlyJson || chartPayload.figure || chartPayload.spec)
          || ((Array.isArray(chartPayload.data) || chartPayload.layout || chartPayload.config)
            ? {
              data: chartPayload.data || [],
              layout: chartPayload.layout || {},
              config: chartPayload.config || {},
            }
            : null)
        : null;
    const chartJsConfig =
      renderer === "chartjs"
        ? safeParseJson(chartPayload.chartjs_config || chartPayload.chartjsConfig || chartPayload.chart_config || chartPayload.chartConfig || chartPayload.config)
          || extractChartJsConfigFromCode(chartPayload.code)
        : null;

    return {
      type: "chart",
      renderer,
      success: chartPayload.success !== false,
      chartType: chartPayload.chart_type || "",
      imageBase64: (chartPayload.image_base64 || chartPayload.imageBase64 || chartPayload.preview || "").trim(),
      imageUrl: (chartPayload.image_url || chartPayload.imageUrl || chartPayload.url || "").trim(),
      plotlySpec,
      chartJsConfig,
      error: chartPayload.error || "",
    };
  }

  function hasRenderableChart(meta) {
    return !!(meta && meta.success !== false && (meta.imageBase64 || meta.imageUrl || meta.plotlySpec || meta.chartJsConfig));
  }

  function createImageMeta(imagePayload) {
    if (!imagePayload?.success) return null;
    let imageUrl = "";
    if (imagePayload.image_url) imageUrl = imagePayload.image_url;
    else if (imagePayload.image_base64) imageUrl = `data:image/png;base64,${imagePayload.image_base64}`;
    else if (imagePayload.url) imageUrl = imagePayload.url;
    if (!imageUrl) return null;
    return { type: "image", imageUrl, prompt: imagePayload.prompt };
  }

  function normalizeUrlList(value, maxCount = 0) {
    if (!Array.isArray(value)) return [];
    const cleaned = value
      .map((item) => String(item || "").trim())
      .filter((item) => item.length > 0);
    return maxCount > 0 ? cleaned.slice(0, maxCount) : cleaned;
  }

  function getHostLabel(url) {
    if (!url) return "";
    try {
      return new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      return url.replace(/^https?:\/\//i, "").split("/")[0] || "";
    }
  }

  function normalizeWebSearchPayloadLegacyUnused(response) {
    const payload = response?.web_search || response?.webSearch || response?.search;
    if (!payload || typeof payload !== "object") return null;

    const results = Array.isArray(payload.results) ? payload.results : [];
    const normalizedResults = results
      .map((result) => {
        const url = String(result?.url || "").trim();
        const title = String(result?.title || "Untitled").trim();
        const content = String(result?.content || result?.snippet || result?.body || "").trim();
        const favicon = String(result?.favicon || "").trim();
        return {
          title,
          url,
          content,
          favicon,
          images: normalizeUrlList(result?.images, 4),
          score: typeof result?.score === "number" ? result.score : null,
          source: String(result?.source || ""),
        };
      })
      .filter((result) => result.url || result.content);

    return {
      query: String(payload.query || response?.query || "").trim(),
      answer: String(payload.answer || response?.answer || response?.reply || "").trim(),
      images: normalizeUrlList(payload.images, 8),
      results: normalizedResults,
      sources: Array.isArray(payload.sources) ? payload.sources : [],
    };
  }

  function renderWebSearchPanelLegacyUnused(payload, answerText, thinkingText, renderOptions = {}) {
    const safePayload = {
      query: String(payload?.query || "").trim(),
      answer: String(payload?.answer || answerText || "").trim(),
      images: normalizeUrlList(payload?.images, 8),
      results: Array.isArray(payload?.results) ? payload.results : [],
      sources: Array.isArray(payload?.sources) ? payload.sources : [],
    };

    const panel = document.createElement("div");
    panel.className = "web-search-panel";

    const answerBlock = document.createElement("div");
    answerBlock.className = "web-search-answer";
    answerBlock.innerHTML = renderAssistantMessageHtml(
      safePayload.answer || "Search results are ready.",
      thinkingText,
      { ...renderOptions, mode: "web_search" }
    );
    wireThinkingPanels(answerBlock);
    wireCodeCopyButtons(answerBlock);

    panel.appendChild(answerBlock);

    if (safePayload.images.length > 0) {
      const galleryWrap = document.createElement("div");
      const galleryLabel = document.createElement("div");
      galleryLabel.className = "web-search-section-label";
      galleryLabel.textContent = "Top Images";
      galleryWrap.appendChild(galleryLabel);

      const gallery = document.createElement("div");
      gallery.className = "web-search-gallery";
      safePayload.images.forEach((url) => {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Search image";
        img.loading = "lazy";
        img.addEventListener("load", () => scrollToBottom(true));
        gallery.appendChild(img);
      });
      galleryWrap.appendChild(gallery);
      panel.appendChild(galleryWrap);
    }

    const resultsWrap = document.createElement("div");
    resultsWrap.className = "web-search-results";
    if (safePayload.results.length > 0) {
      const resultsLabel = document.createElement("div");
      resultsLabel.className = "web-search-section-label";
      resultsLabel.textContent = "Sources";
      resultsWrap.appendChild(resultsLabel);

      safePayload.results.forEach((result) => {
        const resultImages = normalizeUrlList(result.images, 4);
        const card = document.createElement("div");
        card.className = "web-search-card";

        const header = document.createElement("div");
        header.className = "web-search-card-header";

        const faviconWrap = document.createElement("div");
        faviconWrap.className = "web-search-favicon";
        if (result.favicon) {
          const faviconImg = document.createElement("img");
          faviconImg.src = result.favicon;
          faviconImg.alt = "";
          faviconImg.loading = "lazy";
          faviconImg.addEventListener("error", () => {
            faviconWrap.textContent = (getHostLabel(result.url).charAt(0) || "•").toUpperCase();
          });
          faviconWrap.appendChild(faviconImg);
        } else {
          faviconWrap.textContent = (getHostLabel(result.url).charAt(0) || "•").toUpperCase();
        }

        const headerText = document.createElement("div");
        headerText.className = "web-search-header-text";
        const titleLink = document.createElement("a");
        titleLink.className = "web-search-title";
        titleLink.href = result.url || "#";
        titleLink.target = "_blank";
        titleLink.rel = "noopener noreferrer";
        titleLink.textContent = result.title || "Untitled";

        const urlLine = document.createElement("div");
        urlLine.className = "web-search-url";
        urlLine.textContent = getHostLabel(result.url) || result.url;

        headerText.appendChild(titleLink);
        headerText.appendChild(urlLine);

        header.appendChild(faviconWrap);
        header.appendChild(headerText);
        card.appendChild(header);

        if (result.content) {
          const contentDiv = document.createElement("div");
          contentDiv.className = "web-search-content";
          contentDiv.innerHTML = renderRichText(result.content, { mode: "web_search" });
          card.appendChild(contentDiv);
        }

        if (resultImages.length > 0) {
          const imageRow = document.createElement("div");
          imageRow.className = "web-search-image-row";
          resultImages.forEach((url) => {
            const img = document.createElement("img");
            img.src = url;
            img.alt = "Result image";
            img.loading = "lazy";
            imageRow.appendChild(img);
          });
          card.appendChild(imageRow);
        }

        resultsWrap.appendChild(card);
      });
    }

    panel.appendChild(resultsWrap);
    return panel;
  }

  function normalizeWebSearchSources(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        const url = String(item?.url || "").trim();
        const title = String(item?.title || "Untitled").trim();
        return { title, url };
      })
      .filter((item) => item.url);
  }

  function summarizeWebSearchContent(value, maxChars = 320) {
    const normalized = String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!normalized) return "";
    return normalized.length > maxChars
      ? `${normalized.slice(0, maxChars).trimEnd()}...`
      : normalized;
  }

  function createWebSearchImageTile(url, alt, variant = "gallery") {
    const tile = document.createElement("div");
    tile.className = `web-search-image-tile${variant === "row" ? " small" : ""}`;

    const img = document.createElement("img");
    img.src = url;
    img.alt = alt;
    img.loading = "lazy";
    img.addEventListener("load", () => {
      tile.classList.add("loaded");
      scrollToBottom(true);
    });
    img.addEventListener("error", () => {
      tile.classList.add("failed");
      img.remove();
    });

    const fallback = document.createElement("div");
    fallback.className = "web-search-image-fallback";
    fallback.textContent = "Image unavailable";

    tile.appendChild(img);
    tile.appendChild(fallback);
    return tile;
  }

  function createWebSearchSourceCard(source) {
    const card = document.createElement("a");
    card.className = "web-search-source-link";
    card.href = source.url || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";

    const title = document.createElement("div");
    title.className = "web-search-source-title";
    title.textContent = source.title || "Untitled";

    const urlLine = document.createElement("div");
    urlLine.className = "web-search-url";
    urlLine.textContent = getHostLabel(source.url) || source.url;

    card.appendChild(title);
    card.appendChild(urlLine);
    return card;
  }

  function normalizeWebSearchPayload(response) {
    const payload = response?.web_search || response?.webSearch || response?.search;
    if (!payload || typeof payload !== "object") return null;

    const results = Array.isArray(payload.results) ? payload.results : [];
    const normalizedResults = results
      .map((result) => {
        const url = String(result?.url || "").trim();
        const title = String(result?.title || "Untitled").trim();
        const content = String(result?.content || result?.snippet || result?.body || "").trim();
        const favicon = String(result?.favicon || "").trim();
        return {
          title,
          url,
          content,
          favicon,
          images: normalizeUrlList(result?.images, 4),
          score: typeof result?.score === "number" ? result.score : null,
          source: String(result?.source || "").trim(),
        };
      })
      .filter((result) => result.url || result.content);

    return {
      query: String(payload.query || response?.query || "").trim(),
      answer: String(payload.answer || response?.answer || response?.reply || "").trim(),
      images: normalizeUrlList(payload.images, 8),
      results: normalizedResults,
      sources: normalizeWebSearchSources(payload.sources),
    };
  }

  function renderWebSearchPanel(payload, answerText, thinkingText, renderOptions = {}) {
    const safePayload = {
      query: String(payload?.query || "").trim(),
      answer: String(payload?.answer || answerText || "").trim(),
      images: normalizeUrlList(payload?.images, 8),
      results: Array.isArray(payload?.results) ? payload.results : [],
      sources: normalizeWebSearchSources(payload?.sources),
    };

    const sourceCount = safePayload.results.length || safePayload.sources.length;
    const imageCount = safePayload.images.length;

    const panel = document.createElement("div");
    panel.className = "web-search-panel";

    const answerBlock = document.createElement("div");
    answerBlock.className = "web-search-answer";
    answerBlock.innerHTML = renderAssistantMessageHtml(
      safePayload.answer || "Search results are ready.",
      thinkingText,
      { ...renderOptions, mode: "web_search" }
    );
    wireThinkingPanels(answerBlock);
    wireCodeCopyButtons(answerBlock);
    panel.appendChild(answerBlock);

    const hasDetails = sourceCount > 0 || imageCount > 0;
    if (!hasDetails) {
      return panel;
    }

    const details = document.createElement("details");
    details.className = "web-search-details";
    details.addEventListener("toggle", () => {
      if (details.open) scrollToBottom(true);
    });

    const summary = document.createElement("summary");
    summary.className = "web-search-summary";
    const summaryParts = ["Search details"];
    if (sourceCount > 0) summaryParts.push(`${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`);
    if (imageCount > 0) summaryParts.push(`${imageCount} ${imageCount === 1 ? "image" : "images"}`);
    summary.textContent = summaryParts.join(" - ");
    details.appendChild(summary);

    const detailsBody = document.createElement("div");
    detailsBody.className = "web-search-details-body";

    if (sourceCount > 0) {
      const resultsWrap = document.createElement("div");
      resultsWrap.className = "web-search-results";

      const resultsLabel = document.createElement("div");
      resultsLabel.className = "web-search-section-label";
      resultsLabel.textContent = "Sources";
      resultsWrap.appendChild(resultsLabel);

      if (safePayload.results.length > 0) {
        safePayload.results.forEach((result) => {
          const resultImages = normalizeUrlList(result.images, 4);
          const card = document.createElement("div");
          card.className = "web-search-card";

          const header = document.createElement("div");
          header.className = "web-search-card-header";

          const faviconWrap = document.createElement("div");
          faviconWrap.className = "web-search-favicon";
          faviconWrap.textContent = (getHostLabel(result.url).charAt(0) || "?").toUpperCase();
          if (result.favicon) {
            const faviconImg = document.createElement("img");
            faviconImg.src = result.favicon;
            faviconImg.alt = "";
            faviconImg.loading = "lazy";
            faviconImg.addEventListener("error", () => {
              faviconImg.remove();
              faviconWrap.textContent = (getHostLabel(result.url).charAt(0) || "?").toUpperCase();
            });
            faviconWrap.textContent = "";
            faviconWrap.appendChild(faviconImg);
          }

          const headerText = document.createElement("div");
          headerText.className = "web-search-header-text";

          const titleLink = document.createElement("a");
          titleLink.className = "web-search-title";
          titleLink.href = result.url || "#";
          titleLink.target = "_blank";
          titleLink.rel = "noopener noreferrer";
          titleLink.textContent = result.title || "Untitled";

          const urlLine = document.createElement("div");
          urlLine.className = "web-search-url";
          urlLine.textContent = getHostLabel(result.url) || result.url;

          headerText.appendChild(titleLink);
          headerText.appendChild(urlLine);
          header.appendChild(faviconWrap);
          header.appendChild(headerText);
          card.appendChild(header);

          const preview = summarizeWebSearchContent(result.content);
          if (preview) {
            const contentDiv = document.createElement("div");
            contentDiv.className = "web-search-content";
            contentDiv.textContent = preview;
            card.appendChild(contentDiv);
          }

          if (resultImages.length > 0) {
            const imageRow = document.createElement("div");
            imageRow.className = "web-search-image-row";
            resultImages.forEach((url) => {
              imageRow.appendChild(createWebSearchImageTile(url, "Result image", "row"));
            });
            card.appendChild(imageRow);
          }

          resultsWrap.appendChild(card);
        });
      } else {
        const sourceList = document.createElement("div");
        sourceList.className = "web-search-source-fallback-list";
        safePayload.sources.forEach((source) => {
          sourceList.appendChild(createWebSearchSourceCard(source));
        });
        resultsWrap.appendChild(sourceList);
      }

      detailsBody.appendChild(resultsWrap);
    }

    if (imageCount > 0) {
      const galleryWrap = document.createElement("div");

      const galleryLabel = document.createElement("div");
      galleryLabel.className = "web-search-section-label";
      galleryLabel.textContent = "Top Images";
      galleryWrap.appendChild(galleryLabel);

      const gallery = document.createElement("div");
      gallery.className = "web-search-gallery";
      safePayload.images.forEach((url) => {
        gallery.appendChild(createWebSearchImageTile(url, "Search image", "gallery"));
      });
      galleryWrap.appendChild(gallery);
      detailsBody.appendChild(galleryWrap);
    }

    details.appendChild(detailsBody);
    panel.appendChild(details);
    return panel;
  }

  function buildChartError(message) {
    const error = document.createElement("div");
    error.className = "message-chart-error";
    error.textContent = message || "Chart failed to render.";
    return error;
  }

  function renderChartImage(container, meta) {
    const img = document.createElement("img");
    img.className = "message-chart-image";
    img.alt = meta.chartType || "Generated chart";
    img.loading = "lazy";
    img.src = meta.imageUrl || (meta.imageBase64.startsWith("data:") ? meta.imageBase64 : `data:image/png;base64,${meta.imageBase64}`);
    img.addEventListener("load", () => scrollToBottom(true));
    img.addEventListener("error", () => {
      img.replaceWith(buildChartError("Chart image failed to load."));
    });
    container.appendChild(img);
  }

  async function renderPlotlyChart(container, meta) {
    const frame = document.createElement("div");
    frame.className = "message-chart-frame";
    const mount = document.createElement("div");
    frame.appendChild(mount);
    container.appendChild(frame);

    try {
      await loadExternalScriptOnce("https://cdn.plot.ly/plotly-2.35.2.min.js", "Plotly");
      const spec = meta.plotlySpec || {};
      const layout = {
        autosize: true,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: getThemeColor("--text-primary", "#ececf1") },
        margin: { t: 32, r: 24, b: 48, l: 48 },
        ...(spec.layout || {}),
      };
      const config = {
        responsive: true,
        displayModeBar: false,
        ...(spec.config || {}),
      };
      await window.Plotly.newPlot(mount, spec.data || [], layout, config);
      scrollToBottom(true);
    } catch (error) {
      debugWarn(`[Chart] Plotly render failed: ${getSafeErrorMessage(error)}`);
      frame.replaceWith(buildChartError("Plotly chart failed to render."));
    }
  }

  function cloneChartConfig(config) {
    if (!config) return null;
    if (typeof structuredClone === "function") return structuredClone(config);
    return JSON.parse(JSON.stringify(config));
  }

  function applyChartJsTheme(config) {
    const themed = cloneChartConfig(config) || {};
    themed.options = themed.options || {};
    themed.options.responsive = true;
    themed.options.maintainAspectRatio = false;

    const textColor = getThemeColor("--text-secondary", "#9494a8");
    const gridColor = "rgba(255,255,255,0.08)";
    themed.options.plugins = themed.options.plugins || {};
    themed.options.plugins.legend = themed.options.plugins.legend || {};
    themed.options.plugins.legend.labels = themed.options.plugins.legend.labels || {};
    if (!themed.options.plugins.legend.labels.color) themed.options.plugins.legend.labels.color = textColor;
    themed.options.plugins.title = themed.options.plugins.title || {};
    if (themed.options.plugins.title.display && !themed.options.plugins.title.color) {
      themed.options.plugins.title.color = getThemeColor("--text-primary", "#ececf1");
    }

    if (themed.options.scales) {
      Object.keys(themed.options.scales).forEach((axisKey) => {
        const axis = themed.options.scales[axisKey] || {};
        axis.ticks = axis.ticks || {};
        axis.grid = axis.grid || {};
        axis.title = axis.title || {};
        if (!axis.ticks.color) axis.ticks.color = textColor;
        if (!axis.grid.color) axis.grid.color = gridColor;
        if (axis.title.display && !axis.title.color) axis.title.color = textColor;
        themed.options.scales[axisKey] = axis;
      });
    }

    return themed;
  }

  async function renderChartJs(container, meta) {
    const frame = document.createElement("div");
    frame.className = "message-chart-frame";
    const canvas = document.createElement("canvas");
    frame.appendChild(canvas);
    container.appendChild(frame);

    try {
      await loadExternalScriptOnce("https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js", "Chart");
      const config = applyChartJsTheme(meta.chartJsConfig);
      const ctx = canvas.getContext("2d");
      new window.Chart(ctx, config);
      scrollToBottom(true);
    } catch (error) {
      debugWarn(`[Chart] Chart.js render failed: ${getSafeErrorMessage(error)}`);
      frame.replaceWith(buildChartError("Chart.js chart failed to render."));
    }
  }

  function renderChartContent(container, meta) {
    container.innerHTML = "";
    container.className = "message-chart-container";

    if (!meta || meta.success === false) {
      container.appendChild(buildChartError(meta?.error || "Chart failed to render."));
      return;
    }

    if (meta.imageBase64 || meta.imageUrl) {
      renderChartImage(container, meta);
      return;
    }

    if (meta.renderer === "plotly" && meta.plotlySpec) {
      renderPlotlyChart(container, meta);
      return;
    }

    if (meta.renderer === "chartjs" && meta.chartJsConfig) {
      renderChartJs(container, meta);
      return;
    }

    if (meta.plotlySpec) {
      renderPlotlyChart(container, { ...meta, renderer: "plotly" });
      return;
    }

    if (meta.chartJsConfig) {
      renderChartJs(container, { ...meta, renderer: "chartjs" });
      return;
    }

    container.appendChild(buildChartError("Chart payload was received, but no renderable data was found."));
  }

  function renderClarificationContent(container, meta, chatId) {
    const payload = meta?.payload || meta || {};
    container.innerHTML = "";
    container.classList.add("clarification-panel-host");

    const panel = document.createElement("div");
    panel.className = "clarification-panel";

    const question = document.createElement("p");
    question.className = "clarification-question";
    question.textContent = payload.question || "Could you clarify what you need?";
    panel.appendChild(question);

    const options = Array.isArray(payload.options) ? payload.options : [];
    if (options.length > 0) {
      const optionList = document.createElement("div");
      optionList.className = "clarification-options";
      options.forEach((option) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "clarification-option-btn";
        const label = document.createElement("span");
        label.className = "clarification-option-label";
        label.textContent = option.label;
        btn.appendChild(label);
        if (option.description) {
          const desc = document.createElement("span");
          desc.className = "clarification-option-desc";
          desc.textContent = option.description;
          btn.appendChild(desc);
        }
        btn.addEventListener("click", () => {
          if (submitClarificationOption(chatId, payload.id, option)) {
            optionList.querySelectorAll("button").forEach((item) => { item.disabled = true; });
          }
        });
        optionList.appendChild(btn);
      });
      panel.appendChild(optionList);
    }

    const footer = document.createElement("div");
    footer.className = "clarification-footer";
    let hint = null;
    if (options.length > 0) {
      hint = document.createElement("span");
      hint.className = "clarification-custom-hint";
      hint.textContent = payload.custom_answer_prompt || "Or enter a custom answer in the message bar.";
      footer.appendChild(hint);
    }

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "clarification-cancel-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      clearPendingClarification(chatId);
      container.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      if (hint) {
        hint.textContent = "Clarification cancelled. Type a new message to continue.";
      } else {
        const cancelled = document.createElement("span");
        cancelled.className = "clarification-custom-hint";
        cancelled.textContent = "Clarification cancelled. Type a new message to continue.";
        footer.insertBefore(cancelled, cancel);
      }
    });
    footer.appendChild(cancel);
    panel.appendChild(footer);
    container.appendChild(panel);
  }

  async function getChatContextData(chatId) {
    if (isGuestSession()) {
      const chat = getGuestChat(chatId);
      const recentMessages = collapseAdjacentDuplicateChatMessages(chat?.messages || []);
      const memories = getGuestTopMemories(10, chatId);
      return {
        recentMessages: recentMessages.slice(-20).map((msg) => ({ role: msg.role, content: msg.content })),
        memories: memories.map((memory) => ({
          type: memory.type,
          summary: memory.summary,
          importance: memory.importance,
          embedding: memory.embedding,
          scope: normalizeMemoryScope(memory),
          chat_id: memory.chat_id || null,
        })),
      };
    }
    const chat = await Storage.getChat(chatId);
    const recentMessages = collapseAdjacentDuplicateChatMessages(chat?.messages || []);
    const memories = await Storage.getTopMemories(10, chatId);
    return {
      recentMessages: recentMessages.slice(-20).map((msg) => ({ role: msg.role, content: msg.content })),
      memories: memories.map((memory) => ({
        type: memory.type,
        summary: memory.summary,
        importance: memory.importance,
        embedding: memory.embedding,
        scope: normalizeMemoryScope(memory),
        chat_id: memory.chat_id || null,
      })),
    };
  }

  function buildScopedMemoryPayload(memory, chatId, syncMeta = null) {
    if (!memory?.summary) return null;
    const type = memory.type;
    const scope = memory.scope === "chat" ? "chat" : "global";
    return {
      id: memory.id,
      type,
      summary: memory.summary,
      importance: memory.importance,
      scope,
      chat_id: scope === "chat" ? (memory.chat_id || chatId) : null,
      persisted: memory.persisted === true,
      source_conversation_id: memory.source_conversation_id || chatId || null,
      source: memory.id ? "server" : "local",
      pending_server_sync: Boolean(syncMeta?.deferred && !memory.id),
    };
  }

  function getCurrentFileReferences() {
    if (!currentSessionFile || !currentSessionFile.extracted_text) return [];
    return [{
      filename: currentSessionFile.filename,
      extractedText: currentSessionFile.extracted_text,
    }];
  }

  function shouldReuseCurrentSessionImages(message) {
    if (!currentSessionImageAttachments.length) return false;
    return /\b(this|that|it|image|photo|picture|screenshot|attached|above|shown)\b/i.test(String(message || ""));
  }

  function getCurrentImageAttachments(message) {
    return shouldReuseCurrentSessionImages(message) ? currentSessionImageAttachments : [];
  }

  function normalizeClarificationPayload(response = {}) {
    const payload = response?.clarification || response?.intent_clarification || null;
    if (!payload || typeof payload !== "object") return null;
    const question = String(payload.question || "").trim();
    if (!question) return null;
    const options = Array.isArray(payload.options)
      ? payload.options
        .map((option, index) => ({
          id: String(option?.id || `option_${index + 1}`).trim() || `option_${index + 1}`,
          label: String(option?.label || "").trim(),
          description: String(option?.description || "").trim(),
        }))
        .filter((option) => option.label)
        .slice(0, 4)
      : [];
    return {
      id: String(payload.id || crypto.randomUUID()).trim(),
      original_message: String(payload.original_message || "").trim(),
      previous_answers: Array.isArray(payload.previous_answers)
        ? payload.previous_answers.map((answer) => String(answer || "").trim()).filter(Boolean).slice(0, 2)
        : [],
      question,
      options,
      allow_custom_answer: payload.allow_custom_answer !== false,
      custom_answer_prompt: String(payload.custom_answer_prompt || "Or enter a custom answer in the message bar.").trim(),
      turn: Number.isFinite(Number(payload.turn)) ? Number(payload.turn) : 1,
      max_turns: Number.isFinite(Number(payload.max_turns)) ? Number(payload.max_turns) : 2,
      source: payload.source === "fallback" ? "fallback" : "model",
    };
  }

  function cloneClarificationContext(context = {}) {
    return {
      recentMessages: Array.isArray(context.recentMessages) ? [...context.recentMessages] : [],
      memories: Array.isArray(context.memories) ? [...context.memories] : [],
      fileReferences: Array.isArray(context.fileReferences) ? context.fileReferences.map((item) => ({ ...item })) : [],
      imageAttachments: Array.isArray(context.imageAttachments) ? context.imageAttachments.map((item) => ({ ...item })) : [],
      webSearchMode: context.webSearchMode || null,
    };
  }

  function clearPendingClarification(chatId = currentChatId) {
    if (!chatId) return;
    pendingClarifications.delete(chatId);
    syncComposerHint();
  }

  function setPendingClarification(chatId, clarification, contextSnapshot) {
    if (!chatId || !clarification) return;
    const previous = pendingClarifications.get(chatId);
    pendingClarifications.set(chatId, {
      clarification,
      contextSnapshot: cloneClarificationContext(contextSnapshot || previous?.contextSnapshot || {}),
      answers: Array.isArray(clarification.previous_answers) ? [...clarification.previous_answers] : [],
      inFlight: false,
    });
    syncComposerHint();
  }

  function getPendingClarification(chatId = currentChatId) {
    return chatId ? pendingClarifications.get(chatId) || null : null;
  }

  function buildClarificationResponsePayload(state, answer, source, selectedOptionId = "") {
    const clarification = state?.clarification || {};
    const priorAnswers = Array.isArray(state?.answers) ? state.answers : [];
    const options = Array.isArray(clarification.options)
      ? clarification.options
        .map((option) => ({
          id: String(option?.id || "").trim(),
          label: String(option?.label || "").trim(),
          ...(option?.description ? { description: String(option.description).trim() } : {}),
        }))
        .filter((option) => option.id && option.label)
        .slice(0, 4)
      : [];
    return {
      clarification_id: clarification.id,
      original_message: clarification.original_message,
      question: clarification.question,
      options,
      answers: priorAnswers,
      source,
      ...(selectedOptionId ? { selected_option_id: selectedOptionId } : {}),
    };
  }

  function submitClarificationOption(chatId, clarificationId, option) {
    const state = getPendingClarification(chatId);
    if (!state || !option?.label) return false;
    if (clarificationId && state.clarification?.id !== clarificationId) return false;
    if (state.inFlight) return false;
    state.inFlight = true;
    handleSend(null, {
      message: option.label,
      clarificationResponse: buildClarificationResponsePayload(state, option.label, "option", option.id),
      clarificationContextSnapshot: state.contextSnapshot,
      skipPendingFileProcessing: true,
    }).finally(() => {
      const current = getPendingClarification(chatId);
      if (current === state) current.inFlight = false;
    });
    return true;
  }

  function getResponseTrustMeta() {
    return null;
  }

  function appendResponseTrustRow() {
    // Trust, route, provider, and model metadata are intentionally not rendered in chat.
  }

  async function deliverAssistantResponse(response, targetChatId, renderInView, renderOptions = {}) {
    const webSearchPayload = normalizeWebSearchPayload(response);
    const assistantText = webSearchPayload?.answer || response?.answer || response?.reply || "";
    const assistantThinking = typeof response?.thinking === "string" ? response.thinking : "";
    const responseTrust = getResponseTrustMeta(response);
    const effectiveRenderOptions = renderOptions?.mode
      ? renderOptions
      : (response?.route === "web_search" ? { mode: "web_search" } : {});
    if (renderInView) {
      hideActivityIndicator(targetChatId);
    }

    const clarificationPayload = normalizeClarificationPayload(response);
    if (response?.route === "clarification" && clarificationPayload) {
      const clarificationMeta = { type: "clarification", payload: clarificationPayload, chatId: targetChatId };
      setPendingClarification(targetChatId, clarificationPayload, renderOptions?.pendingClarificationContext);
      if (renderInView) {
        appendMessageBubble("assistant", assistantText, clarificationMeta, effectiveRenderOptions, {
          animateReveal: true,
        });
      }
      await persistChatMessage(targetChatId, "assistant", assistantText);
      return assistantText || clarificationPayload.question;
    }

    clearPendingClarification(targetChatId);

    const fileMeta = normalizeGeneratedFileMeta(response?.file || (response?.type === "file" ? response : null), { chatId: targetChatId });
    if (response?.route === "file_generation" && hasRenderableGeneratedFile(fileMeta)) {
      if (renderInView) {
        appendMessageBubble("assistant", assistantText, fileMeta, effectiveRenderOptions, {
          thinking: assistantThinking,
          animateReveal: true,
          responseTrust,
        });
      }
      cacheGeneratedFileFromMeta(fileMeta).catch(() => null);
      await persistChatMessage(targetChatId, "assistant", assistantText || `Generated ${fileMeta.file_name}.`, fileMeta);
      return assistantText || `Generated ${fileMeta.file_name}.`;
    }

    if (webSearchPayload) {
      const webSearchMeta = { type: "web_search", payload: webSearchPayload };
      if (renderInView) {
        appendMessageBubble(
          "assistant",
          assistantText,
          webSearchMeta,
          { ...effectiveRenderOptions, mode: "web_search" },
          { thinking: assistantThinking, animateReveal: true, responseTrust }
        );
      }
      await persistChatMessage(targetChatId, "assistant", assistantText, webSearchMeta);
      return assistantText || "Web search results are ready.";
    }
    const rawChartPayload = response?.chart || (response?.type === "chart" ? response : null);
    const chartMeta = normalizeChartMeta(rawChartPayload);
    if (hasRenderableChart(chartMeta)) {
      if (renderInView) appendMessageBubble("assistant", assistantText, chartMeta, effectiveRenderOptions, {
        thinking: assistantThinking,
        animateReveal: true,
        responseTrust,
      });
      await persistChatMessage(targetChatId, "assistant", assistantText, chartMeta);
      return assistantText || "Generated a chart.";
    }

    const rawImagePayload = response?.image || (response?.type === "image" ? response : null);
    const imageMeta = createImageMeta(rawImagePayload);
    if ((response?.route === "image_generation" && response?.image) || response?.type === "image") {
      if (imageMeta) {
        if (renderInView) appendMessageBubble("assistant", assistantText, imageMeta, effectiveRenderOptions, {
          thinking: assistantThinking,
          animateReveal: true,
          responseTrust,
        });
        await persistChatMessage(targetChatId, "assistant", assistantText, imageMeta);
        return assistantText || "Generated an image.";
      }

      const fallbackText = "Sorry, I couldn't generate that image. Please try again.";
      if (renderInView) {
        const { contentDiv: imgErrDiv } = appendMessageBubble("assistant", "");
        await typeMessage(fallbackText, imgErrDiv, effectiveRenderOptions);
      }
      await persistChatMessage(targetChatId, "assistant", fallbackText);
      return fallbackText;
    }

    if (renderInView) {
      const { contentDiv } = appendMessageBubble("assistant", "");
      await typeMessage(assistantText, contentDiv, effectiveRenderOptions, assistantThinking);
      appendResponseTrustRow(contentDiv, responseTrust);
    }
    await persistChatMessage(targetChatId, "assistant", assistantText);
    return assistantText;
  }

  function selectionFeatureEnabled() {
    // Desktop only: require wide screen and non-coarse primary pointer.
    // Allow touch-capable desktops (e.g., Windows laptops with touchscreen)
    // as long as the primary pointer is fine (mouse/trackpad).
    return window.innerWidth >= 768
      && !window.matchMedia("(pointer: coarse)").matches;
  }

  function findClosestMessageContent(node) {
    let current = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (current && current !== document.body) {
      if (current.classList?.contains("message-content")) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getRangeOffsetsWithin(container, range) {
    const startRange = document.createRange();
    startRange.selectNodeContents(container);
    startRange.setEnd(range.startContainer, range.startOffset);
    const start = normalizeTextForSelection(startRange.toString()).length;

    const contentRange = document.createRange();
    contentRange.selectNodeContents(container);
    contentRange.setStart(range.startContainer, range.startOffset);
    contentRange.setEnd(range.endContainer, range.endOffset);
    const end = start + normalizeTextForSelection(contentRange.toString()).length;

    return { start, end };
  }

  function buildSelectionLineMap(text) {
    const normalized = normalizeTextForSelection(text);
    const lines = normalized.split("\n");
    let cursor = 0;
    return lines.map((line) => {
      const entry = { text: line, start: cursor, end: cursor + line.length };
      cursor += line.length + 1;
      return entry;
    });
  }

  function lineIndexForOffset(lineMap, offset) {
    if (!lineMap.length) return 0;
    for (let index = 0; index < lineMap.length; index += 1) {
      if (offset <= lineMap[index].end) return index;
    }
    return lineMap.length - 1;
  }

  function collectContextLines(lineMap, startIndex, direction) {
    const lines = [];
    let index = startIndex + direction;
    while (index >= 0 && index < lineMap.length && lines.length < MAX_SELECTION_CONTEXT_LINES) {
      const lineText = lineMap[index].text.trim();
      if (lineText) {
        if (direction < 0) lines.unshift(lineText);
        else lines.push(lineText);
      }
      index += direction;
    }
    return lines;
  }

  function buildSelectionPayload(range, messageContent) {
    const selectedLines = normalizeTextForSelection(range.toString())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (selectedLines.length === 0 || selectedLines.length > MAX_SELECTION_LINES) return null;

    const fullText = normalizeTextForSelection(messageContent.innerText || messageContent.textContent || "");
    const lineMap = buildSelectionLineMap(fullText);
    const offsets = getRangeOffsetsWithin(messageContent, range);
    const startLineIndex = lineIndexForOffset(lineMap, offsets.start);
    const endLineIndex = lineIndexForOffset(lineMap, Math.max(offsets.start, offsets.end - 1));

    return {
      selected_text: selectedLines.join("\n"),
      context_before: collectContextLines(lineMap, startLineIndex, -1).join("\n"),
      context_after: collectContextLines(lineMap, endLineIndex, 1).join("\n"),
    };
  }

  function clearTextSelection() {
    const selection = window.getSelection();
    if (selection && typeof selection.removeAllRanges === "function") selection.removeAllRanges();
  }

  function ensureSelectionButton() {
    if (selectionButton) return selectionButton;

    selectionButton = document.createElement("button");
    selectionButton.id = SELECTION_BUTTON_ID;
    selectionButton.className = "selection-ask-button";
    selectionButton.type = "button";
    selectionButton.textContent = "Ask SentIQGPT";
    selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
    selectionButton.addEventListener("click", async () => {
      const payload = pendingSelectionPayload;
      hideSelectionButton();
      pendingSelectionPayload = null;
      clearTextSelection();
      if (payload) await handleSelectionAsk(payload);
    });
    document.body.appendChild(selectionButton);
    return selectionButton;
  }

  function showSelectionButton(rect) {
    if (!selectionFeatureEnabled() || !rect) return;
    const button = ensureSelectionButton();
    const width = button.offsetWidth || 148;
    let left = rect.left + (rect.width / 2) - (width / 2);
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.top - 48;
    if (top < 8) top = rect.bottom + 12;

    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.classList.add("visible");
  }

  function hideSelectionButton() {
    if (selectionButton) selectionButton.classList.remove("visible");
  }

  function handleSelectionChange() {
    if (!selectionFeatureEnabled()) {
      hideSelectionButton();
      pendingSelectionPayload = null;
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideSelectionButton();
      pendingSelectionPayload = null;
      return;
    }

    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;

    if (!chatMessages || !ancestor || !chatMessages.contains(ancestor)) {
      hideSelectionButton();
      pendingSelectionPayload = null;
      return;
    }

    const messageContent = findClosestMessageContent(range.startContainer) || findClosestMessageContent(ancestor);
    if (!messageContent) {
      hideSelectionButton();
      pendingSelectionPayload = null;
      return;
    }

    const payload = buildSelectionPayload(range, messageContent);
    if (!payload) {
      hideSelectionButton();
      pendingSelectionPayload = null;
      return;
    }

    pendingSelectionPayload = payload;
    showSelectionButton(range.getBoundingClientRect());
  }

  function initDesktopSelectionFeature() {
    // Only install selection-related listeners on desktop devices.
    // On mobile, these listeners (especially the resize → clearTextSelection path)
    // interfere with the virtual keyboard: removeAllRanges() during a focus/resize
    // event causes iOS Safari to blur the textarea and dismiss the keyboard.
    if (!selectionFeatureEnabled()) return;

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mousedown", (event) => {
      if (selectionButton && selectionButton.contains(event.target)) return;
      hideSelectionButton();
      pendingSelectionPayload = null;
    });
    window.addEventListener("resize", () => {
      if (!selectionFeatureEnabled()) {
        hideSelectionButton();
        pendingSelectionPayload = null;
        // Do NOT call clearTextSelection() here — on devices that transition
        // from desktop to mobile viewport (or during keyboard resize events),
        // removeAllRanges() can steal focus from the active input element.
      }
    });
    chatMessages?.addEventListener("scroll", () => {
      hideSelectionButton();
    }, { passive: true });
  }

  async function init() {
    debugLog("[UI] init: SentIQGPT Chat UI starting");
    const stopInitMeasure = startPerf("ui.init");
    setAuthView("login");
    setPasswordVisibility(false);
    window.addEventListener(PROFILE_NAME_REQUIRED_EVENT, () => {
      handleProfileNameRequired("api-event").catch((error) => {
        debugWarn(`[UI] Name gate handling failed: ${getSafeErrorMessage(error)}`);
      });
    });
    window.SentIQAuth?.subscribeAuthChanges?.((session) => {
      refreshAuthUI(session).catch((error) => {
        debugWarn(`[UI] Auth refresh failed: ${getSafeErrorMessage(error)}`);
      });
    });

    sendBtn?.addEventListener("click", (e) => {
      if (sendBtn.classList.contains("is-stop")) { abortCurrentGeneration(); }
      else {
        // Ripple micro-interaction
        const rect = sendBtn.getBoundingClientRect();
        sendBtn.style.setProperty("--ripple-x", ((e.clientX - rect.left) / rect.width * 100) + "%");
        sendBtn.style.setProperty("--ripple-y", ((e.clientY - rect.top) / rect.height * 100) + "%");
        sendBtn.classList.remove("ripple");
        void sendBtn.offsetWidth; // force reflow
        sendBtn.classList.add("ripple");
        setTimeout(() => sendBtn.classList.remove("ripple"), 500);
        handleSend();
      }
    });
    authLoginBtn?.addEventListener("click", () => openAuthModal("login"));
    authSignupBtn?.addEventListener("click", () => openAuthModal("signup"));
    const handleLogout = async () => {
      try {
        closeAuthMenu();
        await window.SentIQAuth?.signOut?.();
        await refreshAuthUI(null);
        await syncConversationStateForAuth(false);
        showToast("Logged out successfully.", "info");
      } catch (err) {
        showToast(err?.message || "Unable to log out right now.", "error");
      }
    };
    authLogoutBtn?.addEventListener("click", handleLogout);
    authMenuLogoutBtn?.addEventListener("click", handleLogout);
    authMenuToggle?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAuthMenu();
    });
    authCloseBtn?.addEventListener("click", closeAuthModal);
    authModal?.addEventListener("click", (e) => { if (e.target === authModal) closeAuthModal(); });
    authSwitchBtn?.addEventListener("click", () => openAuthModal(authView === "login" ? "signup" : "login"));
    authForgotBtn?.addEventListener("click", () => openAuthModal("forgot-password-request"));
    authPasswordToggle?.addEventListener("click", () => {
      if (!authPasswordInput) return;
      setPasswordVisibility(authPasswordInput.type === "password");
    });
    nameInput?.addEventListener("input", () => {
      if (nameStatus?.textContent) setNameStatus("");
    });
    nameForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const displayName = nameInput?.value || "";
      if (!displayName.trim()) {
        setNameStatus("Please enter your name.", "error");
        return;
      }
      if (nameSubmitBtn) nameSubmitBtn.disabled = true;
      setNameStatus("");
      try {
        const response = await API.updateProfile(displayName);
        const savedName = normalizeDisplayName(response?.profile?.display_name || displayName);
        authProfileState = {
          displayName: savedName,
          requiresName: false,
          fetchFailed: false,
          loaded: true,
          userId: getActiveAuthUserId(),
        };
        closeRequiredNameModal();
        if (authUserEmail) authUserEmail.textContent = getPreferredAccountLabel() || "Signed in";
        if (authMenuName) authMenuName.textContent = getPreferredAccountLabel() || "Signed in";
        if (authMenuEmail) authMenuEmail.textContent = authSessionState?.user?.email || "";
        setChatAccess(true);
        await syncConversationStateForAuth(true);
        showToast("Name saved.", "success", 2400);
        chatInput?.focus();
      } catch (error) {
        setNameStatus(error?.message || "Couldn't save your name right now.", "error");
      } finally {
        if (nameSubmitBtn) nameSubmitBtn.disabled = false;
      }
    });
    nameLogoutBtn?.addEventListener("click", async () => {
      try {
        await window.SentIQAuth?.signOut?.();
        await refreshAuthUI(null);
        await syncConversationStateForAuth(false);
      } catch (error) {
        setNameStatus(error?.message || "Couldn't switch accounts right now.", "error");
      }
    });
    authForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = authEmailInput?.value?.trim() || "";
      const password = authPasswordInput?.value || "";
      if (!email && !isPasswordRecoveryView()) {
        setAuthStatus("Email is required.", "error");
        return;
      }
      if (isPasswordAuthView() && !password) {
        setAuthStatus(isPasswordRecoveryView() ? "A new password is required." : "Email and password are required.", "error");
        return;
      }
      if (!window.SentIQAuth?.configured) {
        setAuthStatus("Supabase auth is not configured yet.", "error");
        return;
      }
      if (authSubmitBtn) authSubmitBtn.disabled = true;
      setAuthStatus("");
      try {
        if (authView === "signup") {
          const result = await window.SentIQAuth.signUp(email, password);
          if (result?.session) {
            await refreshAuthUI(result.session);
            await syncConversationStateForAuth(true);
            showToast("Account created successfully.", "success");
          } else {
            await refreshAuthUI(null);
            setAuthStatus("Check your email to verify your account, then sign in.", "success");
          }
        } else if (isPasswordResetRequestView()) {
          await window.SentIQAuth.resetPasswordForEmail(email);
          setAuthStatus("Check your email for reset link.", "success");
          showToast("Password reset email sent.", "success");
        } else if (isPasswordRecoveryView()) {
          await window.SentIQAuth.updatePassword(password);
          await refreshAuthUI();
          setAuthStatus("Password updated. You can continue securely now.", "success");
          showToast("Password updated successfully.", "success");
        } else {
          const result = await window.SentIQAuth.signInWithPassword(email, password);
          await refreshAuthUI(result?.session || null);
          await syncConversationStateForAuth(true);
          showToast("Logged in successfully.", "success");
          chatInput?.focus();
        }
      } catch (err) {
        setAuthStatus(err?.message || "Authentication failed.", "error");
      } finally {
        if (authSubmitBtn) authSubmitBtn.disabled = false;
      }
    });
    chatInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    chatInput?.addEventListener("paste", handleComposerPaste);
    chatInput?.addEventListener("input", autoResizeInput);
    newChatBtn?.addEventListener("click", startNewChat);
    chatSearchInput?.addEventListener("input", () => loadChatList(true));
    starterActions?.addEventListener("click", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("[data-starter-action]")
        : null;
      const action = target?.getAttribute("data-starter-action");
      if (action) handleStarterAction(action);
    });

    composerPlusBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      setComposerMenuOpen(!composerActionMenu?.classList.contains("open"));
    });
    fileAttachBtn?.addEventListener("click", () => {
      if (ensureNameCapture()) return;
      closeComposerMenu();
      fileInput?.click();
    });
    fileInput?.addEventListener("change", handleFileSelect);

    const updateComposerDropState = (state) => {
      if (!chatInputArea) return;
      chatInputArea.classList.toggle("drop-ready", state !== "idle");
      chatInputArea.classList.toggle("drop-over", state === "over");
    };

    // Drag-and-drop file upload on the chat area
    if (chatMessages) {
      chatMessages.addEventListener("dragover", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        chatMessages.classList.add("drop-active");
      });
      chatMessages.addEventListener("dragleave", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        chatMessages.classList.remove("drop-active");
      });
      chatMessages.addEventListener("drop", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        chatMessages.classList.remove("drop-active");
        queueDroppedFiles(e.dataTransfer?.files);
      });
    }

    // Drag-and-drop file upload on the composer input
    if (chatInputArea) {
      chatInputArea.addEventListener("dragenter", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        composerDragDepth += 1;
        closeComposerMenu();
        updateComposerDropState("ready");
      });
      chatInputArea.addEventListener("dragover", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        updateComposerDropState("over");
      });
      chatInputArea.addEventListener("dragleave", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        composerDragDepth = Math.max(0, composerDragDepth - 1);
        if (composerDragDepth === 0) updateComposerDropState("idle");
      });
      chatInputArea.addEventListener("drop", (e) => {
        if (!isFileDragEvent(e)) return;
        e.preventDefault();
        e.stopPropagation();
        composerDragDepth = 0;
        updateComposerDropState("idle");
        queueDroppedFiles(e.dataTransfer?.files);
      });
    }

    document.addEventListener("dragend", () => {
      if (chatMessages) chatMessages.classList.remove("drop-active");
      composerDragDepth = 0;
      updateComposerDropState("idle");
    });

    imageGenBtn?.addEventListener("click", () => {
      closeComposerMenu();
      toggleImageMode();
    });
    webSurfBasicBtn?.addEventListener("click", () => {
      setWebSearchModeOverride(webSearchModeOverride === "basic" ? null : "basic");
      closeComposerMenu();
    });
    cancelImageMode?.addEventListener("click", () => setImageMode(false));
    cancelWebSearchMode?.addEventListener("click", () => setWebSearchModeOverride(null));
    voiceBtn?.addEventListener("click", handleVoiceInput);

    settingsBtn?.addEventListener("click", openSettings);
    closeSettingsBtn?.addEventListener("click", closeSettings);
    settingsModal?.addEventListener("click", (e) => { if (e.target === settingsModal) closeSettings(); });

    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const tabName = tab.getAttribute("data-tab");
        document.querySelectorAll(".settings-tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".settings-tab-content").forEach((c) => c.classList.remove("active"));
        tab.classList.add("active");
        document.getElementById("settings-tab-" + tabName)?.classList.add("active");
      });
    });

    sidebarToggle?.addEventListener("click", toggleSidebar);
    document.addEventListener("keydown", (e) => {
      if (trapFocusInModal(e)) return;
      if (e.key !== "Escape") return;
      if (composerActionMenu?.classList.contains("open")) {
        closeComposerMenu();
        return;
      }
      if (authMenuOpen) {
        closeAuthMenu();
        return;
      }
      if (isModalVisible(settingsModal)) {
        closeSettings();
        return;
      }
      if (isModalVisible(nameModal)) {
        return;
      }
      if (isModalVisible(authModal)) {
        closeAuthModal();
        return;
      }
      if (isMobileSidebarViewport() && sidebar?.classList.contains("open")) {
        closeSidebar();
      }
    });
    window.addEventListener("resize", () => {
      closeComposerMenu();
      if (!isMobileAuthMenuViewport()) closeAuthMenu();
      if (!isMobileSidebarViewport()) {
        closeSidebar();
      } else {
        updateOverlayLocks();
      }
      syncComposerHint();
    }, { passive: true });
    window.addEventListener("online", () => {
      processSyncQueue().catch((error) => {
        logAuthenticatedConversationError("online.processSyncQueue", error);
      });
      if (isAuthenticatedSession() && !isNameCaptureRequired()) {
        syncRemoteChatListInBackground({ selectFirstIfEmpty: false }).catch((error) => {
          logAuthenticatedConversationError("online.remoteChatSync", error);
        });
        syncCloudMemoriesFromServer({ force: true, silent: true }).catch((error) => {
          logAuthenticatedConversationError("online.memorySync", error);
        });
      }
    });
    document.addEventListener("click", (event) => {
      if (
        composerActionMenu?.classList.contains("open") &&
        event.target instanceof Node &&
        !composerActionMenu.contains(event.target) &&
        !composerPlusBtn?.contains(event.target)
      ) {
        closeComposerMenu();
      }
      if (!authMenuOpen || !authActions) return;
      if (!(event.target instanceof Node) || !authActions.contains(event.target)) {
        closeAuthMenu();
      }
    });
    initMobileSidebarGestures();
    updateOverlayLocks();
    markPerf("ui.init.listeners_ready");

    // Apply initial image quota state
    updateImageButtonState();
    updateWebSearchButtons();
    syncComposerHint();
    refreshWelcomeCopy();
    initDesktopSelectionFeature();

    // Mobile keyboard: adjust layout when virtual keyboard opens/closes.
    // Use rAF to batch layout writes and avoid reflow-induced focus loss.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const inputWrap = document.querySelector(".chat-input-wrapper");
      let vvRaf = 0;
      vv.addEventListener("resize", () => {
        if (!inputWrap) return;
        if (vvRaf) return; // coalesce rapid resize events
        vvRaf = requestAnimationFrame(() => {
          vvRaf = 0;
          const keyboardHeight = window.innerHeight - vv.height;
          inputWrap.style.paddingBottom = keyboardHeight > 50 ? keyboardHeight + "px" : "";
        });
      });
    }

    try {
      await refreshAuthUI();
      await handleAuthReturnFlow();
      await syncConversationStateForAuth(isAuthenticatedSession());
      markPerf("ui.bootstrap.local_ready", { signed_in: isAuthenticatedSession() });
      stopInitMeasure("ok", { signed_in: isAuthenticatedSession() });
    } catch (error) {
      stopInitMeasure("error");
      throw error;
    }
  }

  function showWelcome() {
    if (welcomeScreen) welcomeScreen.style.display = "flex";
    if (chatMessages) chatMessages.classList.remove("has-messages");
    refreshWelcomeCopy();
    syncComposerHint();
  }
  function hideWelcome() {
    if (welcomeScreen) welcomeScreen.style.display = "none";
    if (chatMessages) chatMessages.classList.add("has-messages");
  }

  let _resizeRaf = 0;
  function autoResizeInput() {
    if (!chatInput) return;
    if (_resizeRaf) return; // coalesce rapid input events into one rAF
    _resizeRaf = requestAnimationFrame(() => {
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + "px";
      syncComposerHint();
      _resizeRaf = 0;
    });
  }

  // Debounced chat list reload to prevent rapid DOM rebuilds
  let _chatListTimer = 0;
  const MAX_CHAT_TITLE_LENGTH = 80;

  function normalizeChatTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_TITLE_LENGTH);
  }
  function loadChatList(preferCachedServer = false) {
    if (isAuthenticatedSession() && !preferCachedServer && pendingChatListLoad) {
      return pendingChatListLoad;
    }
    const loadPromise = new Promise((resolve) => {
      clearTimeout(_chatListTimer);
      _chatListTimer = setTimeout(async () => {
        const chats = await _loadChatListImpl(preferCachedServer);
        resolve(chats);
      }, 80);
    });
    if (isAuthenticatedSession() && !preferCachedServer) {
      pendingChatListLoad = loadPromise.finally(() => {
        if (pendingChatListLoad === loadPromise) {
          pendingChatListLoad = null;
        }
      });
      return pendingChatListLoad;
    }
    return loadPromise;
  }

  async function _loadChatListImpl(preferCachedServer = false) {
    if (!chatList) return;
    const stopMeasure = startPerf("ui.chat_list.render", {
      signed_in: isAuthenticatedSession(),
      cached: preferCachedServer,
    });
    if (isGuestSession()) {
      if (chatSearchInput) {
        chatSearchInput.value = "";
        chatSearchInput.style.display = "none";
      }
      chatList.innerHTML = '<div class="chat-list-empty">Log in to save your chats</div>';
      syncActiveChatItem();
      stopMeasure("ok", { chat_count: 0, guest: true });
      return [];
    }
    if (chatSearchInput) chatSearchInput.style.display = "";
    const chats = isAuthenticatedSession()
      ? (preferCachedServer ? await getCachedServerChats() : await fetchAuthenticatedChatList())
      : await Storage.getLocalChats();
    const searchTerm = String(chatSearchInput?.value || "").trim().toLowerCase();
    const visibleChats = searchTerm
      ? chats.filter((chat) => String(chat.title || "New Chat").toLowerCase().includes(searchTerm))
      : chats;
    chatList.innerHTML = "";
    for (const chat of visibleChats) {
      const item = document.createElement("div");
      item.className = "chat-list-item" + (chat.id === currentChatId ? " active" : "");
      item.setAttribute("data-id", chat.id);
      item.addEventListener("click", () => {
        if (item.classList.contains("is-renaming")) return;
        loadChat(chat.id);
        closeSidebar();
      });

      const title = document.createElement("span");
      title.className = "chat-list-item-title";
      title.textContent = chat.title || "New Chat";
      item.appendChild(title);

      const renameBtn = document.createElement("button");
      renameBtn.className = "chat-rename-btn";
      renameBtn.textContent = "Edit";
      renameBtn.title = "Rename chat";
      renameBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.classList.contains("is-renaming")) return;

        const originalTitleText = title.textContent || "New Chat";
        const normalizedOriginalTitle = normalizeChatTitle(originalTitleText);
        const input = document.createElement("input");
        input.type = "text";
        input.className = "chat-rename-input";
        input.value = originalTitleText;
        input.setAttribute("aria-label", "Rename chat");
        input.setAttribute("maxlength", String(MAX_CHAT_TITLE_LENGTH));
        input.addEventListener("click", (event) => event.stopPropagation());
        input.addEventListener("mousedown", (event) => event.stopPropagation());

        item.classList.add("is-renaming");
        item.insertBefore(input, renameBtn);

        let finalized = false;
        const finalizeRename = async (action) => {
          if (finalized) return;
          finalized = true;
          const nextValue = input.value;
          item.classList.remove("is-renaming");
          input.remove();

          if (action !== "save") {
            title.textContent = originalTitleText;
            return;
          }

          const normalizedTitle = normalizeChatTitle(nextValue);
          if (!normalizedTitle || normalizedTitle === normalizedOriginalTitle) {
            title.textContent = originalTitleText;
            return;
          }

          title.textContent = normalizedTitle;
          await Storage.updateChatTitle(chat.id, normalizedTitle, {
            bumpUpdated: false,
            pendingTitleSync: isAuthenticatedSession() && isServerBackedChat(chat),
            titleSyncError: null,
          });
          if (isAuthenticatedSession() && isServerBackedChat(chat) && !isPlaceholderServerChat(chat)) {
            try {
              await API.updateConversationTitle(chat.id, normalizedTitle);
              await Storage.updateChatTitle(chat.id, normalizedTitle, {
                pendingTitleSync: false,
                titleSyncError: null,
                lastTitleSyncedAt: new Date().toISOString(),
              });
            } catch (error) {
              await queueSyncJob(SYNC_JOB_TYPES.chatTitle, { conversationId: chat.id, title: normalizedTitle });
            }
          }
          if (currentChatId === chat.id) updateHtmlTitle(normalizedTitle);
          await loadChatList(true);
        };

        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void finalizeRename("save");
          } else if (event.key === "Escape") {
            event.preventDefault();
            void finalizeRename("cancel");
          }
        });
        input.addEventListener("blur", () => {
          void finalizeRename("save");
        });

        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      });
      item.appendChild(renameBtn);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "chat-delete-btn";
      deleteBtn.textContent = "\u00d7";
      deleteBtn.title = "Delete chat";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isAuthenticatedSession() && isServerBackedChat(chat) && !isPlaceholderServerChat(chat)) {
          await queueSyncJob(SYNC_JOB_TYPES.chatDelete, { conversationId: chat.id });
        }
        await Storage.deleteChat(chat.id);
        if (currentChatId === chat.id) {
          currentChatId = null;
          const remaining = isAuthenticatedSession()
            ? await getCachedServerChats()
            : await Storage.getLocalChats();
          if (remaining.length > 0) await loadChat(remaining[0].id);
          else { showWelcome(); if (chatMessages) chatMessages.innerHTML = ""; }
        }
        await loadChatList(true);
        processSyncQueue().catch((error) => {
          logAuthenticatedConversationError("chatDelete.sync", error);
        });
      });
      item.appendChild(deleteBtn);
      chatList.appendChild(item);
    }
    syncActiveChatItem();
    stopMeasure("ok", { chat_count: visibleChats.length });
    return visibleChats;
  }

  function renderLoadedChat(chatId, chat, options = {}) {
    if (!chat) return;
    const prevChatId = currentChatId;
    const switchedChats = Boolean(prevChatId && prevChatId !== chatId);
    if (switchedChats) {
      const oldState = getChatState(currentChatId);
      if (oldState) oldState.requestId = null;
      hideActivityIndicator(prevChatId);
    }

    const signature = getChatMessageSignature(chat);
    const previousSignature = chatRenderSignatures.get(chatId) || "";
    const incomingHasMessages = Array.isArray(chat.messages) && chat.messages.length > 0;
    const contentChanged = options.forceRender
      ? true
      : previousSignature !== signature || (incomingHasMessages && !chatMessages?.classList.contains("has-messages"));

    currentChatId = chatId;
    syncActiveChatItem();
    currentSessionFile = null;
    currentSessionImageAttachments = [];
    pendingClarifications.clear();
    _userScrolledUp = false;
    if (scrollAnchorPill) scrollAnchorPill.classList.remove("visible");
    if (chatMessages && shouldApplyChatTransition({ switchedChats, contentChanged })) {
      chatMessages.style.opacity = "0";
      chatMessages.style.transition = switchedChats ? "opacity 0.14s ease-out" : "opacity 0.1s ease-out";
    }
    const newState = getChatState(chatId);
    const domHasMessages = Boolean(chatMessages && chatMessages.querySelector(".message"));
    const shouldPreserveVisibleThread = !incomingHasMessages && Boolean(newState?.isThinking) && domHasMessages;

    if (incomingHasMessages) {
      hideWelcome();
      if (contentChanged || switchedChats || options.forceRender) {
        renderMessages(chat.messages);
      }
      chatRenderSignatures.set(chatId, signature);
    } else if (shouldPreserveVisibleThread) {
      hideWelcome();
      if (chatMessages) chatMessages.classList.add("has-messages");
      chatRenderSignatures.set(chatId, signature);
    } else {
      showWelcome();
      if (chatMessages) chatMessages.innerHTML = "";
      chatRenderSignatures.set(chatId, signature);
    }

    if (newState && newState.isThinking) {
      updateActivityIndicator(newState.activityMode || "thinking", {
        chatId,
        persist: false,
        withTimer: false,
        loaderKind: newState.activityLoaderKind || "loader-text",
      });
    } else {
      hideActivityIndicator(chatId);
    }
    requestAnimationFrame(() => {
      if (!chatMessages) return;
      chatMessages.style.opacity = "1";
      if (!shouldApplyChatTransition({ switchedChats, contentChanged })) {
        chatMessages.style.transition = "";
      }
    });
    updateHtmlTitle(chat.title && chat.title !== "New Chat" ? chat.title : "");
    syncActiveChatItem();
  }

  async function loadChat(chatId, options = {}) {
    const { skipRemoteHydration = false, silent = true } = options;
    debugLog("[UI] loadChat", { hasChat: Boolean(chatId) });
    const stopMeasure = startPerf("ui.chat.load", { chat_id: chatId });
    if (isGuestSession()) {
      const cachedChat = getGuestChat(chatId);
      if (cachedChat) {
        const cachedSignature = getChatMessageSignature(cachedChat);
        const priorSignature = chatRenderSignatures.get(chatId) || "";
        renderLoadedChat(chatId, cachedChat, {
          forceRender: priorSignature !== cachedSignature || currentChatId !== chatId,
        });
        stopMeasure("ok", {
          message_count: Array.isArray(cachedChat.messages) ? cachedChat.messages.length : 0,
          cached: true,
          guest: true,
        });
      } else {
        showWelcome();
        if (chatMessages) chatMessages.innerHTML = "";
        stopMeasure("ok", { message_count: 0, cached: false, guest: true });
      }
      return;
    }
    const cachedChat = await Storage.getChat(chatId);

    if (cachedChat) {
      const cachedSignature = getChatMessageSignature(cachedChat);
      const priorSignature = chatRenderSignatures.get(chatId) || "";
      renderLoadedChat(chatId, cachedChat, {
        forceRender: priorSignature !== cachedSignature || currentChatId !== chatId,
      });
      markPerf("ui.chat.load.local_ready", {
        chat_id: chatId,
        message_count: Array.isArray(cachedChat.messages) ? cachedChat.messages.length : 0,
      });
      stopMeasure("ok", { message_count: Array.isArray(cachedChat.messages) ? cachedChat.messages.length : 0, cached: true });
      if (isAuthenticatedSession() && !skipRemoteHydration && !isPlaceholderServerChat(cachedChat)) {
        fetchAuthenticatedChat(chatId, { silent })
          .then((remoteChat) => {
            if (!remoteChat || currentChatId !== chatId) return;
            const remoteSignature = getChatMessageSignature(remoteChat);
            const knownSignature = chatRenderSignatures.get(chatId) || "";
            if (remoteSignature !== knownSignature) {
              renderLoadedChat(chatId, remoteChat, { forceRender: true });
            }
            markPerf("ui.chat.load.remote_reconciled", {
              chat_id: chatId,
              message_count: Array.isArray(remoteChat.messages) ? remoteChat.messages.length : 0,
            });
          })
          .catch((error) => {
            logAuthenticatedConversationError("loadChat.remote", error);
          });
      }
      return;
    }

    if (!isAuthenticatedSession()) {
      stopMeasure("missing");
      return;
    }

    try {
      const remoteChat = await fetchAuthenticatedChat(chatId, { silent });
      if (!remoteChat) {
        stopMeasure("missing");
        return;
      }
      renderLoadedChat(chatId, remoteChat, { forceRender: true });
      markPerf("ui.chat.load.remote_reconciled", {
        chat_id: chatId,
        message_count: Array.isArray(remoteChat.messages) ? remoteChat.messages.length : 0,
      });
      stopMeasure("ok", { message_count: Array.isArray(remoteChat.messages) ? remoteChat.messages.length : 0, cached: false });
    } catch (error) {
      stopMeasure("error");
      logAuthenticatedConversationError("loadChat", error);
    }
  }

  const VISIBLE_MSG_LIMIT = 30;

  function renderMessages(messages) {
    if (!chatMessages) return;
    const visibleMessages = collapseAdjacentDuplicateChatMessages(messages);
    debugLog("[UI] renderMessages", { count: visibleMessages.length });
    chatMessages.style.scrollBehavior = 'auto';
    chatMessages.innerHTML = "";
    const total = visibleMessages.length;
    const startIdx = Math.max(0, total - VISIBLE_MSG_LIMIT);
    if (startIdx > 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "virt-placeholder";
      placeholder.textContent = `Show ${startIdx} older message${startIdx !== 1 ? "s" : ""}`;
      placeholder.addEventListener("click", () => {
        placeholder.remove();
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < startIdx; i++) {
          const msg = visibleMessages[i];
          const { bubble } = appendMessageBubble(msg.role, msg.content, msg.meta) || {};
          if (bubble) { bubble.classList.add("no-animate", "offscreen"); fragment.appendChild(bubble); }
        }
        chatMessages.insertBefore(fragment, chatMessages.firstChild);
      });
      chatMessages.appendChild(placeholder);
    }
    for (let i = startIdx; i < total; i++) {
      const msg = visibleMessages[i];
      const result = appendMessageBubble(msg.role, msg.content, msg.meta);
      // Skip animation for all but the last 2 messages loaded from history
      if (result?.bubble && i < total - 2) result.bubble.classList.add("no-animate");
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatMessages.style.scrollBehavior = 'smooth';
  }

  let thinkingPanelCounter = 0;

  function splitThinkBlocks(rawText) {
    const source = String(rawText || "");
    const lower = source.toLowerCase();
    const thinkOpen = "<think";
    const thinkClose = "</think>";
    let cursor = 0;
    let body = "";
    let hadThink = false;
    const thinkingParts = [];

    while (cursor < source.length) {
      const openIdx = lower.indexOf(thinkOpen, cursor);
      if (openIdx < 0) {
        body += source.slice(cursor);
        break;
      }

      hadThink = true;
      body += source.slice(cursor, openIdx);

      const openEnd = lower.indexOf(">", openIdx);
      if (openEnd < 0) {
        const malformed = source.slice(openIdx + thinkOpen.length).trim();
        if (malformed) thinkingParts.push(malformed);
        break;
      }

      const closeIdx = lower.indexOf(thinkClose, openEnd + 1);
      if (closeIdx < 0) {
        const tail = source.slice(openEnd + 1).trim();
        if (tail) thinkingParts.push(tail);
        break;
      }

      const segment = source.slice(openEnd + 1, closeIdx).trim();
      if (segment) thinkingParts.push(segment);
      cursor = closeIdx + thinkClose.length;
    }

    return {
      body: body.trim(),
      thinking: thinkingParts.join("\n\n").trim(),
      hadThink,
    };
  }

  function splitFinalAnswerSection(rawText) {
    const source = String(rawText || "");
    const marker = /(?:^|\n)\s*(?:#{1,6}\s*)?Final Answer\s*:?\s*/i.exec(source);
    if (!marker || typeof marker.index !== "number") {
      return {
        answer: source.trim(),
        markerFound: false,
      };
    }

    const markerEnd = marker.index + marker[0].length;
    return {
      answer: source.slice(markerEnd).trim(),
      markerFound: true,
    };
  }

  function looksLikeReasoningOnly(text) {
    const sample = String(text || "").trim().split(/\n+/)[0] || "";
    return /^(?:that means|alternatively|we can iterate|let(?:'|\s)?s|first,|next,|then,|analysis|reasoning|approach|plan)\b/i.test(sample);
  }

  function extractStructuredAnswerText(rawText) {
    const source = String(rawText || "").trim();
    if (!source || !/^\s*\{[\s\S]*\}\s*$/.test(source)) {
      return "";
    }

    try {
      const parsed = JSON.parse(source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "";
      }

      const candidate = parsed.final_answer || parsed.answer || parsed.reply;
      return typeof candidate === "string" ? candidate.trim() : "";
    } catch {
      return "";
    }
  }

  function beautifyAnswerText(rawText) {
    let normalized = String(rawText || "").trim();
    if (!normalized) return normalized;

    normalized = normalized
      .replace(/:\s+(?=1[\).]\s)/g, ":\n\n")
      .replace(/\s+(?=(?:[2-9]|1\d|2\d)[\).]\s)/g, "\n");

    return normalized.trim();
  }

  function normalizeAssistantPayload(answerText, thinkingText) {
    const answerSource = String(answerText || "");
    const explicitThinking = String(thinkingText || "").replace(/<\/?think[^>]*>/gi, "").trim();
    const structuredAnswer = extractStructuredAnswerText(answerSource);
    const shouldUseLegacyFallback =
      !structuredAnswer &&
      !explicitThinking &&
      /<think[\s>]|(?:^|\n)\s*(?:#{1,6}\s*)?Final Answer\s*:?\s*/i.test(answerSource);

    if (!shouldUseLegacyFallback) {
      const cleanAnswer = beautifyAnswerText(structuredAnswer || answerSource);
      return {
        answer: cleanAnswer || "Sorry, I couldn't generate a proper response. Please try again.",
        thinking: explicitThinking || "",
      };
    }
    const split = splitThinkBlocks(answerSource);
    const finalSplit = splitFinalAnswerSection(split.body);

    const mergedThinking = [explicitThinking, split.thinking]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    let cleanAnswer = finalSplit.answer || "";
    if (!cleanAnswer && !split.hadThink) {
      cleanAnswer = split.body;
    }
    if (split.hadThink && !finalSplit.markerFound && looksLikeReasoningOnly(cleanAnswer)) {
      cleanAnswer = "";
    }

    if (!cleanAnswer.trim()) {
      cleanAnswer = "Sorry, I couldn't generate a proper response. Please try again.";
    }

    return {
      answer: beautifyAnswerText(cleanAnswer),
      thinking: mergedThinking || "",
    };
  }

  function wireThinkingPanels(container) {
    if (!container) return;
    const toggles = container.querySelectorAll(".thinking-toggle");
    toggles.forEach((toggle) => {
      if (toggle.dataset.bound === "1") return;
      toggle.dataset.bound = "1";
      toggle.addEventListener("click", () => {
        const panel = toggle.closest(".thinking-panel");
        if (!panel) return;
        const content = panel.querySelector(".thinking-content");
        const expanded = panel.getAttribute("data-expanded") === "true";
        panel.setAttribute("data-expanded", expanded ? "false" : "true");
        toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
        if (content) content.hidden = expanded;
      });
    });
  }

  function renderAssistantMessageHtml(answerText, thinkingText, renderOptions = {}) {
    const normalized = normalizeAssistantPayload(answerText, thinkingText);
    const answerHtml = renderRichText(normalized.answer, renderOptions);
    if (!normalized.thinking) {
      return answerHtml;
    }

    thinkingPanelCounter += 1;
    const panelId = `thinking-panel-${thinkingPanelCounter}`;
    const thinkingHtml = renderRichText(normalized.thinking, renderOptions);

    return [
      `<div class="thinking-panel" data-expanded="false">`,
      `<button class="thinking-toggle" type="button" aria-expanded="false" aria-controls="${panelId}">`,
      `<span class="thinking-chevron">&#9654;</span>`,
      `<span>Show Thinking</span>`,
      `</button>`,
      `<div class="thinking-content" id="${panelId}" hidden>`,
      `${thinkingHtml}`,
      `</div>`,
      `</div>`,
      answerHtml,
    ].join("");
  }

  function appendMessageBubble(role, content, meta, renderOptions = {}, ephemeral = {}) {
    if (!chatMessages) return;
    const bubble = document.createElement("div");
    bubble.className = `message ${role}`;

    const header = document.createElement("div");
    header.className = "message-header";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? "Y" : "S";
    const sender = document.createElement("div");
    sender.className = "message-sender";
    sender.textContent = role === "user" ? "You" : "SentIQGPT";
    header.appendChild(avatar);
    header.appendChild(sender);
    bubble.appendChild(header);

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    const assistantThinking = role === "assistant" ? String(ephemeral?.thinking || "") : "";
    const animateReveal = role === "assistant" && Boolean(ephemeral?.animateReveal);
    if (animateReveal) {
      contentDiv.classList.add("sentiq-reveal-target");
      contentDiv.classList.remove("is-visible");
    }

    if (meta?.type === "image" && meta.imageUrl) {
      const label = document.createElement("div");
      label.className = "image-gen-label";
      label.innerHTML = "🎨 Generated Image";
      contentDiv.appendChild(label);

      const imgContainer = document.createElement("div");
      imgContainer.className = "message-image-container";
      const skeleton = document.createElement("div");
      skeleton.className = "image-skeleton";
      imgContainer.appendChild(skeleton);
      const img = document.createElement("img");
      img.className = "message-image";
      img.alt = meta.prompt || "Generated image";
      img.loading = "lazy";
      img.addEventListener("load", () => {
        skeleton.remove();
        img.classList.add("loaded");
      });
      img.addEventListener("error", () => {
        skeleton.remove();
        img.style.display = "none";
        const fallback = document.createElement("p");
        fallback.className = "image-load-error";
        fallback.textContent = "Image failed to load.";
        imgContainer.appendChild(fallback);
      });
      img.src = meta.imageUrl;
      imgContainer.appendChild(img);

      const actions = document.createElement("div");
      actions.className = "image-actions";
      const downloadBtn = document.createElement("a");
      downloadBtn.className = "image-download-btn";
      downloadBtn.href = meta.imageUrl;
      downloadBtn.download = `sentiqgpt-${Date.now()}.png`;
      downloadBtn.rel = "noopener";
      downloadBtn.textContent = "Download";
      downloadBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        try {
          await downloadImageDirect(meta.imageUrl, `sentiqgpt-${Date.now()}.png`, {
            fallbackToNewTab: true,
          });
        } catch (error) {
          debugWarn(`[UI] Image download failed: ${getSafeErrorMessage(error)}`);
          showToast("Couldn't download that image.", "error");
        }
      });
      actions.appendChild(downloadBtn);

      imgContainer.appendChild(actions);
      contentDiv.appendChild(imgContainer);

      if (content) {
        const caption = document.createElement("p");
        caption.textContent = content;
        contentDiv.appendChild(caption);
      }
    } else if (meta?.type === "generated-file") {
      renderGeneratedFileContent(contentDiv, meta);
    } else if (meta?.type === "chart") {
      if (content) {
        const textWrap = document.createElement("div");
        textWrap.innerHTML = role === "assistant"
          ? renderAssistantMessageHtml(content, assistantThinking, renderOptions)
          : renderRichText(content, renderOptions);
        if (role === "assistant") {
          wireThinkingPanels(textWrap);
        }
        wireCodeCopyButtons(textWrap);
        contentDiv.appendChild(textWrap);
      }
      const chartContainer = document.createElement("div");
      renderChartContent(chartContainer, meta);
      contentDiv.appendChild(chartContainer);
    } else if (meta?.type === "web_search") {
      const payload = meta.payload || {
        query: "",
        answer: content,
        images: [],
        results: [],
        sources: [],
        queriesUsed: null,
        provider: "",
      };
      const panel = renderWebSearchPanel(
        payload,
        content,
        assistantThinking,
        { ...renderOptions, mode: "web_search" }
      );
      contentDiv.appendChild(panel);
    } else if (meta?.type === "clarification") {
      renderClarificationContent(contentDiv, meta, meta.chatId || currentChatId);
    } else if (meta?.type === "image-upload") {
      const images = Array.isArray(meta.images) ? meta.images : [];
      for (const image of images) {
        const chip = document.createElement("div");
        chip.className = "message-file-chip";
        chip.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
        const nameSpan = document.createElement("span");
        nameSpan.textContent = image.filename || "Image";
        chip.appendChild(nameSpan);
        contentDiv.appendChild(chip);
      }
      if (content) {
        const desc = document.createElement("p");
        desc.textContent = content;
        contentDiv.appendChild(desc);
      }
    } else if (meta?.type === "file-upload") {
      const chip = document.createElement("div");
      chip.className = "message-file-chip";
      chip.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
      const nameSpan = document.createElement("span");
      nameSpan.textContent = meta.filename || "File";
      chip.appendChild(nameSpan);
      contentDiv.appendChild(chip);
      if (content) {
        const desc = document.createElement("p");
        desc.textContent = content;
        contentDiv.appendChild(desc);
      }
    } else {
      if (role === "assistant" && !String(content || "").trim() && !assistantThinking) {
        contentDiv.innerHTML = "";
      } else {
        contentDiv.innerHTML = role === "assistant"
          ? renderAssistantMessageHtml(content, assistantThinking, renderOptions)
          : renderRichText(content, renderOptions);
      }
      if (role === "assistant" && (assistantThinking || String(content || "").trim())) {
        wireThinkingPanels(contentDiv);
      }
    }
    wireCodeCopyButtons(contentDiv);

    if (role === "assistant" && ephemeral?.responseTrust) {
      appendResponseTrustRow(contentDiv, ephemeral.responseTrust);
    }

    bubble.appendChild(contentDiv);
    let actionBar = null;
    if (role === "assistant") {
      if (meta?.type === "image" && meta.imageUrl) {
        actionBar = attachAssistantActionBar(bubble, "", {
          isEnabled: () => Boolean(meta.imageUrl),
          copyHandler: async () => {
            const result = await copyImageToClipboard(meta.imageUrl, { allowUrlFallback: true });
            if (result?.mode === "url") {
              showToast("Image link copied to clipboard.", "info");
            }
          },
        });
      } else if (meta?.type !== "generated-file") {
        actionBar = attachAssistantActionBar(bubble, content || "");
      }
    }
    chatMessages.appendChild(bubble);
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
    if (animateReveal) {
      requestAnimationFrame(() => contentDiv.classList.add("is-visible"));
    }
    return { bubble, contentDiv, actionBar };
  }

  /**
   * Typing animation for non-streamed AI responses.
   * Progressively reveals rendered HTML content with a blinking cursor.
   */
  function typeMessage(text, contentDiv, renderOptions = {}, thinkingText = "") {
    return new Promise((resolve) => {
      const bubble = contentDiv?.closest(".message.assistant");
      if (bubble) setAssistantBubbleCopyText(bubble, text);
      const fullHtml = renderAssistantMessageHtml(text, thinkingText, renderOptions);
      let revealed = false;
      const revealContent = () => {
        if (revealed || !contentDiv) return;
        revealed = true;
        requestAnimationFrame(() => contentDiv.classList.add("is-visible"));
      };
      contentDiv.classList.add("sentiq-reveal-target");
      contentDiv.classList.remove("is-visible");
      if (!text || text.length < 3) {
        contentDiv.classList.remove("typing-active");
        contentDiv.innerHTML = fullHtml;
        wireThinkingPanels(contentDiv);
        wireCodeCopyButtons(contentDiv);
        if (bubble) setAssistantBubbleCopyText(bubble, text);
        revealContent();
        scrollToBottom();
        return resolve();
      }
      // Respect prefers-reduced-motion
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        contentDiv.classList.remove("typing-active");
        contentDiv.innerHTML = fullHtml;
        wireThinkingPanels(contentDiv);
        wireCodeCopyButtons(contentDiv);
        if (bubble) setAssistantBubbleCopyText(bubble, text);
        revealContent();
        scrollToBottom();
        return resolve();
      }
      contentDiv.classList.add("typing-active");
      contentDiv.innerHTML = '';
      const renderedDiv = document.createElement("div");
      renderedDiv.className = "streaming-rendered";
      const tailDiv = document.createElement("div");
      tailDiv.className = "streaming-tail";
      const tailTextNode = document.createTextNode("");
      tailDiv.appendChild(tailTextNode);
      contentDiv.appendChild(renderedDiv);
      contentDiv.appendChild(tailDiv);
      const progressiveRenderer = createProgressiveRichRenderer(renderedDiv, tailTextNode, {
        renderMode: renderOptions?.mode || null,
      });
      const len = text.length;
      let charIdx = 0;
      let frameCount = 0;
      const scrollEvery = 8;
      const charsPerFrame = Math.max(1, Math.min(3, Math.ceil(len / (len < 200 ? 120 : 200))));
      function step() {
        if (charIdx >= len) {
          contentDiv.classList.remove("typing-active");
          contentDiv.innerHTML = fullHtml;
          wireThinkingPanels(contentDiv);
          wireCodeCopyButtons(contentDiv);
          if (bubble) setAssistantBubbleCopyText(bubble, text);
          revealContent();
          scrollToBottom();
          return resolve();
        }
        charIdx = Math.min(charIdx + charsPerFrame, len);
        progressiveRenderer.render(text.substring(0, charIdx), false);
        if (charIdx > 0) revealContent();
        frameCount++;
        if (frameCount % scrollEvery === 0) scrollToBottom(true);
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // ================================================================
  // Lightweight Syntax Highlighter
  // ================================================================
  const SH_LANGS = {
    javascript: { kw: 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|super|switch|this|throw|try|typeof|var|void|while|with|yield', bi: 'console|window|document|Math|JSON|Promise|Array|Object|String|Number|Boolean|Map|Set|RegExp|Error|Date|parseInt|parseFloat|setTimeout|setInterval|clearTimeout|clearInterval|fetch|undefined|null|true|false|NaN|Infinity', tp: '' },
    typescript: { kw: 'async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|of|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|type|interface|enum|implements|namespace|abstract|declare|readonly|as|is|keyof|infer', bi: 'console|window|document|Math|JSON|Promise|Array|Object|String|Number|Boolean|Map|Set|RegExp|Error|Date|parseInt|parseFloat|setTimeout|setInterval|fetch|undefined|null|true|false|NaN|Infinity|any|unknown|never|void', tp: '' },
    python: { kw: 'and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield', bi: 'print|len|range|type|int|str|float|list|dict|set|tuple|bool|None|True|False|self|super|enumerate|zip|map|filter|sorted|open|input|isinstance|hasattr|getattr|setattr', tp: '' },
    java: { kw: 'abstract|assert|break|case|catch|class|continue|default|do|else|enum|extends|final|finally|for|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|void|volatile|while', bi: 'System|String|Integer|Boolean|Double|Float|Long|Object|List|Map|Set|ArrayList|HashMap|null|true|false', tp: '' },
    cpp: { kw: 'auto|break|case|catch|class|const|constexpr|continue|default|delete|do|else|enum|explicit|export|extern|for|friend|goto|if|inline|mutable|namespace|new|noexcept|operator|private|protected|public|register|return|sizeof|static|static_cast|struct|switch|template|this|throw|try|typedef|typeid|typename|union|using|virtual|void|volatile|while|override|final', bi: 'std|cout|cin|endl|vector|string|map|set|pair|nullptr|true|false|size_t|int|long|double|float|char|bool|unsigned', tp: '' },
    c: { kw: 'auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while', bi: 'printf|scanf|malloc|free|calloc|realloc|NULL|stdin|stdout|stderr|sizeof|true|false|size_t|FILE', tp: '' },
    go: { kw: 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var', bi: 'append|cap|close|copy|delete|error|len|make|new|nil|panic|print|println|recover|true|false|iota|string|int|float64|bool|byte|rune', tp: '' },
    rust: { kw: 'as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while|yield', bi: 'println!|print!|format!|vec!|String|Vec|Option|Result|Box|Rc|Arc|Some|None|Ok|Err|true|false|todo!|unimplemented!|panic!', tp: '' },
    html: { kw: '', bi: '', tp: '', special: 'html' },
    css: { kw: '', bi: '', tp: '', special: 'css' },
    json: { kw: '', bi: '', tp: '', special: 'json' },
    bash: { kw: 'if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|exit|local|export|source|alias|unalias', bi: 'echo|cd|ls|grep|awk|sed|cat|mkdir|rm|cp|mv|chmod|chown|find|xargs|curl|wget|git|npm|pip|apt|brew|sudo|true|false', tp: '' },
    markdown: { kw: '', bi: '', tp: '', special: 'md' },
    sql: { kw: 'SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INTO|VALUES|SET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|UNION|IN|EXISTS|BETWEEN|LIKE|IS|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|DEFAULT|CHECK|UNIQUE|VIEW|TRIGGER|BEGIN|END|COMMIT|ROLLBACK|GRANT|REVOKE', bi: 'COUNT|SUM|AVG|MIN|MAX|COALESCE|CAST|CONVERT|IFNULL|NOW|UPPER|LOWER|LENGTH|SUBSTRING|TRIM|REPLACE|CONCAT|TRUE|FALSE', tp: '' },
  };
  // Alias map
  SH_LANGS.js = SH_LANGS.javascript;
  SH_LANGS.ts = SH_LANGS.typescript;
  SH_LANGS.py = SH_LANGS.python;
  SH_LANGS.sh = SH_LANGS.bash;
  SH_LANGS.shell = SH_LANGS.bash;
  SH_LANGS.zsh = SH_LANGS.bash;
  SH_LANGS.rs = SH_LANGS.rust;
  SH_LANGS.jsx = SH_LANGS.javascript;
  SH_LANGS.tsx = SH_LANGS.typescript;
  SH_LANGS.htm = SH_LANGS.html;
  SH_LANGS.yml = SH_LANGS.bash;
  SH_LANGS.yaml = SH_LANGS.bash;
  SH_LANGS.toml = SH_LANGS.bash;
  SH_LANGS.xml = SH_LANGS.html;

  function highlightCode(code, lang) {
    const escaped = escapeHtml(code);
    const def = SH_LANGS[lang?.toLowerCase()];
    if (!def) return escaped;

    // Special handlers
    if (def.special === 'html' || def.special === 'xml') return highlightHTML(escaped);
    if (def.special === 'css') return highlightCSS(escaped);
    if (def.special === 'json') return highlightJSON(escaped);
    if (def.special === 'md') return escaped;

    let result = escaped;
    // Comments: // and # (for python/bash/etc)
    const lineComment = (lang === 'python' || lang === 'py' || lang === 'bash' || lang === 'sh' || lang === 'shell' || lang === 'zsh' || lang === 'yml' || lang === 'yaml' || lang === 'toml') ? '#' : '//';
    const hasBlockComment = !['python','py','bash','sh','shell','zsh','go','rust','rs','yml','yaml','toml'].includes(lang?.toLowerCase() || '');

    // Tokenize by lines to handle comment detection properly
    const tokens = [];
    let i = 0;
    while (i < result.length) {
      // Block comments /* */
      if (hasBlockComment && result.slice(i, i+4) === '/*') {
        const end = result.indexOf('*/', i + 2);
        const closeIdx = end === -1 ? result.length : end + 2;
        tokens.push('<span class="sh-cm">' + result.slice(i, closeIdx) + '</span>');
        i = closeIdx;
        continue;
      }
      // Line comments
      const lcEsc = escapeHtml(lineComment);
      if (result.slice(i, i + lcEsc.length) === lcEsc) {
        const nlIdx = result.indexOf('\n', i);
        const eol = nlIdx === -1 ? result.length : nlIdx;
        tokens.push('<span class="sh-cm">' + result.slice(i, eol) + '</span>');
        i = eol;
        continue;
      }
      // Strings (double and single quotes, backticks)
      if (result[i] === '&' && (result.slice(i, i+6) === '&quot;' || result.slice(i, i+5) === '&#39;')) {
        const isDouble = result.slice(i, i+6) === '&quot;';
        const delim = isDouble ? '&quot;' : '&#39;';
        const dLen = delim.length;
        let j = i + dLen;
        while (j < result.length) {
          if (result.slice(j, j + dLen) === delim) { j += dLen; break; }
          if (result[j] === '\\') { j += 2; continue; }
          j++;
        }
        tokens.push('<span class="sh-str">' + result.slice(i, j) + '</span>');
        i = j;
        continue;
      }
      if (result[i] === '`') {
        let j = i + 1;
        while (j < result.length && result[j] !== '`') { if (result[j] === '\\') j++; j++; }
        tokens.push('<span class="sh-str">' + result.slice(i, j + 1) + '</span>');
        i = j + 1;
        continue;
      }
      // Numbers
      if (/[0-9]/.test(result[i]) && (i === 0 || /[\s(,=+\-*\/:;&lt;&gt;\[\{!|]/.test(result[i-1]))) {
        let j = i;
        while (j < result.length && /[0-9a-fA-Fx._]/.test(result[j])) j++;
        tokens.push('<span class="sh-num">' + result.slice(i, j) + '</span>');
        i = j;
        continue;
      }
      // Words (identifiers / keywords)
      if (/[a-zA-Z_$@]/.test(result[i])) {
        let j = i;
        while (j < result.length && /[a-zA-Z0-9_$!]/.test(result[j])) j++;
        const word = result.slice(i, j);
        const kwRe = def.kw ? new RegExp('^(' + def.kw + ')$') : null;
        const biRe = def.bi ? new RegExp('^(' + def.bi + ')$') : null;
        // Check if followed by ( → function call
        const nextNonSpace = result.slice(j).match(/^\s*\(/);
        if (kwRe && kwRe.test(word)) {
          tokens.push('<span class="sh-kw">' + word + '</span>');
        } else if (biRe && biRe.test(word)) {
          tokens.push('<span class="sh-bi">' + word + '</span>');
        } else if (nextNonSpace && !kwRe?.test(word)) {
          tokens.push('<span class="sh-fn">' + word + '</span>');
        } else if (word[0] === '@') {
          tokens.push('<span class="sh-at">' + word + '</span>');
        } else {
          tokens.push(word);
        }
        i = j;
        continue;
      }
      // Operators
      if ('=+-*/<>&|!%^~?:'.includes(result[i]) || (result[i] === '&' && (result.slice(i,i+4)==='&lt;' || result.slice(i,i+4)==='&gt;' || result.slice(i,i+5)==='&amp;'))) {
        if (result.slice(i,i+4)==='&lt;') { tokens.push('<span class="sh-op">&lt;</span>'); i+=4; continue; }
        if (result.slice(i,i+4)==='&gt;') { tokens.push('<span class="sh-op">&gt;</span>'); i+=4; continue; }
        if (result.slice(i,i+5)==='&amp;') { tokens.push('<span class="sh-op">&amp;</span>'); i+=5; continue; }
        tokens.push('<span class="sh-op">' + result[i] + '</span>');
        i++;
        continue;
      }
      // Punctuation
      if ('(){}[];,.'.includes(result[i])) {
        tokens.push('<span class="sh-pn">' + result[i] + '</span>');
        i++;
        continue;
      }
      tokens.push(result[i]);
      i++;
    }
    return tokens.join('');
  }

  function highlightHTML(escaped) {
    // Tags
    let result = escaped.replace(/&lt;(\/?)(\w+)(.*?)(&gt;)/g, (m, slash, tag, attrs, close) => {
      const hAttrs = attrs.replace(/(\w[\w-]*)\s*=\s*(&quot;[^&]*&quot;|&#39;[^&]*&#39;)/g,
        (am, name, val) => '<span class="sh-at">' + name + '</span>=<span class="sh-str">' + val + '</span>');
      return '<span class="sh-pn">&lt;' + slash + '</span><span class="sh-tg">' + tag + '</span>' + hAttrs + '<span class="sh-pn">&gt;</span>';
    });
    // Comments
    result = result.replace(/&lt;!--(.*?)--&gt;/gs, '<span class="sh-cm">&lt;!--$1--&gt;</span>');
    return result;
  }

  function highlightCSS(escaped) {
    let result = escaped;
    // Comments
    result = result.replace(/\/\*[\s\S]*?\*\//g, m => '<span class="sh-cm">' + m + '</span>');
    // Selectors (lines ending with {)
    result = result.replace(/^([^{}\/\n]+)(\{)/gm, (m, sel, brace) => '<span class="sh-tg">' + sel + '</span><span class="sh-pn">' + brace + '</span>');
    // Properties
    result = result.replace(/(\s+)([\w-]+)(\s*:\s*)/g, (m, ws, prop, colon) => ws + '<span class="sh-at">' + prop + '</span>' + colon);
    // Strings
    result = result.replace(/(&quot;[^&]*&quot;|&#39;[^&]*&#39;)/g, '<span class="sh-str">$1</span>');
    // Numbers with units
    result = result.replace(/(\b\d+\.?\d*)(px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/g, '<span class="sh-num">$1$2</span>');
    return result;
  }

  function highlightJSON(escaped) {
    let result = escaped;
    // Keys
    result = result.replace(/(&quot;)((?:(?!&quot;).)*)(&quot;)(\s*:)/g,
      '<span class="sh-key">$1$2$3</span>$4');
    // String values
    result = result.replace(/(:\s*)(&quot;)((?:(?!&quot;).)*)(&quot;)/g,
      '$1<span class="sh-str">$2$3$4</span>');
    // Numbers
    result = result.replace(/(:\s*)(\d+\.?\d*)/g, '$1<span class="sh-num">$2</span>');
    // Booleans & null
    result = result.replace(/\b(true|false|null)\b/g, '<span class="sh-kw">$1</span>');
    return result;
  }

  // ================================================================
  // Markdown Rendering (marked.js + KaTeX + GFM)
  // ================================================================

  // Maximum message size before truncation (prevents DOM explosion)
  const MAX_RENDER_CHARS = 100000;

  // Configure marked.js with GFM + custom code renderer
  (function initMarked() {
    if (typeof marked === 'undefined') { debugWarn('[SentIQ] marked.js not loaded'); return; }
    marked.setOptions({ gfm: true, breaks: true });
    const renderer = new marked.Renderer();
    renderer.code = function({ text, lang }) {
      const language = lang || 'code';
      const langLabel = escapeHtml(language);
      const highlighted = highlightCode(text, language);
      return '<div class="code-block-wrap"><div class="code-block-header"><span class="code-block-lang">'
        + langLabel
        + '</span><button class="code-copy-btn" type="button" data-code-copy="true" aria-label="Copy code"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy</button></div><pre><code>'
        + highlighted
        + '</code></pre></div>';
    };
    marked.use({ renderer });
  })();

  /**
   * Render message text to rich HTML.
   * Pipeline: truncate → extract math → marked.parse (GFM) → restore math via KaTeX → error boundary.
   * If anything fails, falls back to escaped plain text.
   */
  function normalizeWebSearchText(text) {
    let normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!normalized) return normalized;

    const protectedSegments = [];
    function stashProtected(match) {
      const token = `\u0000WS${protectedSegments.length}\u0000`;
      protectedSegments.push(match);
      return token;
    }
    function restoreProtected(value) {
      return value.replace(/\u0000WS(\d+)\u0000/g, (_, index) => protectedSegments[Number(index)] || "");
    }

    normalized = normalized
      .replace(/```[\s\S]*?```/g, stashProtected)
      .replace(/`[^`\n]+`/g, stashProtected)
      .replace(/\$\$[\s\S]+?\$\$/g, stashProtected)
      .replace(/\\\[[\s\S]+?\\\]/g, stashProtected)
      .replace(/\\\([\s\S]+?\\\)/g, stashProtected);

    normalized = normalized
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\b(?:web summary title|summary title|page title|title)\s*:\s*/gi, "")
      .replace(/[^\S\n]{2,}/g, " ");

    normalized = normalized
      .replace(/([^\n])\s+(#{1,6}\s+)/g, "$1\n\n$2")
      .replace(/([^\n])\s+(\*\*Sources:\*\*|Sources:)/gi, "$1\n\n$2")
      .replace(/([^\n])\s+(_(?:This|Note:)[^_\n]*_)/gi, "$1\n\n$2")
      .replace(/\b((?:Key Findings?|Highlights?|Takeaways?|Sources))\s+-\s+/gi, "$1\n- ")
      .replace(/([:.;!?])\s+(-\s+(?=(?:\*\*|\[[^\]]+\]|\w)))/g, "$1\n$2")
      .replace(/([^\n])\s+((?:[1-9]|1\d|2\d)\.\s+(?=(?:\*\*|\[[^\]]+\]|\w)))/g, "$1\n$2");

    normalized = normalized
      .replace(/(?:\*\*Sources:\*\*|Sources:)\s*/i, "**Sources:**\n")
      .replace(/(\*\*Sources:\*\*\n)([^\n])/i, "$1$2")
      .replace(/([^\n])\s+((?:[1-9]|1\d|2\d)\.\s+\[[^\]]+\]\([^)]+\))/g, "$1\n$2")
      .replace(/([^\n])\s+((?:[1-9]|1\d|2\d)\.\s+[^\n]+)/g, "$1\n$2");

    normalized = normalized
      .replace(/(Here's what I found[^:\n]*:)\s*(?=(?:[1-9]|1\d|2\d)\.)/i, "$1\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return restoreProtected(normalized);
  }

  function renderMarkdownOnlyFallback(text) {
    if (!window.__sentiqRendererMissingWarned) {
      debugWarn("[SentIQRenderer] Rich renderer unavailable; using sanitized Markdown-only fallback.");
      window.__sentiqRendererMissingWarned = "1";
    }

    let fallbackText = String(text || "");
    let fallbackTruncated = false;
    if (fallbackText.length > MAX_RENDER_CHARS) {
      fallbackText = fallbackText.substring(0, MAX_RENDER_CHARS);
      fallbackTruncated = true;
    }

    fallbackText = fallbackText
      .replace(/\[?\s*SENTIQMATHBLOCKTOKEN\d+END\s*\]?/g, "")
      .replace(/\[?\s*@@SENTIQ_MATH_\d+@@\s*\]?/g, "")
      .replace(/@@\s*SENTIQ(?:\s|<[^>]+>)*ATH(?:\s|<[^>]+>|[A-Za-z0-9])*?@@/g, "")
      .replace(/\bMATH\d+\b/g, "")
      .replace(/[ \t]{2,}/g, " ");

    let fallbackHtml = window.marked?.parse
      ? window.marked.parse(fallbackText)
      : `<div class="render-error-fallback">${escapeHtml(fallbackText)}</div>`;
    fallbackHtml = sanitizeRenderedHtml(fallbackHtml);

    if (fallbackTruncated) {
      fallbackHtml += '<div class="truncation-notice">[Message truncated - original exceeded 100k characters]</div>';
    }
    return fallbackHtml;
  }

  function renderRichText(text, options = {}) {
    if (!text) return "";
    try {
      if (options.mode === "web_search") {
        text = normalizeWebSearchText(text);
      }
      if (window.SentIQRenderer?.renderRichText) {
        return window.SentIQRenderer.renderRichText(text, {
          ...options,
          maxRenderChars: MAX_RENDER_CHARS,
        });
      }

      return renderMarkdownOnlyFallback(text);


    } catch (renderErr) {
      // ERROR BOUNDARY: if anything in the pipeline fails, fall back to plain text
        debugWarn(`[SentIQ] renderRichText failed, falling back to plain text: ${getSafeErrorMessage(renderErr)}`);
      return '<div class="render-error-fallback">' + escapeHtml(String(text)) + '</div>';
    }
  }

  function escapeHtml(str) {
    if (window.SentIQRenderer?.escapeHtml) {
      return window.SentIQRenderer.escapeHtml(str);
    }
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function sanitizeRenderedHtml(html) {
    if (window.SentIQRenderer?.sanitizeRenderedHtml) {
      return window.SentIQRenderer.sanitizeRenderedHtml(html);
    }
    const template = document.createElement("template");
    template.innerHTML = String(html || "");

    const blockedTags = new Set(["script", "style", "iframe", "object", "embed", "form", "input"]);
    const treeWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
    const elements = [];
    while (treeWalker.nextNode()) {
      elements.push(treeWalker.currentNode);
    }

    for (const element of elements) {
      const tagName = element.tagName.toLowerCase();
      if (blockedTags.has(tagName)) {
        element.remove();
        continue;
      }

      for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();

        if (name.startsWith("on") || name === "srcdoc" || name === "style") {
          element.removeAttribute(attr.name);
          continue;
        }

        if (name === "href" || name === "src") {
          const lowerValue = value.toLowerCase();
          const isSafeDataImage = tagName === "img" && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(value);
          const isSafeUrl = /^(https?:|mailto:|#|\/)/i.test(value) || isSafeDataImage;
          if (!isSafeUrl || lowerValue.startsWith("javascript:") || lowerValue.startsWith("data:text/html")) {
            element.removeAttribute(attr.name);
            continue;
          }
        }
      }

      if (tagName === "a") {
        element.setAttribute("rel", "noopener noreferrer");
        if (!element.getAttribute("target")) {
          element.setAttribute("target", "_blank");
        }
      }
    }

    return template.innerHTML;
  }

  function writeClipboardText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      try {
        const temp = document.createElement("textarea");
        temp.value = text;
        temp.setAttribute("readonly", "");
        temp.style.position = "fixed";
        temp.style.opacity = "0";
        temp.style.pointerEvents = "none";
        document.body.appendChild(temp);
        temp.select();
        temp.setSelectionRange(0, temp.value.length);
        const copied = document.execCommand("copy");
        temp.remove();
        if (copied) resolve();
        else reject(new Error("Copy command failed."));
      } catch (err) {
        reject(err);
      }
    });
  }

  function resolveImageBlob(imageUrl) {
    if (!imageUrl) return Promise.reject(new Error("Missing image URL."));
    const url = String(imageUrl).trim();
    const isDataUrl = url.startsWith("data:");
    const options = isDataUrl ? {} : { mode: "cors", credentials: "include" };
    return fetch(url, options).then((response) => {
      if (!response.ok) throw new Error(`Image fetch failed (${response.status}).`);
      return response.blob();
    });
  }

  async function downloadImageDirect(imageUrl, filename, options = {}) {
    const { fallbackToNewTab = false } = options || {};
    const safeName = filename && String(filename).trim()
      ? String(filename).trim()
      : `sentiqgpt-${Date.now()}.png`;
    try {
      const blob = await resolveImageBlob(imageUrl);
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = safeName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      return { mode: "blob" };
    } catch (error) {
      if (fallbackToNewTab) {
        window.open(String(imageUrl), "_blank", "noopener");
        return { mode: "tab", error };
      }
      throw error;
    }
  }

  function getGeneratedFileDownloadName(input) {
    const rawName = typeof input === "object" && input
      ? String(input.file_name || input.fileName || "").trim()
      : "";
    if (rawName) {
      const safeName = rawName.split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1F]/g, "-").trim();
      if (safeName) return safeName.slice(0, 160);
    }
    const rawFormat = typeof input === "string"
      ? input
      : typeof input === "object" && input
        ? (input.format || input.file_format || input.fileFormat)
        : "";
    const format = ["html", "txt", "xlsx", "pptx", "docx", "pdf"].includes(String(rawFormat || "").toLowerCase())
      ? String(rawFormat).toLowerCase()
      : "txt";
    return `doc.${format}`;
  }

  function getGeneratedFileMimeType(format) {
    switch (format) {
      case "html": return "text/html";
      case "txt": return "text/plain";
      case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case "pdf": return "application/pdf";
      default: return "application/octet-stream";
    }
  }

  function normalizeGeneratedFileMeta(payload, extra = {}) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.success === false) return null;
    const rawFormat = String(payload.format || payload.file_format || payload.fileFormat || "").toLowerCase();
    const format = ["html", "txt", "xlsx", "pptx", "docx", "pdf"].includes(rawFormat) ? rawFormat : null;
    if (!format) return null;
    const preview = payload.preview || payload.preview_json || payload.previewJson || {};
    const fileName = getGeneratedFileDownloadName(payload.file_name || payload.fileName ? payload : format);
    const fileUrl = payload.file_url || payload.fileUrl || "";
    const storagePath = payload.storage_path || payload.storagePath || "";
    const id = String(payload.file_id || payload.fileId || payload.generated_file_id || payload.generatedFileId || payload.id || storagePath || fileUrl || `${format}-${Date.now()}`);
    return {
      type: "generated-file",
      id,
      file_id: payload.file_id || payload.fileId || payload.generated_file_id || payload.generatedFileId || id,
      format,
      file_name: fileName,
      mime_type: payload.mime_type || payload.mimeType || getGeneratedFileMimeType(format),
      file_url: fileUrl,
      storage_path: storagePath,
      storage_bucket: payload.storage_bucket || payload.storageBucket || "",
      file_size_bytes: payload.file_size_bytes || payload.fileSizeBytes || null,
      content_sha256: payload.content_sha256 || payload.contentSha256 || "",
      version: payload.version || 1,
      preview,
      html: payload.html || preview.html || "",
      text: payload.text || preview.text || "",
      model_used: payload.model_used || payload.modelUsed || payload.provider || "",
      fallback: Boolean(payload.fallback),
      fallback_reason: payload.fallback_reason || payload.fallbackReason || "",
      chat_id: extra.chatId || payload.chat_id || payload.chatId || null,
      created_at: payload.created_at || payload.createdAt || new Date().toISOString(),
      updated_at: payload.updated_at || payload.updatedAt || null,
    };
  }

  function hasRenderableGeneratedFile(meta) {
    return Boolean(meta?.type === "generated-file" && meta.format && (meta.file_url || meta.html || meta.text || meta.preview));
  }

  function createGeneratedFileBlob(meta) {
    if (!meta) return null;
    if (meta.blob instanceof Blob) return meta.blob;
    if (meta.format === "html" && meta.html) {
      return new Blob([meta.html], { type: meta.mime_type || getGeneratedFileMimeType("html") });
    }
    if (meta.format === "txt" && meta.text) {
      return new Blob([meta.text], { type: meta.mime_type || getGeneratedFileMimeType("txt") });
    }
    return null;
  }

  async function fetchGeneratedFileBlob(meta) {
    const accessUrl = await resolveGeneratedFileAccessUrl(meta, "download");
    if (!accessUrl) return null;
    const response = await fetch(accessUrl, { mode: "cors" });
    if (!response.ok) throw new Error(`File fetch failed (${response.status}).`);
    return response.blob();
  }

  function isLegacyGeneratedFileUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
  }

  async function resolveGeneratedFileAccessUrl(meta, mode = "download") {
    const normalized = normalizeGeneratedFileMeta(meta);
    const fileId = normalized?.file_id || normalized?.id;
    if (fileId && API.getGeneratedFileAccessUrl && !isLegacyGeneratedFileUrl(normalized.file_url)) {
      try {
        const response = await API.getGeneratedFileAccessUrl(fileId, mode);
        if (response?.url) return response.url;
      } catch (error) {
        debugWarn(`[UI] Signed generated file URL failed: ${getSafeErrorMessage(error)}`);
      }
    }
    if (fileId && API.getGeneratedFileAccessUrl && normalized.storage_path) {
      try {
        const response = await API.getGeneratedFileAccessUrl(fileId, mode);
        if (response?.url) return response.url;
      } catch (error) {
        debugWarn(`[UI] Signed generated file URL failed: ${getSafeErrorMessage(error)}`);
      }
    }
    return normalized?.file_url || "";
  }

  function isGeneratedFileCacheFresh(cached, normalized) {
    if (!cached || !normalized) return false;
    const serverVersion = Number(normalized.version || 0);
    const cachedVersion = Number(cached.version || 0);
    if (serverVersion && cachedVersion && serverVersion !== cachedVersion) return false;
    const serverHash = String(normalized.content_sha256 || "");
    const cachedHash = String(cached.content_sha256 || cached.contentSha256 || "");
    if (serverHash && cachedHash && serverHash !== cachedHash) return false;
    if (serverVersion && !cachedVersion) return false;
    if (serverHash && !cachedHash) return false;
    return true;
  }

  async function cacheGeneratedFileFromMeta(meta, blobOverride = null) {
    const normalized = normalizeGeneratedFileMeta(meta);
    if (!normalized?.id) return null;
    let blob = blobOverride instanceof Blob ? blobOverride : createGeneratedFileBlob(normalized);
    if (!blob && (normalized.file_url || normalized.file_id || normalized.storage_path)) {
      try {
        blob = await fetchGeneratedFileBlob(normalized);
      } catch (error) {
        debugWarn(`[UI] Generated file cache fetch failed: ${getSafeErrorMessage(error)}`);
      }
    }
    if (!blob) return null;
    return Storage.storeGeneratedFile({
      id: normalized.id,
      file_id: normalized.file_id,
      format: normalized.format,
      file_name: normalized.file_name || getGeneratedFileDownloadName(normalized.format),
      mime_type: normalized.mime_type,
      file_url: normalized.file_url,
      storage_path: normalized.storage_path,
      storage_bucket: normalized.storage_bucket,
      file_size_bytes: normalized.file_size_bytes || blob.size,
      content_sha256: normalized.content_sha256,
      version: normalized.version,
      preview: normalized.preview,
      chat_id: normalized.chat_id || currentChatId || null,
      created_at: normalized.created_at,
      updated_at: normalized.updated_at,
      blob,
    });
  }

  async function resolveGeneratedFileBlob(meta) {
    const normalized = normalizeGeneratedFileMeta(meta);
    if (!normalized?.id) return null;
    const cached = await Storage.getGeneratedFile(normalized.id).catch(() => null);
    if (cached?.blob instanceof Blob && isGeneratedFileCacheFresh(cached, normalized)) return cached.blob;
    if (cached?.blob instanceof Blob && !isGeneratedFileCacheFresh(cached, normalized)) {
      Storage.deleteGeneratedFile(normalized.id).catch(() => null);
    }
    const localBlob = createGeneratedFileBlob(normalized);
    if (localBlob) {
      await cacheGeneratedFileFromMeta(normalized, localBlob).catch(() => null);
      return localBlob;
    }
    if (normalized.file_url || normalized.file_id || normalized.storage_path) {
      const remoteBlob = await fetchGeneratedFileBlob(normalized);
      await cacheGeneratedFileFromMeta(normalized, remoteBlob).catch(() => null);
      return remoteBlob;
    }
    return null;
  }

  function triggerBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }

  async function downloadGeneratedFile(meta) {
    const normalized = normalizeGeneratedFileMeta(meta);
    if (!normalized) throw new Error("Missing generated file metadata.");
    const filename = normalized.file_name || getGeneratedFileDownloadName(normalized.format);
    try {
      const blob = await resolveGeneratedFileBlob(normalized);
      if (blob) {
        triggerBlobDownload(blob, filename);
        return;
      }
    } catch (error) {
      debugWarn(`[UI] Generated file blob download failed: ${getSafeErrorMessage(error)}`);
    }
    if (normalized.file_url || normalized.file_id || normalized.storage_path) {
      const href = await resolveGeneratedFileAccessUrl(normalized, "download");
      if (!href) throw new Error("Generated file is not available for download.");
      const link = document.createElement("a");
      link.href = href;
      link.download = filename;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      return;
    }
    throw new Error("Generated file is not available for download.");
  }

  function setArtifactButtonState(button, enabled) {
    if (!button) return;
    button.disabled = !enabled;
    button.classList.toggle("is-disabled", !enabled);
  }

  function createArtifactButton(label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "generated-file-action";
    button.textContent = label;
    return button;
  }

  function renderGeneratedFileContent(container, metaInput, options = {}) {
    const meta = normalizeGeneratedFileMeta(metaInput, options);
    if (!container || !meta) return null;
    container.innerHTML = "";

    const panel = document.createElement("div");
    panel.className = `generated-file-panel format-${meta.format}`;
    const header = document.createElement("div");
    header.className = "generated-file-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "generated-file-title-wrap";
    const icon = document.createElement("span");
    icon.className = "generated-file-icon";
    icon.textContent = meta.format === "xlsx" ? "XLS" : meta.format.toUpperCase();
    const title = document.createElement("div");
    title.className = "generated-file-title";
    title.textContent = meta.file_name || getGeneratedFileDownloadName(meta.format);
    titleWrap.appendChild(icon);
    titleWrap.appendChild(title);
    const actions = document.createElement("div");
    actions.className = "generated-file-actions";
    header.appendChild(titleWrap);
    header.appendChild(actions);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.className = "generated-file-body";
    panel.appendChild(body);
    container.appendChild(panel);

    const current = {
      meta,
      html: meta.html || "",
      savedHtml: meta.html || "",
      finalized: !options.streaming,
      editing: false,
      dirty: false,
      saving: false,
    };

    const downloadBtn = createArtifactButton("Download");
    downloadBtn.addEventListener("click", async () => {
      try {
        await downloadGeneratedFile(current.meta);
      } catch (error) {
        debugWarn(`[UI] Generated file download failed: ${getSafeErrorMessage(error)}`);
        showToast("Couldn't download that file.", "error");
      }
    });

    let refreshArtifactControls = null;
    function finalizeControls() {
      current.finalized = true;
      actions.querySelectorAll("button").forEach((button) => setArtifactButtonState(button, true));
      refreshArtifactControls?.();
    }

    if (meta.format === "html") {
      const copyBtn = createArtifactButton("Copy");
      const editBtn = createArtifactButton("Edit");
      const saveBtn = createArtifactButton("Save");
      const cancelBtn = createArtifactButton("Cancel");
      const previewBtn = createArtifactButton("Preview");
      saveBtn.style.display = "none";
      cancelBtn.style.display = "none";
      actions.append(copyBtn, editBtn, saveBtn, cancelBtn, downloadBtn, previewBtn);

      const layout = document.createElement("div");
      layout.className = "generated-html-layout";
      const codePane = document.createElement("div");
      codePane.className = "generated-html-code-pane";
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-html";
      pre.appendChild(code);
      const editor = document.createElement("textarea");
      editor.className = "generated-html-editor";
      editor.spellcheck = false;
      editor.style.display = "none";
      codePane.appendChild(pre);
      codePane.appendChild(editor);
      const previewPane = document.createElement("div");
      previewPane.className = "generated-html-preview-pane";
      const iframe = document.createElement("iframe");
      iframe.className = "generated-html-preview-frame";
      iframe.setAttribute("sandbox", "allow-forms allow-modals allow-pointer-lock allow-popups allow-scripts");
      iframe.title = "HTML preview";
      previewPane.appendChild(iframe);
      layout.appendChild(codePane);
      layout.appendChild(previewPane);
      body.appendChild(layout);

      function refreshHtmlEditState() {
        current.dirty = current.html !== current.savedHtml;
        panel.classList.toggle("is-dirty", current.dirty);
        saveBtn.disabled = !current.finalized || !current.dirty || current.saving;
        cancelBtn.disabled = current.saving;
        saveBtn.classList.toggle("is-disabled", saveBtn.disabled);
        cancelBtn.classList.toggle("is-disabled", cancelBtn.disabled);
      }
      refreshArtifactControls = refreshHtmlEditState;

      function updateHtml(nextHtml, updateOptions = {}) {
        current.html = String(nextHtml || "");
        current.meta.html = current.html;
        current.meta.preview = { ...(current.meta.preview || {}), html: current.html, text: current.html.slice(0, 2400) };
        code.innerHTML = highlightCode(current.html, "html");
        if (updateOptions.fromEditor !== true || document.activeElement !== editor) {
          editor.value = current.html;
        }
        if (panel.classList.contains("show-preview")) iframe.srcdoc = current.html;
        if (current.finalized && updateOptions.cache === true) {
          const blob = createGeneratedFileBlob(current.meta);
          cacheGeneratedFileFromMeta(current.meta, blob).catch(() => null);
        }
        refreshHtmlEditState();
      }

      function setHtmlEditing(editing) {
        current.editing = Boolean(editing);
        editor.style.display = current.editing ? "block" : "none";
        pre.style.display = current.editing ? "none" : "block";
        editBtn.style.display = current.editing ? "none" : "";
        saveBtn.style.display = current.editing ? "" : "none";
        cancelBtn.style.display = current.editing ? "" : "none";
        if (current.editing) {
          editor.value = current.html;
          editor.focus();
        }
        refreshHtmlEditState();
      }

      copyBtn.addEventListener("click", async () => {
        try {
          await writeClipboardText(current.html || "");
          copyBtn.textContent = "Copied";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        } catch {
          showToast("Couldn't copy that HTML.", "error");
        }
      });
      editBtn.addEventListener("click", () => setHtmlEditing(true));
      saveBtn.addEventListener("click", async () => {
        if (!current.dirty || current.saving) return;
        if (!current.meta.file_id || !API.updateGeneratedHtmlFile) {
          showToast("This HTML file cannot be saved to your account.", "error");
          return;
        }
        const previousText = saveBtn.textContent;
        current.saving = true;
        refreshHtmlEditState();
        saveBtn.textContent = "Saving";
        try {
          const response = await API.updateGeneratedHtmlFile(current.meta.file_id, editor.value, current.meta.version);
          const normalized = normalizeGeneratedFileMeta(response?.file, { chatId: current.meta.chat_id || currentChatId });
          if (!normalized) throw new Error("Save response did not include generated file metadata.");
          Object.assign(current.meta, normalized);
          updateHtml(normalized.html || editor.value, { cache: true });
          current.savedHtml = current.html;
          refreshHtmlEditState();
          title.textContent = current.meta.file_name || getGeneratedFileDownloadName(current.meta.format);
          setHtmlEditing(false);
          showToast("Saved HTML changes.", "success");
        } catch (error) {
          debugWarn(`[UI] Generated HTML save failed: ${getSafeErrorMessage(error)}`);
          const conflictMeta = normalizeGeneratedFileMeta(error?.details?.file || error?.file, { chatId: current.meta.chat_id || currentChatId });
          if (error?.status === 409 && conflictMeta) {
            Object.assign(current.meta, conflictMeta);
            current.savedHtml = conflictMeta.html || current.savedHtml;
            current.html = editor.value;
            current.meta.html = current.html;
            current.meta.preview = { ...(current.meta.preview || {}), html: current.html, text: current.html.slice(0, 2400) };
            title.textContent = current.meta.file_name || getGeneratedFileDownloadName(current.meta.format);
            refreshHtmlEditState();
            showToast("This file changed elsewhere. Your edits are still visible; save again to replace the latest version.", "error", 6000);
          } else {
            showToast("Couldn't save those HTML edits.", "error");
          }
        } finally {
          current.saving = false;
          refreshHtmlEditState();
          saveBtn.textContent = previousText || "Save";
        }
      });
      cancelBtn.addEventListener("click", () => {
        updateHtml(current.savedHtml || "", { cache: false });
        setHtmlEditing(false);
      });
      editor.addEventListener("input", () => updateHtml(editor.value, { fromEditor: true }));
      previewBtn.addEventListener("click", () => {
        const showing = !panel.classList.contains("show-preview");
        panel.classList.toggle("show-preview", showing);
        if (showing) iframe.srcdoc = current.html || "";
      });
      if (options.streaming) {
        [copyBtn, editBtn, saveBtn, cancelBtn, downloadBtn, previewBtn].forEach((button) => setArtifactButtonState(button, false));
      }
      updateHtml(current.html);
      return {
        setHtml: updateHtml,
        setMeta(nextMeta) {
          const normalized = normalizeGeneratedFileMeta(nextMeta, options);
          if (!normalized) return;
          Object.assign(current.meta, normalized);
          updateHtml(normalized.html || current.html, { cache: true });
          current.savedHtml = current.html;
          refreshHtmlEditState();
          title.textContent = current.meta.file_name || getGeneratedFileDownloadName(current.meta.format);
        },
        finalize: finalizeControls,
        getMeta: () => current.meta,
      };
    }

    actions.appendChild(downloadBtn);
    const preview = meta.preview || {};
    let previewRendered = false;

    function appendPreviewMeta(items) {
      const cleanItems = (items || []).map((item) => String(item || "").trim()).filter(Boolean);
      if (!cleanItems.length) return null;
      const row = document.createElement("div");
      row.className = "generated-preview-meta";
      cleanItems.forEach((item) => {
        const chip = document.createElement("span");
        chip.textContent = item;
        row.appendChild(chip);
      });
      body.appendChild(row);
      return row;
    }

    function getDocumentPreviewMeta() {
      const documentMeta = preview.document || {};
      return [
        documentMeta.word_count ? `${documentMeta.word_count} words` : "",
        documentMeta.section_count ? `${documentMeta.section_count} sections` : "",
        meta.file_size_bytes ? `${Math.round(Number(meta.file_size_bytes) / 1024)} KB` : "",
        meta.version ? `Version ${meta.version}` : "",
      ];
    }

    if (meta.format === "xlsx") {
      const sheets = Array.isArray(preview.sheets) && preview.sheets.length
        ? preview.sheets
        : (preview.sheet?.rows?.length ? [{ ...preview.sheet, name: preview.sheet.name || "Sheet 1" }] : []);
      if (sheets.length) {
        const sheetShell = document.createElement("div");
        sheetShell.className = "generated-sheet-shell";
        const sheetSummary = document.createElement("div");
        sheetSummary.className = "generated-preview-meta generated-sheet-summary";
        const tabs = document.createElement("div");
        tabs.className = "generated-sheet-tabs";
        const sheet = document.createElement("div");
        sheet.className = "generated-sheet-preview";
        sheetShell.appendChild(sheetSummary);
        if (sheets.length > 1) sheetShell.appendChild(tabs);
        sheetShell.appendChild(sheet);

        function renderSheet(index) {
          const activeSheet = sheets[Math.max(0, Math.min(index, sheets.length - 1))] || sheets[0];
          const rows = Array.isArray(activeSheet.rows) ? activeSheet.rows : [];
          sheetSummary.innerHTML = "";
          [
            activeSheet.name || `Sheet ${index + 1}`,
            `${Number(activeSheet.row_count || rows.length || 0)} rows`,
            `${Number(activeSheet.column_count || rows[0]?.length || 0)} columns`,
          ].forEach((item) => {
            const chip = document.createElement("span");
            chip.textContent = item;
            sheetSummary.appendChild(chip);
          });
          tabs.querySelectorAll("button").forEach((button, tabIndex) => {
            button.classList.toggle("is-active", tabIndex === index);
          });
          sheet.innerHTML = "";
          const table = document.createElement("table");
          rows.slice(0, 16).forEach((row, rowIndex) => {
            const tr = document.createElement("tr");
            (Array.isArray(row) ? row : []).slice(0, 10).forEach((cell) => {
              const el = document.createElement(rowIndex === 0 ? "th" : "td");
              el.textContent = String(cell ?? "");
              tr.appendChild(el);
            });
            table.appendChild(tr);
          });
          sheet.appendChild(table);
        }

        sheets.forEach((sheetInfo, index) => {
          const tab = document.createElement("button");
          tab.type = "button";
          tab.className = "generated-sheet-tab";
          tab.textContent = sheetInfo.name || `Sheet ${index + 1}`;
          tab.addEventListener("click", () => renderSheet(index));
          tabs.appendChild(tab);
        });
        body.appendChild(sheetShell);
        renderSheet(0);
        previewRendered = true;
      }
    } else if (meta.format === "pptx") {
      const slides = Array.isArray(preview.slides) && preview.slides.length
        ? preview.slides
        : (preview.slide ? [preview.slide] : []);
      if (slides.length) {
        appendPreviewMeta([`${Number(preview.slide_count || slides.length)} slides`, meta.version ? `Version ${meta.version}` : ""]);
        const slideList = document.createElement("div");
        slideList.className = "generated-slide-list";
        slides.slice(0, 8).forEach((slideInfo, index) => {
          const slide = document.createElement("div");
          slide.className = "generated-slide-preview generated-slide-card";
          const kicker = document.createElement("div");
          kicker.className = "generated-slide-kicker";
          kicker.textContent = `Slide ${slideInfo.index || index + 1}`;
          slide.appendChild(kicker);
          const slideTitle = document.createElement("h4");
          slideTitle.textContent = slideInfo.title || `Slide ${index + 1}`;
          slide.appendChild(slideTitle);
          const list = document.createElement("ul");
          (slideInfo.bullets || []).slice(0, 8).forEach((bullet) => {
            const li = document.createElement("li");
            li.textContent = String(bullet || "");
            list.appendChild(li);
          });
          slide.appendChild(list);
          slideList.appendChild(slide);
        });
        body.appendChild(slideList);
        previewRendered = true;
      }
    } else if (meta.format === "pdf" && meta.file_url) {
      appendPreviewMeta(getDocumentPreviewMeta());
      const frame = document.createElement("iframe");
      frame.className = "generated-pdf-preview";
      frame.title = "PDF preview";
      resolveGeneratedFileAccessUrl(meta, "preview")
        .then((url) => { if (url) frame.src = url; })
        .catch((error) => {
          debugWarn(`[UI] PDF preview URL failed: ${getSafeErrorMessage(error)}`);
          if (isLegacyGeneratedFileUrl(meta.file_url)) frame.src = meta.file_url;
        });
      body.appendChild(frame);
      previewRendered = true;
    }

    const textPreview = meta.text || preview.text || "";
    if ((meta.format === "docx" || meta.format === "txt" || (meta.format === "pdf" && !meta.file_url)) && textPreview) {
      appendPreviewMeta(getDocumentPreviewMeta());
      const textBlock = document.createElement("pre");
      textBlock.className = "generated-text-preview";
      textBlock.textContent = textPreview;
      body.appendChild(textBlock);
      previewRendered = true;
    }
    if (!previewRendered) {
      const empty = document.createElement("div");
      empty.className = "generated-file-empty";
      empty.textContent = "Preview unavailable.";
      body.appendChild(empty);
    }
    return {
      finalize: finalizeControls,
      getMeta: () => current.meta,
    };
  }

  async function copyImageToClipboard(imageUrl, options = {}) {
    const { allowUrlFallback = true } = options || {};
    if (!imageUrl) throw new Error("Missing image URL.");
    const supportsImageClipboard = Boolean(navigator.clipboard?.write && typeof ClipboardItem !== "undefined");
    if (supportsImageClipboard) {
      try {
        const blob = await resolveImageBlob(imageUrl);
        const mimeType = blob.type || "image/png";
        await navigator.clipboard.write([new ClipboardItem({ [mimeType]: blob })]);
        return { mode: "image", mimeType };
      } catch (error) {
        if (allowUrlFallback) {
          await writeClipboardText(String(imageUrl));
          return { mode: "url", error };
        }
        throw error;
      }
    }
    if (allowUrlFallback) {
      await writeClipboardText(String(imageUrl));
      return { mode: "url" };
    }
    throw new Error("Clipboard image write not supported.");
  }

  function syncCopyButtonState(btn, enabled) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle("is-disabled", !enabled);
  }

  function setMessageCopyLabel(btn, label) {
    const labelEl = btn?.querySelector(".message-action-label");
    if (labelEl) labelEl.textContent = label;
  }

  function createAssistantActionBar(initialText = "", options = {}) {
    const config = options && typeof options === "object" ? options : {};
    const copyHandler = typeof config.copyHandler === "function" ? config.copyHandler : null;
    const copyEnabled = typeof config.isEnabled === "function" ? config.isEnabled : null;
    const baseCopyLabel = typeof config.copyLabel === "string" && config.copyLabel.trim()
      ? config.copyLabel.trim()
      : "Copy";
    let currentText = typeof initialText === "string" ? initialText : "";
    let textSource = null;
    let resetTimer = null;

    const actionBar = document.createElement("div");
    actionBar.className = "message-action-bar";

    const copyBtn = document.createElement("button");
    copyBtn.className = "message-action-btn";
    copyBtn.type = "button";
    copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span class="message-action-label"></span>';
    setMessageCopyLabel(copyBtn, baseCopyLabel);
    actionBar.appendChild(copyBtn);

    function getText() {
      const raw = typeof textSource === "function" ? textSource() : currentText;
      if (typeof raw !== "string") return "";
      return raw.trim();
    }

    function isCopyEnabled() {
      return copyEnabled ? Boolean(copyEnabled()) : Boolean(getText());
    }

    function refresh() {
      syncCopyButtonState(copyBtn, isCopyEnabled());
    }

    copyBtn.addEventListener("click", async () => {
      if (!isCopyEnabled()) return;
      try {
        if (copyHandler) {
          await copyHandler();
        } else {
          const text = getText();
          if (!text) return;
          await writeClipboardText(text);
        }
        copyBtn.classList.add("copied");
        setMessageCopyLabel(copyBtn, "Copied");
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          copyBtn.classList.remove("copied");
          setMessageCopyLabel(copyBtn, baseCopyLabel);
        }, 1800);
      } catch (err) {
        debugWarn(`[UI] Failed to copy message: ${getSafeErrorMessage(err)}`);
        showToast("Couldn't copy that message.", "error");
      }
    });

    refresh();

    return {
      element: actionBar,
      button: copyBtn,
      setText(text) {
        currentText = typeof text === "string" ? text : "";
        textSource = null;
        refresh();
      },
      setTextSource(source) {
        textSource = typeof source === "function" ? source : null;
        refresh();
      },
      refresh,
    };
  }

  function attachAssistantActionBar(bubble, initialText = "", options = {}) {
    if (!bubble) return null;
    const actionBar = createAssistantActionBar(initialText, options);
    bubble._assistantActionBar = actionBar;
    bubble.appendChild(actionBar.element);
    return actionBar;
  }

  function setAssistantBubbleCopyText(bubble, text) {
    bubble?._assistantActionBar?.setText(text);
  }

  function setAssistantBubbleCopySource(bubble, source) {
    bubble?._assistantActionBar?.setTextSource(source);
  }

  function copyCode(btn) {
    const wrap = btn.closest(".code-block-wrap");
    const pre = wrap?.querySelector("pre");
    if (pre) {
      const code = pre.textContent;
      writeClipboardText(code).then(() => {
        btn.classList.add("copied");
        btn.setAttribute("aria-label", "Code copied");
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.setAttribute("aria-label", "Copy code");
          btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
        }, 2000);
      }).catch((error) => {
        debugWarn(`[UI] Code copy failed: ${getSafeErrorMessage(error)}`);
        showToast("Couldn't copy that code block.", "error");
      });
    }
  }

  function wireCodeCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll("[data-code-copy='true']").forEach((button) => {
      if (button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.addEventListener("click", () => copyCode(button));
    });
  }

  function isProgressiveEscaped(text, index) {
    let count = 0;
    for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
    return count % 2 === 1;
  }

  function getProgressiveSafeIndex(text, force = false) {
    const source = String(text || "");
    let safeIndex = 0;
    let inFence = false;
    let fenceMarker = "";
    let inInlineCode = false;
    let inDisplayMath = false;
    let displayMathMarker = "";
    let inInlineMath = false;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      const next = source[i + 1];
      const next2 = source[i + 2];
      const escaped = isProgressiveEscaped(source, i);

      if (inFence) {
        if (!escaped && fenceMarker === "```" && ch === "`" && next === "`" && next2 === "`") {
          inFence = false;
          fenceMarker = "";
          i += 2;
          safeIndex = i + 1;
        } else if (!escaped && fenceMarker === "~~~" && ch === "~" && next === "~" && next2 === "~") {
          inFence = false;
          fenceMarker = "";
          i += 2;
          safeIndex = i + 1;
        }
        continue;
      }

      if (inDisplayMath) {
        if (!escaped && displayMathMarker === "$$" && ch === "$" && next === "$") {
          inDisplayMath = false;
          displayMathMarker = "";
          i += 1;
          safeIndex = i + 1;
        } else if (!escaped && displayMathMarker === "\\[" && ch === "\\" && next === "]") {
          inDisplayMath = false;
          displayMathMarker = "";
          i += 1;
          safeIndex = i + 1;
        }
        continue;
      }

      if (inInlineMath) {
        if (!escaped && ch === "\\" && next === ")") {
          inInlineMath = false;
          i += 1;
          safeIndex = i + 1;
        }
        continue;
      }

      if (inInlineCode) {
        if (!escaped && ch === "`") inInlineCode = false;
        continue;
      }

      if (!escaped && ch === "`" && next === "`" && next2 === "`") {
        inFence = true;
        fenceMarker = "```";
        i += 2;
        continue;
      }
      if (!escaped && ch === "~" && next === "~" && next2 === "~") {
        inFence = true;
        fenceMarker = "~~~";
        i += 2;
        continue;
      }
      if (!escaped && ch === "`") {
        inInlineCode = true;
        continue;
      }
      if (!escaped && ch === "$" && next === "$") {
        inDisplayMath = true;
        displayMathMarker = "$$";
        i += 1;
        continue;
      }
      if (!escaped && ch === "\\" && next === "[") {
        inDisplayMath = true;
        displayMathMarker = "\\[";
        i += 1;
        continue;
      }
      if (!escaped && ch === "\\" && next === "(") {
        inInlineMath = true;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        safeIndex = i + 1;
      }
    }

    if (force && !inFence && !inInlineCode && !inDisplayMath && !inInlineMath) {
      safeIndex = source.length;
    }
    return safeIndex;
  }

  function createProgressiveRichRenderer(renderedDiv, tailTextNode, options = {}) {
    const getRenderMode = typeof options.getRenderMode === "function"
      ? options.getRenderMode
      : () => options.renderMode || null;
    const minInterval = Number.isFinite(options.minInterval) ? options.minInterval : 80;
    let lastSafeIndex = -1;
    let lastRenderAt = 0;

    function reset() {
      lastSafeIndex = -1;
      lastRenderAt = 0;
      if (renderedDiv) renderedDiv.innerHTML = "";
      if (tailTextNode) tailTextNode.nodeValue = "";
    }

    function render(visibleText, force = false) {
      const source = String(visibleText || "");
      const safeIndex = getProgressiveSafeIndex(source, force);
      if (!renderedDiv || safeIndex < 0) return;
      const renderedSafeIndex = Math.max(lastSafeIndex, 0);
      if (safeIndex === lastSafeIndex && !force) {
        if (tailTextNode) tailTextNode.nodeValue = source.slice(renderedSafeIndex);
        return;
      }

      const now = Date.now();
      if (!force && lastSafeIndex >= 0 && (now - lastRenderAt) < minInterval) {
        if (tailTextNode) tailTextNode.nodeValue = source.slice(renderedSafeIndex);
        return;
      }

      const safeText = source.slice(0, safeIndex);
      renderedDiv.innerHTML = safeText.trim()
        ? renderRichText(safeText, { mode: getRenderMode() })
        : "";
      wireCodeCopyButtons(renderedDiv);
      lastSafeIndex = safeIndex;
      lastRenderAt = now;
      if (tailTextNode) tailTextNode.nodeValue = source.slice(safeIndex);
    }

    return { render, reset };
  }

  function createStreamingBubble(options = {}) {
    debugLog("[UI] createStreamingBubble");
    if (!chatMessages) return null;
    const bubble = document.createElement("div");
    bubble.className = "message assistant";
    if (options.chatId) bubble.dataset.chatId = options.chatId;
    if (options.requestId) bubble.dataset.requestId = options.requestId;
    if (options.loaderKind) bubble.dataset.loaderKind = options.loaderKind;
    const header = document.createElement("div");
    header.className = "message-header";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "S";
    const sender = document.createElement("div");
    sender.className = "message-sender";
    sender.textContent = "SentIQGPT";
    header.appendChild(avatar);
    header.appendChild(sender);
    bubble.appendChild(header);
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content typing-active sentiq-reveal-target";
    bubble.appendChild(contentDiv);
    const renderedDiv = document.createElement("div");
    renderedDiv.className = "streaming-rendered";
    const tailDiv = document.createElement("div");
    tailDiv.className = "streaming-tail";
    const tailTextNode = document.createTextNode(' ');
    tailDiv.appendChild(tailTextNode);
    contentDiv.appendChild(renderedDiv);
    contentDiv.appendChild(tailDiv);
    const actionBar = attachAssistantActionBar(bubble, "");
    chatMessages.appendChild(bubble);
    scrollToBottom(true);

    // Buffered rAF typing — tokens accumulate, chars reveal smoothly
    let fullText = "";
    setAssistantBubbleCopySource(bubble, () => fullText);
    let displayedChars = 0;
    let streamDone = false;
    let interruptionNotice = "";
    let rafId = 0;
    let frameCount = 0;
    let finalizeResolve = null;
    let renderMode = options.renderMode || null;
    let thinkingText = "";
    let revealed = false;
    const STREAM_RENDER_MIN_INTERVAL = 120;
    const progressiveRenderer = createProgressiveRichRenderer(renderedDiv, tailTextNode, {
      getRenderMode: () => renderMode,
      minInterval: STREAM_RENDER_MIN_INTERVAL,
    });
    let lastVisibleChars = 0;
    let pendingRenderReset = false;
    revealContent();

    function resetStreamingRender() {
      progressiveRenderer.reset();
      lastVisibleChars = 0;
    }

    function updateStreamingRender(visibleText, force) {
      if (pendingRenderReset) {
        resetStreamingRender();
        pendingRenderReset = false;
      }
      progressiveRenderer.render(visibleText, force);
    }

    function revealContent() {
      if (revealed) return;
      revealed = true;
      requestAnimationFrame(() => contentDiv.classList.add("is-visible"));
    }

    function finalize() {
      contentDiv.classList.remove('typing-active');
      revealContent();
      const statusNoticeHtml = interruptionNotice
        ? '<div class="truncation-notice">' + escapeHtml(interruptionNotice) + '</div>'
        : '';
      // For very long text, defer the heavy renderRichText to avoid UI lock-up
      if (fullText.length > 15000) {
        // Show plain text immediately, then render rich text in next idle frame
        renderedDiv.innerHTML = "";
        tailTextNode.nodeValue = fullText;
        var idleCb = window.requestIdleCallback || function(fn) { setTimeout(fn, 1); };
        idleCb(function() {
          contentDiv.innerHTML = renderAssistantMessageHtml(fullText, thinkingText, { mode: renderMode }) + statusNoticeHtml;
          wireThinkingPanels(contentDiv);
          wireCodeCopyButtons(contentDiv);
          scrollToBottom(true);
        });
      } else {
        contentDiv.innerHTML = renderAssistantMessageHtml(fullText, thinkingText, { mode: renderMode }) + statusNoticeHtml;
        wireThinkingPanels(contentDiv);
        wireCodeCopyButtons(contentDiv);
        scrollToBottom(true);
      }
      rafId = 0;
      if (finalizeResolve) { finalizeResolve(); finalizeResolve = null; }
    }

    function tick() {
      if (displayedChars >= fullText.length) {
        if (streamDone) { finalize(); return; }
        // Caught up to buffer — pause until more tokens arrive
        rafId = 0;
        return;
      }
      var remaining = fullText.length - displayedChars;
      // Aggressive scaling: for very long backlogs, jump ahead fast to prevent
      // the animation from falling hopelessly behind the stream
      var charsPerFrame;
      if (remaining > 5000)      charsPerFrame = 80;
      else if (remaining > 2000) charsPerFrame = 30;
      else if (remaining > 1000) charsPerFrame = 12;
      else if (remaining > 300)  charsPerFrame = 6;
      else if (remaining > 100)  charsPerFrame = 3;
      else if (remaining > 30)   charsPerFrame = 2;
      else                       charsPerFrame = 1;
      displayedChars = Math.min(displayedChars + charsPerFrame, fullText.length);
      const visibleText = fullText.substring(0, displayedChars);
      if (displayedChars !== lastVisibleChars) {
        lastVisibleChars = displayedChars;
        updateStreamingRender(visibleText, false);
      } else {
        progressiveRenderer.render(visibleText, false);
      }
      frameCount++;
      if (frameCount % 8 === 0) scrollToBottom(true);
      rafId = requestAnimationFrame(tick);
    }

    return {
      appendToken(token) {
        if (fullText.length >= MAX_RENDER_CHARS) return;
        const hadText = Boolean(fullText.trim());
        fullText += token;
        if (fullText.length > MAX_RENDER_CHARS) {
          fullText = fullText.substring(0, MAX_RENDER_CHARS);
          streamDone = true;
        }
        if (!hadText && fullText.trim()) {
          actionBar?.refresh();
          revealContent();
        }
        if (!rafId) rafId = requestAnimationFrame(tick);
      },
      finish(options = {}) {
        interruptionNotice = options.interruptionNotice || interruptionNotice;
        streamDone = true;
        actionBar?.refresh();
        return new Promise((resolve) => {
          finalizeResolve = resolve;
          if (!rafId) {
            if (displayedChars >= fullText.length) finalize();
            else rafId = requestAnimationFrame(tick);
          }
        });
      },
      setRenderMode(mode) {
        const nextMode = mode || null;
        if (nextMode !== renderMode) {
          renderMode = nextMode;
          pendingRenderReset = true;
          const visibleText = fullText.substring(0, displayedChars);
          if (visibleText) updateStreamingRender(visibleText, true);
        }
      },
      setThinking(thinking) { thinkingText = typeof thinking === "string" ? thinking : ""; },
      getRequestId() { return bubble.dataset.requestId || ""; },
      getFullText() { return fullText; },
    };
  }

  function createFileGenerationStreamingBubble(options = {}) {
    debugLog("[UI] createFileGenerationStreamingBubble");
    if (!chatMessages) return null;
    const bubble = document.createElement("div");
    bubble.className = "message assistant";
    if (options.chatId) bubble.dataset.chatId = options.chatId;
    if (options.requestId) bubble.dataset.requestId = options.requestId;
    const header = document.createElement("div");
    header.className = "message-header";
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "S";
    const sender = document.createElement("div");
    sender.className = "message-sender";
    sender.textContent = "SentIQGPT";
    header.appendChild(avatar);
    header.appendChild(sender);
    bubble.appendChild(header);
    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content sentiq-reveal-target is-visible";
    bubble.appendChild(contentDiv);

    const initialMeta = normalizeGeneratedFileMeta({
      format: options.format || "html",
      file_name: getGeneratedFileDownloadName(options.format || "html"),
      mime_type: getGeneratedFileMimeType(options.format || "html"),
      preview: { html: "", text: "" },
      html: "",
    }, { chatId: options.chatId || currentChatId });
    const controller = renderGeneratedFileContent(contentDiv, initialMeta, { streaming: true, chatId: options.chatId || currentChatId });
    chatMessages.appendChild(bubble);
    scrollToBottom(true);

    let fullHtml = "";
    let thinkingText = "";
    return {
      appendToken(token) {
        fullHtml += String(token || "");
        controller?.setHtml?.(fullHtml);
        scrollToBottom(true);
      },
      setArtifact(filePayload) {
        const meta = normalizeGeneratedFileMeta(filePayload, { chatId: options.chatId || currentChatId });
        if (meta) {
          if (!meta.html && fullHtml) meta.html = fullHtml;
          controller?.setMeta?.(meta);
          controller?.finalize?.();
          const blob = createGeneratedFileBlob(meta);
          cacheGeneratedFileFromMeta(meta, blob).catch(() => null);
        }
      },
      finish() {
        controller?.finalize?.();
        return Promise.resolve();
      },
      setRenderMode() {},
      setThinking(thinking) { thinkingText = typeof thinking === "string" ? thinking : ""; },
      getRequestId() { return bubble.dataset.requestId || ""; },
      getFullText() { return fullHtml; },
      getThinking() { return thinkingText; },
      getMeta() { return controller?.getMeta?.() || initialMeta; },
    };
  }

  async function handleSend(retryMessage, options = {}) {
    const stopMeasure = startPerf("ui.chat.send", {
      retry: Boolean(retryMessage),
      signed_in: isAuthenticatedSession(),
    });
    let firstVisibleTokenLogged = false;
    if (!chatInput && !retryMessage) {
      stopMeasure("skipped");
      return;
    }
    hideSelectionButton();
    pendingSelectionPayload = null;
    closeComposerMenu();
    if (ensureNameCapture()) {
      stopMeasure("blocked", { reason: "name_required" });
      return;
    }

    const suppliedImageAttachments = Array.isArray(options.imageAttachments) ? options.imageAttachments : [];
    const message = retryMessage || options.message || chatInput.value.trim();
    if (!message && pendingFiles.length === 0 && suppliedImageAttachments.length === 0) {
      stopMeasure("skipped");
      return;
    }
    if (!currentChatId) {
      await startNewChat();
      if (!currentChatId) {
        stopMeasure("error", { reason: "chat_not_created" });
        return;
      }
    }
    const explicitClarificationResponse = options.clarificationResponse && typeof options.clarificationResponse === "object"
      ? options.clarificationResponse
      : null;
    const pendingClarificationState = getPendingClarification(currentChatId);
    let clarificationStateLockedForRequest = null;
    let clarificationLockChatId = currentChatId;
    if (message && pendingClarificationState?.inFlight && !explicitClarificationResponse) {
      showToast("Please wait for the current clarification answer to finish.", "info", 2500);
      stopMeasure("skipped", { reason: "clarification_in_flight" });
      return;
    }
    const isClarificationAnswer = Boolean(message && (explicitClarificationResponse || pendingClarificationState));
    let clarificationResponseForRequest = explicitClarificationResponse;
    const clarificationContextSnapshot = options.clarificationContextSnapshot
      || pendingClarificationState?.contextSnapshot
      || null;
    if (isClarificationAnswer && !clarificationResponseForRequest && pendingClarificationState) {
      clarificationResponseForRequest = buildClarificationResponsePayload(
        pendingClarificationState,
        message,
        "custom",
      );
      pendingClarificationState.inFlight = true;
      clarificationStateLockedForRequest = pendingClarificationState;
      clarificationLockChatId = currentChatId;
    }
    hideWelcome();
    if (chatMessages) chatMessages.classList.add("has-messages");
    if (!retryMessage) { chatInput.value = ""; chatInput.style.height = "auto"; }
    debugLog("[UI] handleSend", { length: message.length, retry: Boolean(retryMessage) });

    if (!isClarificationAnswer && pendingFiles.length > 0 && !options.skipPendingFileProcessing) {
      await processPendingFiles(message);
      return;
    }
    if (!isClarificationAnswer && imageMode && message) { setImageMode(false); await handleImageGeneration(message); return; }

    let apiMessage = message || (suppliedImageAttachments.length > 0 ? DEFAULT_IMAGE_ANALYSIS_PROMPT : "");
    const visibleUserMessage = message || (
      suppliedImageAttachments.length > 0
        ? `Uploaded image: ${suppliedImageAttachments.map((image) => image.filename).join(", ")}`
        : ""
    );
    const imageAttachmentsForRequest = isClarificationAnswer && Array.isArray(clarificationContextSnapshot?.imageAttachments)
      ? clarificationContextSnapshot.imageAttachments
      : suppliedImageAttachments.length > 0
        ? suppliedImageAttachments
        : getCurrentImageAttachments(apiMessage);
    const userMessageMeta = suppliedImageAttachments.length > 0
      ? buildImageUploadMeta(suppliedImageAttachments)
      : null;
    if (suppliedImageAttachments.length > 0) {
      currentSessionImageAttachments = suppliedImageAttachments;
    }

    const originalApiMessage = apiMessage;
    const clarifiedDownloadFormat = detectClarificationDownloadFormat(clarificationResponseForRequest);
    const typedClarificationDownloadFormat = isClarificationAnswer && /\bdownloadable\b/i.test(originalApiMessage)
      ? detectRequestedFileFormat(originalApiMessage)
      : null;
    const requestedFileFormat = clarifiedDownloadFormat || typedClarificationDownloadFormat || detectRequestedFileFormat(originalApiMessage);
    const fileGenerationPrompt = Boolean(clarifiedDownloadFormat || typedClarificationDownloadFormat) || (!isClarificationAnswer && isLikelyFileGenerationRequest(originalApiMessage));
    const authenticatedFileGenerationRequired = fileGenerationPrompt && isAuthenticatedSession();
    const htmlFileGenerationRequired = authenticatedFileGenerationRequired && requestedFileFormat === "html";
    if (fileGenerationPrompt && !isAuthenticatedSession()) {
      apiMessage = buildGuestFileGenerationInstruction(originalApiMessage, requestedFileFormat);
    }
    const chartResponseRequired = !authenticatedFileGenerationRequired && isChartRequest(apiMessage);
    const bufferedReasoningRequired = !authenticatedFileGenerationRequired && isLikelyBufferedReasoningPrompt(apiMessage);
    const structuredResponseRequired = chartResponseRequired || bufferedReasoningRequired || (authenticatedFileGenerationRequired && !htmlFileGenerationRequired);
    const requestLoaderKind = SentIQLoaderEngine.resolveKind(apiMessage, {
      structured: chartResponseRequired,
      reasoning: bufferedReasoningRequired,
      file: authenticatedFileGenerationRequired,
    });

    if (!isClarificationAnswer && !webSearchModeOverride && imageAttachmentsForRequest.length === 0 && !chartResponseRequired && !bufferedReasoningRequired && !authenticatedFileGenerationRequired && apiMessage && isImageRequest(apiMessage)) {
      await handleImageGeneration(apiMessage);
      return;
    }

    let targetChatId = currentChatId;
    if (isAuthenticatedSession()) {
      const activeChat = await Storage.getChat(targetChatId);
      if (isPlaceholderServerChat(activeChat)) {
        try {
          targetChatId = await ensureRemoteConversationForChat(targetChatId);
        } catch (error) {
          if (await maybeHandleProfileNameRequiredError(error, "chat.ensureRemoteConversation")) {
            stopMeasure("blocked", { reason: "name_required" });
            return;
          }
          logAuthenticatedConversationError("handleSend.ensureRemoteConversation", error);
          showToast("Couldn't sync this chat yet. Please try again in a moment.", "error");
          return;
        }
      }
    }
    const requestId = newRequestId(targetChatId);
    const state = getChatState(targetChatId);
    state.isThinking = true;
    state.activityMode = authenticatedFileGenerationRequired ? "file_generation" : "thinking";
    const ac = new AbortController();
    state.abortController = ac;
    setStopMode();

    if (!retryMessage) {
      appendMessageBubble("user", visibleUserMessage, userMessageMeta);
      if (chatMessages) chatMessages.classList.add("has-messages");
      await persistChatMessage(targetChatId, "user", visibleUserMessage, userMessageMeta);
    }
    if (targetChatId === currentChatId && typingIndicator) {
      const shouldPreferWebSurfIndicator = Boolean(webSearchModeOverride) && !authenticatedFileGenerationRequired;
      if (shouldPreferWebSurfIndicator) {
        SentIQLoaderEngine.showForRoute("web_search", { chatId: targetChatId, withTimer: true });
      } else if (authenticatedFileGenerationRequired) {
        SentIQLoaderEngine.showForRoute("file_generation", { chatId: targetChatId, withTimer: true });
      } else if (bufferedReasoningRequired) {
        SentIQLoaderEngine.showForRoute("reasoning", { chatId: targetChatId, withTimer: true });
      } else {
          SentIQLoaderEngine.showForPrompt(apiMessage, {
          chatId: targetChatId,
          structured: chartResponseRequired,
        });
      }
    }
    _userScrolledUp = false;
    if (scrollAnchorPill) scrollAnchorPill.classList.remove("visible");
    scrollToBottom();

    let retryClarificationContextSnapshot = clarificationContextSnapshot;
    try {
      const contextData = await getChatContextData(targetChatId);
      const fileReferences = isClarificationAnswer && Array.isArray(clarificationContextSnapshot?.fileReferences)
        ? clarificationContextSnapshot.fileReferences
        : getCurrentFileReferences();
      const effectiveWebSearchMode = isClarificationAnswer && clarificationContextSnapshot?.webSearchMode
        ? clarificationContextSnapshot.webSearchMode
        : getEffectiveWebSearchMode();
      if (fileReferences.length > 0) {
        debugLog("[Frontend] using session file", { extracted_chars: fileReferences[0].extractedText.length });
      }
      debugLog("[API Request] context counts", { file_references: fileReferences.length, image_attachments: imageAttachmentsForRequest.length });

      const contextPayload = {
        recentMessages: contextData.recentMessages,
        memories: contextData.memories,
        fileReferences,
        imageAttachments: imageAttachmentsForRequest,
        webSearchMode: effectiveWebSearchMode,
        conversationId: targetChatId,
        clientRequestId: requestId,
        clarificationResponse: clarificationResponseForRequest,
        signal: ac.signal,
      };
      retryClarificationContextSnapshot = cloneClarificationContext(contextPayload);

      let fullReply = "";
      let streamThinking = "";
      let memoryResult = null;
      let usedStreaming = false;
      let assistantPersisted = false;
      let responseSync = null;
      let responseRenderMode = null;
      let fileArtifactResponse = null;

      if (isRequestStale(targetChatId, requestId)) return;

      if (!structuredResponseRequired) {
        let structuredResponse = null;
        let streamResult = null;
        let streamBubble = null;
        try {
          debugLog("[UI] Attempting streaming");
          streamBubble = (targetChatId === currentChatId)
            ? (htmlFileGenerationRequired
              ? createFileGenerationStreamingBubble({ chatId: targetChatId, requestId, format: requestedFileFormat || "html" })
              : createStreamingBubble({ loaderKind: requestLoaderKind, chatId: targetChatId, requestId }))
            : null;
          const ensureFileGenerationStreamBubble = (format = "html") => {
            if (streamBubble?.setArtifact && streamBubble?.appendToken) return streamBubble;
            const existing = chatMessages?.querySelector(`.message.assistant[data-request-id="${requestId}"]`);
            existing?.remove();
            streamBubble = targetChatId === currentChatId
              ? createFileGenerationStreamingBubble({ chatId: targetChatId, requestId, format })
              : null;
            return streamBubble;
          };
          if (streamBubble && typeof API.sendMessageStream === "function") {
            usedStreaming = true;
            streamResult = await API.sendMessageStream(apiMessage, contextPayload, {
              onToken(token) {
                if (!isRequestStale(targetChatId, requestId)) {
                  // Hide "Reasoning..." indicator on first token arrival
                  hideActivityIndicator(targetChatId);
                  if (!firstVisibleTokenLogged) {
                    firstVisibleTokenLogged = true;
                    stopMeasure("first_visible_token", { conversation_id: targetChatId });
                  }
                  streamBubble.appendToken(token);
                }
              },
              onFileToken(token, eventMeta = {}) {
                if (!isRequestStale(targetChatId, requestId)) {
                  hideActivityIndicator(targetChatId);
                  if (!firstVisibleTokenLogged) {
                    firstVisibleTokenLogged = true;
                    stopMeasure("first_visible_token", { conversation_id: targetChatId });
                  }
                  ensureFileGenerationStreamBubble(eventMeta?.format || requestedFileFormat || "html")?.appendToken?.(token);
                }
              },
              onFileArtifact(response) {
                if (!isRequestStale(targetChatId, requestId)) {
                  fileArtifactResponse = response;
                  const artifactFormat = response?.file?.format || response?.format || requestedFileFormat || "html";
                  ensureFileGenerationStreamBubble(artifactFormat)?.setArtifact?.(response.file);
                  responseSync = response.sync || null;
                }
              },
              onThinking(thinking) {
                if (!isRequestStale(targetChatId, requestId)) {
                  streamThinking = typeof thinking === "string" ? thinking : "";
                  if (streamBubble) streamBubble.setThinking(streamThinking);
                }
              },
              onRoute(route, routeMeta = {}) {
                state.activityMode = route === "web_search"
                  ? "web_search"
                  : route === "file_generation"
                    ? "file_generation"
                  : route === "math_reasoning"
                    ? "reasoning"
                    : "thinking";
                if (route === "web_search") {
                  updateActivityIndicator("web_search", { chatId: targetChatId, withTimer: true });
                }
                if (route === "web_search") {
                  responseRenderMode = "web_search";
                  streamBubble.setRenderMode("web_search");
                }
                if (route === "math_reasoning") {
                  responseRenderMode = "math";
                  streamBubble.setRenderMode("math");
                }
                if (route === "file_generation") {
                  responseRenderMode = null;
                  if ((routeMeta?.format || requestedFileFormat) === "html") {
                    ensureFileGenerationStreamBubble(routeMeta?.format || requestedFileFormat || "html");
                  }
                }
                consumeWebSearchOneShot(route);
                // Math pipeline: switch indicator to "Reasoning..." while openai-large solves
                if (!isRequestStale(targetChatId, requestId) && targetChatId === currentChatId) {
                  SentIQLoaderEngine.showForRoute(route, { chatId: targetChatId });
                }
              },
              onMemory(memory) { memoryResult = memory; },
              onError(err, meta) {
                const phase = meta?.tokensReceived ? "after partial output" : "before first token";
                debugWarn(`[UI] Stream error (${phase}):`, getSafeErrorMessage(err));
              },
              onStructuredResponse(response) {
                // Backend redirected a chart/tool request through orchestrator.
                // Remove the streaming bubble and use the structured response instead.
                structuredResponse = response;
              },
            }, ac.signal);
            if (fileArtifactResponse) {
              const fileMeta = normalizeGeneratedFileMeta(fileArtifactResponse.file, { chatId: targetChatId });
              fullReply = fileArtifactResponse.reply || fileArtifactResponse.answer || (fileMeta ? `Generated ${fileMeta.file_name}.` : "Sorry, I couldn't generate that file. Please try again.");
              if (fileMeta) {
                await streamBubble.finish();
                await persistChatMessage(targetChatId, "assistant", fullReply, fileMeta);
                cacheGeneratedFileFromMeta(fileMeta).catch(() => null);
              } else {
                chatMessages?.querySelector(`.message.assistant[data-request-id="${requestId}"]`)?.remove();
                if (!isRequestStale(targetChatId, requestId) && targetChatId === currentChatId) {
                  appendMessageBubble("assistant", fullReply, null, {}, { animateReveal: true });
                }
                await persistChatMessage(targetChatId, "assistant", fullReply);
              }
              assistantPersisted = true;
            } else if (structuredResponse) {
              // Remove streaming bubble — we'll render via deliverAssistantResponse
              if (streamBubble) {
                const targetBubble = chatMessages?.querySelector(`.message.assistant[data-request-id="${requestId}"]`);
                targetBubble?.remove();
              }
              debugLog("[UI] Received structured response from stream redirect");
              consumeWebSearchOneShot(structuredResponse?.route);
              const renderInView = !isRequestStale(targetChatId, requestId) && targetChatId === currentChatId;
              fullReply = await deliverAssistantResponse(
                structuredResponse,
                targetChatId,
                renderInView,
                {
                  ...(responseRenderMode ? { mode: responseRenderMode } : {}),
                  pendingClarificationContext: contextPayload,
                },
              );
              memoryResult = structuredResponse.memory;
              responseSync = structuredResponse.sync || null;
              assistantPersisted = true;
            } else {
              const interruptionNotice = streamResult?.interrupted
                ? "Response interrupted — showing partial output."
                : "";
              await streamBubble.finish({ interruptionNotice });
              fullReply = streamBubble.getFullText();
              if (responseRenderMode === "web_search") {
                consumeWebSearchOneShot("web_search");
              }
              if (streamResult?.interrupted) {
                debugWarn("[UI] Streaming interrupted after partial output; keeping partial response");
                showToast("Response interrupted — showing partial output.", "info", 3500);
              }
              debugLog("[UI] Streaming complete", { length: fullReply.length });
            }
          }
        } catch (streamErr) {
          if (streamErr.name === "AbortError") {
            debugLog("[UI] Stream aborted by user");
            const orphanContent = chatMessages?.querySelector(`.message.assistant[data-request-id="${requestId}"] .typing-active`);
            if (orphanContent) {
              orphanContent.classList.remove("typing-active");
              const partial = orphanContent.textContent || "";
              if (partial) {
                orphanContent.innerHTML = renderAssistantMessageHtml(
                  partial,
                  streamThinking,
                  responseRenderMode ? { mode: responseRenderMode } : {},
                );
                wireThinkingPanels(orphanContent);
                wireCodeCopyButtons(orphanContent);
                fullReply = partial;
              } else {
                orphanContent.closest(".message")?.remove();
              }
            }
            usedStreaming = true;
          } else {
            debugWarn("[UI] Streaming failed, falling back to non-streaming:", getSafeErrorMessage(streamErr));
            usedStreaming = false;
            const orphan = chatMessages?.querySelector(`.message.assistant[data-request-id="${requestId}"] .typing-active`);
            if (orphan) orphan.closest(".message")?.remove();
          }
        }
      }

      if (isRequestStale(targetChatId, requestId) && !ac.signal.aborted) {
        if (fullReply) await persistChatMessage(targetChatId, "assistant", fullReply);
        return;
      }

      if (!usedStreaming) {
        debugLog(
          bufferedReasoningRequired
            ? "[UI] Using non-streaming reasoning request"
            : structuredResponseRequired
              ? "[UI] Using structured chat request for chart-capable response"
              : "[UI] Using non-streaming fallback"
        );
        const response = await API.sendMessage(apiMessage, contextPayload);
        if (response?.route === "web_search") responseRenderMode = "web_search";
        if (response?.route === "math_reasoning") responseRenderMode = "math";
        consumeWebSearchOneShot(response?.route);
        const renderInView = !isRequestStale(targetChatId, requestId) && targetChatId === currentChatId;
        fullReply = await deliverAssistantResponse(
          response,
          targetChatId,
          renderInView,
          {
            ...(responseRenderMode ? { mode: responseRenderMode } : {}),
            pendingClarificationContext: contextPayload,
          },
        );
        memoryResult = response.memory;
        responseSync = response.sync || null;
        assistantPersisted = true;
      }

      if (!assistantPersisted && fullReply) {
        await persistChatMessage(targetChatId, "assistant", fullReply);
      }
      if (memoryResult?.stored && memoryResult.persisted !== false && memoryResult.summary) {
        const scopedMemory = buildScopedMemoryPayload(memoryResult, targetChatId, responseSync);
        if (scopedMemory) {
          await storeMemoryForContext(scopedMemory);
        }
      }
      const titleSeedMessage = clarificationResponseForRequest?.original_message || visibleUserMessage || apiMessage;
      maybeGenerateTitle(titleSeedMessage, fullReply || (chartResponseRequired ? "Generated a chart." : ""));
    } catch (err) {
      stopMeasure("error");
      if (err.name === "AbortError") { /* user-initiated stop */ }
      else if (await maybeHandleProfileNameRequiredError(err, "chat.send")) {
        return;
      }
      else if (!isRequestStale(targetChatId, requestId)) {
        debugWarn(`[UI] Chat error: ${getSafeErrorMessage(err)}`);
        const { contentDiv: errDiv } = appendMessageBubble("assistant", "");
        errDiv.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "message-error-wrap";
        const errText = document.createElement("p");
        errText.className = "message-error-text";
        errText.textContent = "Sorry, something went wrong. Please try again.";
        wrap.appendChild(errText);
        const retryBtn = document.createElement("button");
        retryBtn.className = "error-retry-btn";
        retryBtn.textContent = "Retry";
          const capturedMsg = apiMessage;
          const capturedImages = imageAttachmentsForRequest;
          const capturedClarificationResponse = clarificationResponseForRequest;
          const capturedClarificationContext = retryClarificationContextSnapshot;
          retryBtn.addEventListener("click", () => {
            errDiv.closest(".message")?.remove();
            handleSend(capturedMsg, {
              imageAttachments: capturedImages,
              skipPendingFileProcessing: true,
              ...(capturedClarificationResponse ? { clarificationResponse: capturedClarificationResponse } : {}),
              ...(capturedClarificationContext ? { clarificationContextSnapshot: capturedClarificationContext } : {}),
            });
          });
        wrap.appendChild(retryBtn);
        errDiv.appendChild(wrap);
        showToast("Failed to get response. You can retry.", "error");
      }
    } finally {
      stopMeasure("done", { conversation_id: targetChatId });
      state.isThinking = false;
      state.activityMode = "thinking";
      state.abortController = null;
      hideActivityIndicator(targetChatId);
      if (clarificationStateLockedForRequest) {
        const currentClarification = getPendingClarification(clarificationLockChatId);
        if (currentClarification === clarificationStateLockedForRequest) {
          currentClarification.inFlight = false;
        }
      }
      setSendMode();
      scheduleChatListRefresh();
    }
  }

  async function handleSelectionAsk(payload) {
    if (!payload?.selected_text) return;
    if (ensureNameCapture()) return;
    hideSelectionButton();
    pendingSelectionPayload = null;

    if (!currentChatId) {
      await startNewChat();
      if (!currentChatId) return;
    }
    hideWelcome();

    let targetChatId = currentChatId;
    if (isAuthenticatedSession()) {
      const activeChat = await Storage.getChat(targetChatId);
      if (isPlaceholderServerChat(activeChat)) {
        try {
          targetChatId = await ensureRemoteConversationForChat(targetChatId);
        } catch (error) {
          if (await maybeHandleProfileNameRequiredError(error, "selection.ensureRemoteConversation")) {
            return;
          }
          logAuthenticatedConversationError("handleSelectionAsk.ensureRemoteConversation", error);
          showToast("Couldn't sync this chat yet. Please try again in a moment.", "error");
          return;
        }
      }
    }
    const requestId = newRequestId(targetChatId);
    const state = getChatState(targetChatId);
    state.isThinking = true;
    state.activityMode = "thinking";
    const ac = new AbortController();
    state.abortController = ac;
    setStopMode();

    const userSelectionMessage = `Selected text:\n${payload.selected_text}`;
    appendMessageBubble("user", userSelectionMessage);
    await persistChatMessage(targetChatId, "user", userSelectionMessage);

    if (targetChatId === currentChatId && typingIndicator) {
      SentIQLoaderEngine.showForRoute("math_reasoning", { chatId: targetChatId, withTimer: true });
    }
    _userScrolledUp = false;
    if (scrollAnchorPill) scrollAnchorPill.classList.remove("visible");
    scrollToBottom();

    try {
      const contextData = await getChatContextData(targetChatId);
      const response = await API.sendSelectionMessage({
        ...payload,
        conversationId: targetChatId,
        context: {
          recent_messages: contextData.recentMessages,
          memories: contextData.memories,
        },
      }, ac.signal);

      const renderInView = !isRequestStale(targetChatId, requestId) && targetChatId === currentChatId;
      const replyText = await deliverAssistantResponse(response, targetChatId, renderInView);

      if (response.memory?.stored && response.memory.persisted !== false && response.memory.summary) {
        const scopedMemory = buildScopedMemoryPayload(response.memory, targetChatId, response.sync || null);
        if (scopedMemory) {
          await storeMemoryForContext(scopedMemory);
        }
      }

      maybeGenerateTitle(userSelectionMessage, replyText || "Selection context response.");
    } catch (err) {
      if (err.name === "AbortError") { /* user-initiated stop */ }
      else if (await maybeHandleProfileNameRequiredError(err, "selection.ask")) {
        return;
      }
      else if (!isRequestStale(targetChatId, requestId)) {
        debugWarn(`[UI] Selection chat error: ${getSafeErrorMessage(err)}`);
        const { contentDiv: errDiv } = appendMessageBubble("assistant", "");
        errDiv.innerHTML = "";
        const wrap = document.createElement("div");
        wrap.className = "message-error-wrap";
        const errText = document.createElement("p");
        errText.className = "message-error-text";
        errText.textContent = "Sorry, something went wrong. Please try again.";
        wrap.appendChild(errText);
        errDiv.appendChild(wrap);
      }
    } finally {
      state.isThinking = false;
      state.activityMode = "thinking";
      state.abortController = null;
      hideActivityIndicator(targetChatId);
      setSendMode();
      scheduleChatListRefresh();
    }
  }

  function toggleImageMode() {
    if (!imageMode) {
      const quota = checkImageQuota();
      if (quota.exhausted) {
        showQuotaWarning("Image generation quota reached. Please try again after 24 hours.");
        return;
      }
    }
    setImageMode(!imageMode);
  }

  function updateComposerActionSelection() {
    const hasFiles = pendingFiles.length > 0;
    fileAttachBtn?.classList.toggle("active", hasFiles);
    fileAttachBtn?.setAttribute("aria-pressed", hasFiles.toString());
    imageGenBtn?.classList.toggle("active", Boolean(imageMode));
    imageGenBtn?.setAttribute("aria-pressed", Boolean(imageMode).toString());
    webSurfBasicBtn?.classList.toggle("active", webSearchModeOverride === "basic");
    webSurfBasicBtn?.setAttribute("aria-pressed", (webSearchModeOverride === "basic").toString());
  }

  function clearPendingFiles() {
    if (pendingFiles.length === 0) return;
    pendingFiles = [];
    renderFilePreview();
    syncComposerHint();
  }

  function setImageMode(active) {
    imageMode = Boolean(active);
    if (imageMode) {
      webSearchModeOverride = null;
      clearPendingFiles();
    }
    if (imageModeBar) imageModeBar.style.display = imageMode ? "flex" : "none";
    if (webSearchModeBar) webSearchModeBar.style.display = "none";
    updateComposerActionSelection();
    if (chatInput) {
      chatInput.focus();
    }
    syncComposerHint();
  }

  function getEffectiveWebSearchMode() {
    return webSearchModeOverride === "basic" ? "basic" : undefined;
  }

  function updateWebSearchButtons() {
    const isActive = webSearchModeOverride === "basic";
    if (webSearchModeBar) {
      webSearchModeBar.style.display = isActive ? "flex" : "none";
    }
    if (webSearchModeLabel) {
      webSearchModeLabel.textContent = isActive ? "WebSurf active" : "WebSurf";
    }
    updateComposerActionSelection();
  }

  function setWebSearchModeOverride(mode) {
    const normalized = mode === "advanced" ? "basic" : mode;
    webSearchModeOverride = normalized === "basic" ? "basic" : null;
    if (webSearchModeOverride) {
      imageMode = false;
      if (imageModeBar) imageModeBar.style.display = "none";
      clearPendingFiles();
    }
    updateWebSearchButtons();
    if (chatInput) chatInput.focus();
    syncComposerHint();
  }

  function consumeWebSearchOneShot(route) {
    if (route !== "web_search" || !webSearchModeOverride) return;
    webSearchModeOverride = null;
    updateWebSearchButtons();
  }

  function setComposerMenuOpen(open) {
    if (!composerActionMenu || !composerPlusBtn) return;
    composerActionMenu.classList.toggle("open", Boolean(open));
    composerActionMenu.setAttribute("aria-hidden", open ? "false" : "true");
    composerPlusBtn.classList.toggle("active", Boolean(open));
    composerPlusBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeComposerMenu() {
    setComposerMenuOpen(false);
  }

  async function safelyAddImageMessage(chatId, role, content, meta, label) {
    try {
      await persistChatMessage(chatId, role, content, meta);
      return true;
    } catch (error) {
      debugWarn(`[UI] Failed to persist ${label || "image message"} locally:`, getSafeErrorMessage(error));
      return false;
    }
  }

  async function handleImageGeneration(prompt) {
    const session = await requireAuthAccess();
    if (!session) return;
    hideSelectionButton();
    pendingSelectionPayload = null;

    // Enforce client-side quota
    const quota = checkImageQuota();
    if (quota.exhausted) {
      showQuotaWarning("Image generation quota reached. Please try again after 24 hours.");
      hideImageButton();
      return;
    }

    // Enforce client-side cooldown
    const cooldown = checkImageCooldown();
    if (cooldown.active) {
      const waitSec = Math.ceil(cooldown.waitMs / 1000);
      showQuotaWarning(`Please wait ${waitSec} second${waitSec !== 1 ? "s" : ""} before generating another image.`);
      return;
    }

    if (!currentChatId) {
      await startNewChat();
      if (!currentChatId) return;
    }
    hideWelcome();
    if (chatMessages) chatMessages.classList.add("has-messages");
    let targetChatId = currentChatId;
    if (isAuthenticatedSession()) {
      const activeChat = await Storage.getChat(targetChatId);
      if (isPlaceholderServerChat(activeChat)) {
        try {
          targetChatId = await ensureRemoteConversationForChat(targetChatId);
        } catch (error) {
          if (await maybeHandleProfileNameRequiredError(error, "image.ensureRemoteConversation")) {
            return;
          }
          logAuthenticatedConversationError("handleImageGeneration.ensureRemoteConversation", error);
          showToast("Couldn't sync this chat yet. Please try again in a moment.", "error");
          return;
        }
      }
    }
    const requestId = newRequestId(targetChatId);
    const state = getChatState(targetChatId);
    state.isThinking = true;
    state.activityMode = "image_generation";

    appendMessageBubble("user", `Generate image: ${prompt}`);
    await safelyAddImageMessage(targetChatId, "user", `Generate image: ${prompt}`, null, "image prompt");
    if (targetChatId === currentChatId && typingIndicator) {
      updateActivityIndicator("image_generation", {
        chatId: targetChatId,
        withTimer: true,
        loaderKind: "loader-image",
      });
    }
    scrollToBottom();

    // Slow-inference hint: if generation takes over 8s, update typing indicator text
    // For complex prompts (text/spatial/multi-element), show a different message sooner
    let slowHintTimer = null;
    const isComplexPrompt = /\b(?:text|sign|say(?:s|ing)?|word|letter|holding|wear(?:ing)?|in front of|behind|next to|multiple|several|group of|pointing at|looking at)\b/i.test(prompt);
    if (typingIndicator) {
      const hintDelay = isComplexPrompt ? 3000 : 8000;
      const hintText = isComplexPrompt
        ? '<span class="slow-hint">Using higher-quality model for this prompt... </span>'
        : '<span class="slow-hint">Your image is being generated... </span>';
      slowHintTimer = setTimeout(() => {
        if (state.isThinking && targetChatId === currentChatId) {
          const dots = typingIndicator.querySelector(".typing-dots");
          if (dots) dots.insertAdjacentHTML("beforebegin", hintText);
        }
      }, hintDelay);
    }

    const ac = new AbortController();
    state.abortController = ac;
    setStopMode();

    try {
      updateImageCooldown();
      incrementImageQuota();
      const result = await API.generateImage(prompt, {
        conversationId: targetChatId,
        clientRequestId: requestId,
      });
      if (isRequestStale(targetChatId, requestId)) {
        if (result.success) {
          if (isAuthenticatedSession() && targetChatId) {
            refreshCanonicalChatAfterImageGeneration(targetChatId)
              .then(() => scheduleChatListRefresh())
              .catch((error) => logAuthenticatedConversationError("image.refresh.stale", error));
          } else {
            const staleImageUrl = result.image_url
              || (result.image_base64 ? `data:image/png;base64,${result.image_base64}` : "")
              || result.url
              || "";
            if (staleImageUrl) {
              const meta = { type: "image", imageUrl: staleImageUrl, prompt };
              await safelyAddImageMessage(targetChatId, "assistant", "", meta, "stale generated image");
            }
          }
        }
        return;
      }
      if (result.success) {
        let imageUrl = "";
        if (result.image_url) imageUrl = result.image_url;
        else if (result.image_base64) imageUrl = `data:image/png;base64,${result.image_base64}`;
        else if (result.url) imageUrl = result.url;

        const meta = { type: "image", imageUrl, prompt };
        appendMessageBubble("assistant", "", meta, {}, { animateReveal: true });
        await safelyAddImageMessage(targetChatId, "assistant", "", meta, "generated image");
        maybeGenerateTitle(`Generate image: ${prompt}`, "Generated an image.");
        if (isAuthenticatedSession() && targetChatId) {
          settleImageGenerationUi(targetChatId, state);
          refreshCanonicalChatAfterImageGeneration(targetChatId)
            .then(() => scheduleChatListRefresh())
            .catch((error) => logAuthenticatedConversationError("image.refresh", error));
        }
      } else {
        const friendlyErr = "Sorry, I couldn\u2019t generate that image. Please try again.";
        const { contentDiv: imgErrDiv } = appendMessageBubble("assistant", "");
        typeMessage(friendlyErr, imgErrDiv);
        await safelyAddImageMessage(targetChatId, "assistant", friendlyErr, null, "image failure message");
      }
    } catch (err) {
      if (isRequestStale(targetChatId, requestId)) return;
      if (err.name === "AbortError") { /* user-initiated stop */ }
      else if (await maybeHandleProfileNameRequiredError(err, "image.generate")) {
        return;
      }
      else if (err.message && (err.message.includes("Daily image limit") || err.message.includes("Please wait"))) {
        showQuotaWarning(err.message);
      } else if (err.message && err.message.includes("queue is full")) {
        showQuotaWarning("The image generation server is busy. Please try again in a moment.");
      } else {
        const userFacingError = err.message && err.message.includes("couldn't be saved to your conversation")
          ? err.message
          : "Sorry, something went wrong generating that image. Please try again.";
        const { contentDiv: genErrDiv } = appendMessageBubble("assistant", "");
        typeMessage(userFacingError, genErrDiv);
        debugWarn(`[UI] Image generation error: ${getSafeErrorMessage(err)}`);
      }
    } finally {
      if (slowHintTimer) clearTimeout(slowHintTimer);
      // Clean up slow-hint text if it was added
      if (typingIndicator) {
        const hint = typingIndicator.querySelector(".slow-hint");
        if (hint) hint.remove();
      }
      settleImageGenerationUi(targetChatId, state);
      scheduleChatListRefresh();
    }
  }

  function isFileDragEvent(event) {
    const types = event?.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes("Files");
  }

  function getFileExtension(file) {
    const name = String(file?.name || "");
    const dotIndex = name.lastIndexOf(".");
    return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
  }

  function validateQueuedFile(file) {
    if (!file) return { ok: false, reason: "Invalid file." };
    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      return { ok: false, reason: `${file.name || "File"} is larger than 10MB.` };
    }
    const type = String(file.type || "").toLowerCase();
    const ext = getFileExtension(file);
    const supportedMime = SUPPORTED_UPLOAD_MIME_TYPES.has(type)
      || SUPPORTED_UPLOAD_MIME_PREFIXES.some((prefix) => type.startsWith(prefix));
    if (!supportedMime && !SUPPORTED_UPLOAD_EXTENSIONS.has(ext)) {
      return { ok: false, reason: `${file.name || "File"} is not a supported file type.` };
    }
    return { ok: true };
  }

  function addPendingFiles(files) {
    const incoming = Array.from(files || []);
    const accepted = [];
    const rejected = [];
    for (const file of incoming) {
      const validation = validateQueuedFile(file);
      if (validation.ok) accepted.push(file);
      else rejected.push(validation.reason);
    }
    pendingFiles.push(...accepted);
    if (rejected.length > 0) {
      showToast(rejected[0] + (rejected.length > 1 ? ` (${rejected.length} files skipped.)` : ""), "error", 4200);
    }
    return { accepted, rejected };
  }

  function queueDroppedFiles(files, options = {}) {
    if (!files || files.length === 0) return;
    if (ensureNameCapture()) return;
    const { showToastMessage = true } = options;
    imageMode = false;
    webSearchModeOverride = null;
    if (imageModeBar) imageModeBar.style.display = "none";
    if (webSearchModeBar) webSearchModeBar.style.display = "none";
    const { accepted } = addPendingFiles(files);
    renderFilePreview();
    syncComposerHint();
    chatInput?.focus();
    if (showToastMessage && accepted.length > 0) {
      showToast(`${accepted.length} file(s) ready to upload. Type a message and send.`, "info");
    }
  }

  function handleFileSelect(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (ensureNameCapture()) {
      if (fileInput) fileInput.value = "";
      return;
    }
    closeComposerMenu();
    imageMode = false;
    webSearchModeOverride = null;
    if (imageModeBar) imageModeBar.style.display = "none";
    if (webSearchModeBar) webSearchModeBar.style.display = "none";
    addPendingFiles(files);
    renderFilePreview();
    if (fileInput) fileInput.value = "";
    syncComposerHint();
    chatInput?.focus();
  }

  function createPastedImageFile(blob, index = 0) {
    const extension = blob?.type === "image/jpeg" ? "jpg" : (blob?.type?.split("/")[1] || "png");
    const timestamp = Date.now();
    const suffix = index > 0 ? `-${index + 1}` : "";
    return new File([blob], `pasted-image-${timestamp}${suffix}.${extension}`, {
      type: blob?.type || "image/png",
      lastModified: timestamp,
    });
  }

  async function handleComposerPaste(event) {
    if (!event?.clipboardData?.items?.length) return;
    if (ensureNameCapture()) return;

    const pastedFiles = [];
    for (const item of event.clipboardData.items) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile?.();
      if (!file || !file.type?.startsWith("image/")) continue;
      pastedFiles.push(createPastedImageFile(file, pastedFiles.length));
    }

    if (pastedFiles.length === 0) return;

    event.preventDefault();
    closeComposerMenu();
    imageMode = false;
    webSearchModeOverride = null;
    if (imageModeBar) imageModeBar.style.display = "none";
    if (webSearchModeBar) webSearchModeBar.style.display = "none";
    addPendingFiles(pastedFiles);
    renderFilePreview();
    syncComposerHint();
    chatInput?.focus();
  }

  function formatFileSize(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.ceil(value / 1024)} KB`;
    return `${value} B`;
  }

  function renderFilePreview() {
    if (!filePreviewArea) return;
    if (pendingFiles.length === 0) {
      filePreviewArea.style.display = "none";
      updateComposerActionSelection();
      return;
    }
    filePreviewArea.style.display = "flex";
    filePreviewArea.innerHTML = "";
    pendingFiles.forEach((file, index) => {
      const chip = document.createElement("div");
      chip.className = "file-chip";
      chip.title = `${file.name} - ${formatFileSize(file.size)}`;
      const icon = document.createElement("span");
      icon.className = "file-chip-icon";
      icon.textContent = isNativeChatImageFile(file) ? "IMG" : "FILE";
      icon.textContent = "📄";
      icon.textContent = isNativeChatImageFile(file) ? "IMG" : "FILE";
      const name = document.createElement("span");
      name.className = "file-chip-name";
      name.textContent = file.name.length > 25 ? file.name.slice(0, 22) + "..." : file.name;
      const meta = document.createElement("span");
      meta.className = "file-chip-meta";
      meta.textContent = formatFileSize(file.size);
      const removeBtn = document.createElement("button");
      removeBtn.className = "file-chip-remove";
      removeBtn.type = "button";
      removeBtn.textContent = "✕";
      removeBtn.textContent = "x";
      removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
      removeBtn.addEventListener("click", () => { pendingFiles.splice(index, 1); renderFilePreview(); });
      chip.appendChild(icon);
      chip.appendChild(name);
      chip.appendChild(meta);
      chip.appendChild(removeBtn);
      filePreviewArea.appendChild(chip);
    });
    updateComposerActionSelection();
  }

  function isNativeChatImageFile(file) {
    return Boolean(file && resolveChatImageMimeType(file));
  }

  function resolveChatImageMimeType(file) {
    if (!file) return "";
    const explicitType = String(file.type || "").toLowerCase();
    if (["image/png", "image/jpeg", "image/webp"].includes(explicitType)) return explicitType;
    const name = String(file.name || "").toLowerCase();
    if (name.endsWith(".png")) return "image/png";
    if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
    if (name.endsWith(".webp")) return "image/webp";
    return "";
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("Unable to read image."));
      reader.readAsDataURL(file);
    });
  }

  async function buildImageAttachment(file) {
    const base64 = await readFileAsBase64(file);
    const mimeType = resolveChatImageMimeType(file) || "image/png";
    return {
      filename: file.name,
      mime_type: mimeType,
      base64,
      size_bytes: file.size,
    };
  }

  async function runWithConcurrencyLimit(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit || 1), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = { status: "fulfilled", value: await worker(items[index], index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }));
    return results;
  }

  function buildImageUploadMeta(attachments) {
    return {
      type: "image-upload",
      images: attachments.map((image) => ({
        filename: image.filename,
        mime_type: image.mime_type,
        size_bytes: image.size_bytes,
      })),
    };
  }

  async function processPendingFiles(message) {
    const filesToProcess = [...pendingFiles];
    pendingFiles = [];
    renderFilePreview();
    const imageFiles = filesToProcess.filter(isNativeChatImageFile);
    const regularFiles = filesToProcess.filter((file) => !isNativeChatImageFile(file));
    const imageAttachmentResults = await Promise.allSettled(imageFiles.map(buildImageAttachment));
    const imageAttachments = [];
    imageAttachmentResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        imageAttachments.push(result.value);
        return;
      }
      const file = imageFiles[index];
      const { contentDiv: upErrDiv } = appendMessageBubble("assistant", "");
      typeMessage(`Sorry, I couldn't read ${file.name}. Please try again.`, upErrDiv);
      debugWarn(`[UI] Image read error: ${getSafeErrorMessage(result.reason)}`);
    });

    const uploadResults = await runWithConcurrencyLimit(regularFiles, 2, async (file) => {
      const localUploadId = crypto.randomUUID();
      const uploadMeta = { type: "file-upload", filename: file.name };
      const { contentDiv } = appendMessageBubble("user", `Uploaded file: ${file.name}`, uploadMeta);
      const statusEntry = attachFileAnalysisStatus(contentDiv, "processing", "Uploading and analyzing...");
      if (statusEntry) {
        pendingFileUploadUi.set(localUploadId, { ...statusEntry, filename: file.name });
      }
      await persistChatMessage(currentChatId, "user", `Uploaded file: ${file.name}`);
      showActivityIndicator("thinking", { chatId: currentChatId, withTimer: false, persist: false });
      scrollToBottom();
      try {
        const result = await API.uploadFile(file);
        const analysisId = result.analysis_id || localUploadId;
        const pendingEntry = pendingFileUploadUi.get(localUploadId);
        pendingFileUploadUi.delete(localUploadId);
        const sessionFile = {
          filename: result.filename,
          type: result.type,
          extracted_text: result.extracted_text,
          size_bytes: result.size_bytes,
          timestamp: new Date().toISOString(),
          analysis_id: analysisId,
        };
        if (pendingEntry) {
          fileAnalysisUi.set(analysisId, { ...pendingEntry, filename: result.filename, fileType: result.type });
          const status = result.analysis_status || "processing";
          const label = status === "complete" ? "Analysis ready" : "Analyzing file...";
          setFileAnalysisStatus(pendingEntry, status, label);
          const queuedEvent = pendingFileAnalysisEvents.get(analysisId);
          if (queuedEvent) {
            pendingFileAnalysisEvents.delete(analysisId);
            applyFileAnalysisEvent(queuedEvent);
          }
        }
        if (isAuthenticatedSession()) {
          await Storage.storeFile({
            filename: result.filename, type: result.type,
            extracted_text: result.extracted_text, size_bytes: result.size_bytes, blob: file,
          });
        }
        return sessionFile;
      } catch (err) {
        const pendingEntry = pendingFileUploadUi.get(localUploadId);
        if (pendingEntry) {
          setFileAnalysisStatus(pendingEntry, "error", "Upload failed");
          pendingFileUploadUi.delete(localUploadId);
        }
        if (!(await maybeHandleProfileNameRequiredError(err, "file.upload"))) {
          const { contentDiv: upErrDiv } = appendMessageBubble("assistant", "");
          typeMessage(`Sorry, I couldn\u2019t process that file. Please try again.`, upErrDiv);
          debugWarn(`[UI] Upload error: ${getSafeErrorMessage(err)}`);
        }
        return null;
      } finally {
        hideActivityIndicator(null);
      }
    });

    for (let i = uploadResults.length - 1; i >= 0; i--) {
      const result = uploadResults[i];
      if (result?.status === "fulfilled" && result.value) {
        currentSessionFile = result.value;
        break;
      }
    }
    if (message || imageAttachments.length > 0) {
      await handleSend(null, {
        message,
        imageAttachments,
        skipPendingFileProcessing: true,
      });
    }
    scheduleChatListRefresh();
  }

  function handleVoiceInput() {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      alert("Voice input is not supported in this browser.");
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    voiceBtn?.classList.add("active");
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (chatInput) { chatInput.value += transcript; autoResizeInput(); }
      voiceBtn?.classList.remove("active");
    };
    recognition.onerror = () => { voiceBtn?.classList.remove("active"); };
    recognition.onend = () => { voiceBtn?.classList.remove("active"); };
    recognition.start();
  }

  function openSettings() {
    if (settingsModal) {
      settingsModal.style.display = "flex";
      settingsModal.setAttribute("aria-hidden", "false");
    }
    closeSidebar();
    updateOverlayLocks();
    window.SentIQMemoryPanel?.renderMemories({ refreshCloud: true });
  }
  function closeSettings() {
    if (settingsModal) {
      settingsModal.style.display = "none";
      settingsModal.setAttribute("aria-hidden", "true");
    }
    updateOverlayLocks();
  }

  function resetGuestSession() {
    const previousChatId = currentChatId;
    abortCurrentGeneration();
    hideSelectionButton();
    pendingSelectionPayload = null;
    closeComposerMenu();
    setImageMode(false);
    setWebSearchModeOverride(null);
    clearPendingFiles();
    if (chatInput) {
      chatInput.value = "";
      chatInput.style.height = "auto";
    }
    currentSessionFile = null;
    currentSessionImageAttachments = [];
    if (scrollAnchorPill) scrollAnchorPill.classList.remove("visible");
    if (previousChatId) {
      chatStates.delete(previousChatId);
      chatRenderSignatures.delete(previousChatId);
      welcomeGreetingByChatId.delete(previousChatId);
    }
    const guestChat = resetGuestChatState();
    renderLoadedChat(guestChat.id, guestChat, { forceRender: true });
    updateHtmlTitle("");
    loadChatList(true);
    return guestChat;
  }

  async function startNewChat() {
    debugLog("[UI] startNewChat");
    const stopMeasure = startPerf("ui.new_chat");
    if (ensureNameCapture()) {
      stopMeasure("blocked", { reason: "name_required" });
      return;
    }
    if (isGuestSession()) {
      const guestChat = resetGuestSession();
      stopMeasure("ok", { chat_id: guestChat?.id || "", guest: true });
      if (chatInput) chatInput.focus();
      closeSidebar();
      return;
    }
    let chat;
    let pendingChat = null;
    try {
      if (isAuthenticatedSession()) {
        pendingChat = await createPendingServerChat("New Chat");
        renderLoadedChat(pendingChat.id, { ...pendingChat, messages: [] });
        await loadChatList(true);
        stopMeasure("placeholder_ready", { chat_id: pendingChat.id });
        ensureRemoteConversationForChat(pendingChat.id)
          .then(async (actualChatId) => {
            if (!actualChatId) return;
            if (currentChatId === actualChatId) {
              const actualChat = await Storage.getChat(actualChatId);
              if (actualChat) renderLoadedChat(actualChatId, actualChat);
            }
            await loadChatList(true);
            processSyncQueue().catch((error) => {
              logAuthenticatedConversationError("startNewChat.queue", error);
            });
          })
          .catch(async (error) => {
            if (await maybeHandleProfileNameRequiredError(error, "new_chat.background_create")) {
              return;
            }
            logAuthenticatedConversationError("startNewChat.backgroundCreate", error);
          });
        chat = pendingChat;
      } else {
        chat = await Storage.createChat("New Chat");
      }
    } catch (error) {
      stopMeasure("error");
      logAuthenticatedConversationError("startNewChat", error);
      await removePendingServerChat(pendingChat?.id || null);
      if (isAuthenticatedSession()) {
        showToast("Couldn't start a new chat right now. Please try again.", "error");
      }
      return;
    }
    currentChatId = chat.id;
    syncActiveChatItem();
    currentSessionFile = null;
    currentSessionImageAttachments = [];
    pendingClarifications.clear();
    if (chatMessages) chatMessages.innerHTML = "";
    showWelcome();
    updateHtmlTitle("");
    await loadChatList(true);
    stopMeasure("ok", { chat_id: chat.id });
    if (chatInput) chatInput.focus();
    closeSidebar();
  }

  function updateHtmlTitle(chatTitle) {
    document.title = chatTitle ? `${chatTitle} — SentIQGPT` : "SentIQGPT";
  }

  function typeChatTitle(chatId, title) {
    const titleEl = chatList?.querySelector(`[data-id="${chatId}"] .chat-list-item-title`);
    if (!titleEl) return Promise.resolve();
    return new Promise((resolve) => {
      titleEl.textContent = "";
      titleEl.classList.add("typing");
      let i = 0;
      const interval = setInterval(() => {
        titleEl.textContent = title.slice(0, ++i);
        if (i >= title.length) {
          clearInterval(interval);
          titleEl.classList.remove("typing");
          resolve();
        }
      }, 30);
    });
  }

  async function maybeGenerateTitle(userMessage, assistantReply) {
    if (!currentChatId || !isAuthenticatedSession()) return;
    let titleChatId = currentChatId;
    let chat = await Storage.getChat(currentChatId);
    if (isAuthenticatedSession() && isPlaceholderServerChat(chat)) {
      try {
        titleChatId = await ensureRemoteConversationForChat(currentChatId);
        chat = await Storage.getChat(titleChatId);
      } catch {
        return;
      }
    }
    const msgCount = isAuthenticatedSession()
      ? (chatMessages?.querySelectorAll(".message.user").length || chat?.messages?.filter((m) => m.role === "user").length || 0)
      : (chat?.messages?.filter((m) => m.role === "user").length || 0);
    if (msgCount > 1) return;
    try {
      const result = await API.generateTitle(userMessage, assistantReply, titleChatId);
      if (result.title) {
        await Storage.updateChatTitle(titleChatId, result.title, {
          pendingTitleSync: false,
          titleSyncError: null,
          lastTitleSyncedAt: new Date().toISOString(),
        });
        await loadChatList(true);
        await typeChatTitle(titleChatId, result.title);
        updateHtmlTitle(result.title);
      }
    } catch { /* non-critical */ }
  }

  let scrollToBottomRaf = 0;
  let pendingInstantScroll = false;
  function scrollToBottom(instant) {
    if (!chatMessages) return;
    if (_userScrolledUp) {
      // Show "new messages" pill instead of forcing scroll
      if (scrollAnchorPill) scrollAnchorPill.classList.add("visible");
      return;
    }
    pendingInstantScroll = pendingInstantScroll || Boolean(instant);
    if (scrollToBottomRaf) return;
    scrollToBottomRaf = requestAnimationFrame(() => {
      scrollToBottomRaf = 0;
      const behavior = pendingInstantScroll ? "auto" : "smooth";
      pendingInstantScroll = false;
      chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.SentIQGetSafeErrorMessage = getSafeErrorMessage;
  window.SentIQChat = {
    copyCode,
    appendMessageBubble,
    loadChatList,
    openSettings,
    closeSettings,
    syncCloudMemoriesFromServer,
    processSyncQueue,
    queueSyncJob,
    syncJobTypes: SYNC_JOB_TYPES,
  };
})();
