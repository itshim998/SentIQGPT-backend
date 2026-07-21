/* SentIQ Liquid Glass V4 — Phase 9.4 conversation continuity */

import {
  CONVERSATION_CONTINUITY_VERSION,
  captureReadingRecord,
  deriveConversationActivity,
  draftRecordHasContent,
  draftRecordIsMeaningful,
  normalizeContinuityRegistry,
  normalizeDraftRecord,
  removeConversationContinuity,
  resolveRestoredScrollTop,
  updateRegistryDraft,
  updateRegistryReading,
} from "./conversation-continuity-model.mjs";
import { createContinuityConfirmationDialog } from "./conversation-continuity-dialog.js";

const REGISTRY_PREFIX = "conversation_continuity:v1:";
const LAST_ACTIVE_CHAT_PREFIX = "last_active_chat_id:";
const GUEST_CONVERSATION_ID = "guest-current";
const SAVE_DELAY_MS = 180;
const SCROLL_SAVE_DELAY_MS = 140;
const ACTIVITY_REFRESH_MS = 2500;
const TRANSIENT_ACTIVITY_GRACE_MS = 15_000;
const RESTORE_WINDOW_MS = 2400;

function initializeConversationContinuity() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQConversationContinuity?.version === CONVERSATION_CONTINUITY_VERSION) return;

  const Storage = window.SentIQStorage;
  if (!Storage?.getConfig || !Storage?.setConfig) return;

  const chatInput = document.getElementById("chat-input");
  const chatMessages = document.getElementById("chat-messages");
  const chatList = document.getElementById("chat-list");
  const sendButton = document.getElementById("send-btn");
  const newChatButton = document.getElementById("new-chat-btn");
  const filePreviewArea = document.getElementById("file-preview-area");
  const selectedContextBar = document.getElementById("selected-context-bar");
  const imageModeBar = document.getElementById("image-mode-bar");
  const webModeBar = document.getElementById("web-search-mode-bar");
  const deepResearchModeBar = document.getElementById("deep-research-mode-bar");
  const executionModeMenu = document.getElementById("execution-mode-menu");
  const confirmation = createContinuityConfirmationDialog();

  let scope = String(Storage.getActiveUserId?.() || "").trim() || "guest";
  let registry = normalizeContinuityRegistry();
  let registryLoaded = false;
  let registryLoadPromise = null;
  let persistPromise = Promise.resolve();
  let saveTimer = 0;
  let scrollSaveTimer = 0;
  let activationTimer = 0;
  let activityTimer = 0;
  let currentConversationId = "";
  let restoring = false;
  let applyingScroll = false;
  let restoreWindowUntil = 0;
  let restoreSequence = 0;
  let pendingPersist = false;
  let guardInProgress = false;
  let activityRefreshPromise = null;
  const replayBypass = new WeakSet();
  const transientActivities = new Map();
  const listeners = new Set();

  function registryKey(targetScope = scope) {
    return `${REGISTRY_PREFIX}${targetScope || "guest"}`;
  }

  function sessionScope(session) {
    return String(session?.user?.id || session?.user?.sub || "").trim() || "guest";
  }

  function isSignedInScope(targetScope = scope) {
    return Boolean(targetScope && targetScope !== "guest");
  }

  async function loadRegistry(targetScope = scope) {
    if (registryLoaded && targetScope === scope) return registry;
    if (registryLoadPromise) return registryLoadPromise;
    const requestedScope = targetScope || "guest";
    registryLoadPromise = Storage.getConfig(registryKey(requestedScope))
      .then((value) => normalizeContinuityRegistry(value))
      .catch(() => normalizeContinuityRegistry())
      .then((value) => {
        if (scope === requestedScope) {
          registry = value;
          registryLoaded = true;
        }
        return value;
      })
      .finally(() => {
        registryLoadPromise = null;
      });
    return registryLoadPromise;
  }

  function queuePersist(delay = SAVE_DELAY_MS) {
    pendingPersist = true;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void persistRegistry(); }, Math.max(0, delay));
  }

  async function persistRegistry() {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    if (!pendingPersist) return persistPromise;
    pendingPersist = false;
    const targetScope = scope;
    const snapshot = normalizeContinuityRegistry(registry);
    persistPromise = persistPromise
      .catch(() => null)
      .then(() => Storage.setConfig(registryKey(targetScope), snapshot))
      .catch((error) => {
        pendingPersist = true;
        window.SentIQChat?.debugWarn?.("[Continuity] Registry save failed:", error);
      });
    return persistPromise;
  }

  function isElementVisible(element) {
    if (!(element instanceof HTMLElement) || element.hidden) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    return getComputedStyle(element).display !== "none";
  }

  function readToolMode() {
    if (isElementVisible(deepResearchModeBar)) return "deep-research";
    if (isElementVisible(imageModeBar)) return "image";
    if (isElementVisible(webModeBar)) return "web-basic";
    return "none";
  }

  function readExecutionMode() {
    const active = executionModeMenu?.querySelector(
      "[data-execution-mode].active, [data-execution-mode][aria-checked='true'], [data-execution-mode][aria-selected='true']",
    );
    const mode = active?.getAttribute("data-execution-mode");
    return mode === "intuitive" ? "intuitive" : "fast";
  }

  function readModeSnapshot() {
    return {
      toolMode: readToolMode(),
      executionMode: readExecutionMode(),
    };
  }

  function hasAttachments() {
    const stateCount = Number(window.SentIQUIState?.getFacts?.()?.attachmentCount || 0);
    if (stateCount > 0) return true;
    return Boolean(filePreviewArea?.querySelector("[data-attachment-state], .file-preview-item, .composer-attachment-card"));
  }

  function hasSelectionContext() {
    return Boolean(selectedContextBar && !selectedContextBar.hidden && selectedContextBar.getAttribute("aria-hidden") !== "true");
  }

  function currentDraftRecord() {
    return normalizeDraftRecord({
      text: chatInput?.value || "",
      mode: readModeSnapshot(),
      updatedAt: Date.now(),
    });
  }

  function saveDraftFor(conversationId = currentConversationId) {
    if (restoring || !conversationId) return;
    registry = updateRegistryDraft(registry, conversationId, currentDraftRecord());
    queuePersist();
    decorateConversationList();
  }

  function captureReadingFor(conversationId = currentConversationId) {
    if (!conversationId || !chatMessages || applyingScroll) return;
    const messages = [...chatMessages.querySelectorAll(".message")];
    const scrollTop = chatMessages.scrollTop;
    const anchorIndex = messages.findIndex((message) => (
      message.offsetTop + message.offsetHeight > scrollTop + 1
    ));
    const anchor = anchorIndex >= 0 ? messages[anchorIndex] : null;
    const record = captureReadingRecord({
      scrollTop,
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
      anchorFromEnd: anchor ? messages.length - anchorIndex - 1 : null,
      anchorOffset: anchor ? scrollTop - anchor.offsetTop : 0,
      updatedAt: Date.now(),
    });
    registry = updateRegistryReading(registry, conversationId, record);
    queuePersist();
  }

  function scheduleDraftSave(delay = SAVE_DELAY_MS) {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveDraftFor(), delay);
  }

  function scheduleReadingSave() {
    if (applyingScroll || !currentConversationId) return;
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(() => captureReadingFor(), SCROLL_SAVE_DELAY_MS);
  }

  async function flushCurrent() {
    window.clearTimeout(saveTimer);
    window.clearTimeout(scrollSaveTimer);
    saveTimer = 0;
    scrollSaveTimer = 0;
    saveDraftFor();
    captureReadingFor();
    await persistRegistry();
  }

  function capabilityAvailable(key) {
    const capability = window.SentIQCapabilities?.get?.(key);
    return capability ? capability.available : true;
  }

  function clickIfVisible(element) {
    if (isElementVisible(element) && typeof element.click === "function") element.click();
  }

  function clearToolModes() {
    clickIfVisible(document.getElementById("cancel-image-mode"));
    clickIfVisible(document.getElementById("cancel-web-search-mode"));
    clickIfVisible(document.getElementById("cancel-deep-research-mode"));
  }

  function restoreToolMode(toolMode) {
    clearToolModes();
    document.documentElement.removeAttribute("data-continuity-mode-blocked");
    if (toolMode === "image") {
      if (!capabilityAvailable("image-generation")) {
        document.documentElement.dataset.continuityModeBlocked = "image";
        return false;
      }
      document.getElementById("image-gen-btn")?.click();
      return true;
    }
    if (toolMode === "deep-research") {
      if (!capabilityAvailable("deep-research")) {
        document.documentElement.dataset.continuityModeBlocked = "deep-research";
        return false;
      }
      document.getElementById("deep-research-btn")?.click();
      return true;
    }
    if (toolMode === "web-basic") {
      document.getElementById("websurf-basic-btn")?.click();
      return true;
    }
    return true;
  }

  function restoreExecutionMode(executionMode) {
    const target = executionMode === "intuitive" ? "intuitive" : "fast";
    const option = executionModeMenu?.querySelector(`[data-execution-mode="${target}"]`);
    if (option instanceof HTMLButtonElement && !option.disabled && readExecutionMode() !== target) {
      option.click();
    }
  }

  function restoreReadingPosition(conversationId, sequence) {
    if (!chatMessages || !conversationId || sequence !== restoreSequence) return;
    const record = registry.reading[conversationId];
    if (!record) return;
    const messages = [...chatMessages.querySelectorAll(".message")];
    const anchorIndex = record.anchorFromEnd === null
      ? -1
      : messages.length - 1 - record.anchorFromEnd;
    const anchor = anchorIndex >= 0 && anchorIndex < messages.length ? messages[anchorIndex] : null;
    const nextScrollTop = resolveRestoredScrollTop(record, {
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
      anchorOffsetTop: anchor?.offsetTop,
    });
    applyingScroll = true;
    chatMessages.scrollTop = nextScrollTop;
    window.requestAnimationFrame(() => { applyingScroll = false; });
  }

  function scheduleReadingRestore(conversationId, sequence = restoreSequence) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => restoreReadingPosition(conversationId, sequence));
    });
  }

  async function moveContinuityAcrossAlias(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const fromChat = await Storage.getChat?.(fromId).catch(() => null);
    if (fromChat) return;
    let changed = false;
    if (registry.drafts[fromId] && !registry.drafts[toId]) {
      registry.drafts[toId] = registry.drafts[fromId];
      delete registry.drafts[fromId];
      changed = true;
    }
    if (registry.reading[fromId] && !registry.reading[toId]) {
      registry.reading[toId] = registry.reading[fromId];
      delete registry.reading[fromId];
      changed = true;
    }
    if (changed) queuePersist(0);
  }

  async function restoreConversation(conversationId, previousId = "") {
    if (!conversationId) return;
    await loadRegistry();
    if (previousId) await moveContinuityAcrossAlias(previousId, conversationId);
    const sequence = ++restoreSequence;
    const record = registry.drafts[conversationId] || normalizeDraftRecord();
    restoring = true;
    if (chatInput) {
      chatInput.value = record.text;
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      chatInput.dataset.continuityDraft = record.text.trim() ? "restored" : "empty";
    }
    restoreToolMode(record.mode.toolMode);
    restoreExecutionMode(record.mode.executionMode);
    restoring = false;
    restoreWindowUntil = Date.now() + RESTORE_WINDOW_MS;
    scheduleReadingRestore(conversationId, sequence);
    document.documentElement.dataset.continuityConversation = conversationId;
    document.dispatchEvent(new CustomEvent("sentiq-conversation-continuity-restored", {
      detail: { conversationId, hasDraft: draftRecordHasContent(record), mode: record.mode },
    }));
    listeners.forEach((listener) => {
      try { listener({ conversationId, record, registry }); } catch { /* subscriber isolation */ }
    });
  }

  function activeListConversationId() {
    return chatList?.querySelector(".chat-list-item.active[data-id]")?.getAttribute("data-id") || "";
  }

  async function resolveActiveConversationId() {
    const listId = activeListConversationId();
    if (listId) return listId;
    if (!isSignedInScope()) return GUEST_CONVERSATION_ID;
    const lastActive = await Storage.getConfig(`${LAST_ACTIVE_CHAT_PREFIX}${scope}`).catch(() => "");
    if (typeof lastActive !== "string" || !lastActive.trim()) return "";
    const chat = await Storage.getChat?.(lastActive).catch(() => null);
    return chat?.id || "";
  }

  async function reconcileActiveConversation() {
    const nextId = await resolveActiveConversationId();
    if (!nextId || nextId === currentConversationId) {
      decorateConversationList();
      return;
    }
    const previousId = currentConversationId;
    if (previousId) {
      saveDraftFor(previousId);
      captureReadingFor(previousId);
    } else if (chatInput?.value) {
      registry = updateRegistryDraft(registry, nextId, currentDraftRecord());
      queuePersist();
    }
    currentConversationId = nextId;
    await restoreConversation(nextId, previousId);
    void refreshConversationActivities();
  }

  function scheduleActivation(delay = 60) {
    window.clearTimeout(activationTimer);
    activationTimer = window.setTimeout(() => { void reconcileActiveConversation(); }, Math.max(0, delay));
  }

  function markTransientActivity(conversationId, type) {
    if (!conversationId || !["streaming", "research"].includes(type)) return;
    transientActivities.set(conversationId, { type, updatedAt: Date.now() });
    decorateConversationList();
  }

  function activityForConversation(conversationId) {
    return transientActivities.get(conversationId)?.activity || null;
  }

  function draftMarkerFor(item, conversationId) {
    const hasDraft = draftRecordHasContent(registry.drafts[conversationId]);
    item.classList.toggle("has-saved-draft", hasDraft);
    let marker = item.querySelector(":scope > .conversation-draft-marker");
    if (!hasDraft) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "conversation-draft-marker";
      marker.setAttribute("aria-label", "Unsent draft saved");
      marker.title = "Unsent draft saved";
      marker.innerHTML = '<span aria-hidden="true"></span>';
      const firstAction = item.querySelector(".chat-rename-btn, .chat-delete-btn");
      item.insertBefore(marker, firstAction || null);
    }
  }

  function activityMarkerFor(item, conversationId) {
    const activity = conversationId === currentConversationId ? null : activityForConversation(conversationId);
    item.classList.toggle("has-background-activity", Boolean(activity));
    if (activity) item.dataset.backgroundActivity = activity.type;
    else delete item.dataset.backgroundActivity;
    let marker = item.querySelector(":scope > .conversation-activity-indicator");
    if (!activity) {
      marker?.remove();
      return;
    }
    if (!marker) {
      marker = document.createElement("span");
      marker.className = "conversation-activity-indicator";
      marker.innerHTML = '<span class="conversation-activity-dot" aria-hidden="true"></span><span class="conversation-activity-label"></span>';
      const firstAction = item.querySelector(".chat-rename-btn, .chat-delete-btn");
      item.insertBefore(marker, firstAction || null);
    }
    marker.querySelector(".conversation-activity-label").textContent = activity.label;
    marker.setAttribute("aria-label", `${activity.label} in this conversation`);
    marker.title = `${activity.label} in this conversation`;
  }

  function decorateConversationList() {
    chatList?.querySelectorAll(".chat-list-item[data-id]").forEach((item) => {
      const conversationId = item.getAttribute("data-id") || "";
      draftMarkerFor(item, conversationId);
      activityMarkerFor(item, conversationId);
    });
  }

  async function refreshConversationActivities() {
    if (activityRefreshPromise) return activityRefreshPromise;
    activityRefreshPromise = (async () => {
      const now = Date.now();
      const chats = await Storage.getAllChats?.().catch(() => []) || [];
      const persistedIds = new Set();
      for (const chat of chats) {
        if (!chat?.id) continue;
        const activity = deriveConversationActivity(chat, now);
        if (activity) {
          persistedIds.add(chat.id);
          transientActivities.set(chat.id, { activity, type: activity.type, updatedAt: now });
        }
      }
      for (const [conversationId, entry] of transientActivities) {
        if (persistedIds.has(conversationId)) continue;
        if (now - Number(entry.updatedAt || 0) > TRANSIENT_ACTIVITY_GRACE_MS) {
          transientActivities.delete(conversationId);
        } else if (!entry.activity && entry.type) {
          const label = entry.type === "research" ? "Researching" : "Generating";
          transientActivities.set(conversationId, {
            ...entry,
            activity: { type: entry.type, label, updatedAt: entry.updatedAt },
          });
        }
      }
      decorateConversationList();
      document.dispatchEvent(new CustomEvent("sentiq-conversation-activity-change", {
        detail: {
          activities: Object.fromEntries(
            [...transientActivities.entries()]
              .filter(([, value]) => value.activity)
              .map(([id, value]) => [id, value.activity]),
          ),
        },
      }));
    })().finally(() => { activityRefreshPromise = null; });
    return activityRefreshPromise;
  }

  function startActivityRefreshLoop() {
    window.clearInterval(activityTimer);
    activityTimer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshConversationActivities();
    }, ACTIVITY_REFRESH_MS);
  }

  function stopForegroundStreamingBeforeNavigation() {
    if (!sendButton?.classList.contains("is-stop")) return false;
    if (currentConversationId) markTransientActivity(currentConversationId, "streaming");
    sendButton.click();
    document.documentElement.dataset.continuityStreamingIsolation = "stopped-before-navigation";
    return true;
  }

  function currentDiscardRisk(options = {}) {
    const record = currentDraftRecord();
    return draftRecordIsMeaningful(record, {
      hasAttachments: options.includeNonPersistent !== false && hasAttachments(),
      hasSelectionContext: options.includeNonPersistent !== false && hasSelectionContext(),
    });
  }

  function storedDraftRisk(conversationId) {
    return draftRecordIsMeaningful(registry.drafts[conversationId]);
  }

  function guardRequest(control) {
    if (!(control instanceof HTMLElement)) return null;
    const deleteButton = control.closest(".chat-delete-btn");
    if (deleteButton) {
      const item = deleteButton.closest(".chat-list-item[data-id]");
      const conversationId = item?.getAttribute("data-id") || "";
      const active = item?.classList.contains("active");
      const risky = storedDraftRisk(conversationId) || (active && currentDiscardRisk());
      return {
        control: deleteButton,
        kind: "delete",
        conversationId,
        risky,
        title: "Delete this conversation and its draft?",
        message: "The conversation, its saved reading position, and any unsent draft in it will be removed.",
        confirmLabel: "Delete conversation",
        intent: "danger",
      };
    }

    if (control.closest("#new-chat-btn")) {
      const guestTextWillBeDiscarded = !isSignedInScope() && currentDiscardRisk({ includeNonPersistent: false });
      const risky = guestTextWillBeDiscarded || hasAttachments() || hasSelectionContext();
      return {
        control: newChatButton,
        kind: "new-chat",
        conversationId: currentConversationId,
        risky,
        title: "Start a new conversation?",
        message: isSignedInScope()
          ? "Your typed draft is saved with this conversation, but attached files or selected context cannot move to the new chat."
          : "This guest draft cannot be revisited after starting a new conversation.",
        confirmLabel: "Start new conversation",
      };
    }

    const logout = control.closest("#auth-logout-btn, #auth-menu-logout-btn, #account-signout-btn");
    if (logout) {
      return {
        control: logout,
        kind: "logout",
        conversationId: currentConversationId,
        risky: hasAttachments() || hasSelectionContext(),
        title: "Sign out with unsent attachments?",
        message: "Your typed draft is saved, but attached files and selected response context will be cleared when you sign out.",
        confirmLabel: "Sign out",
      };
    }

    const chatItem = control.closest(".chat-list-item[data-id]");
    if (chatItem && !control.closest(".chat-rename-btn, .chat-delete-btn, .chat-rename-input")) {
      const conversationId = chatItem.getAttribute("data-id") || "";
      if (!conversationId || conversationId === currentConversationId || chatItem.classList.contains("active")) return null;
      return {
        control: chatItem,
        kind: "switch",
        conversationId,
        risky: hasAttachments() || hasSelectionContext(),
        title: "Switch conversations?",
        message: "Your typed draft is saved here, but attached files and selected response context cannot be restored after switching.",
        confirmLabel: "Switch conversation",
      };
    }
    return null;
  }

  async function replayGuardedAction(request) {
    if (!request?.control?.isConnected) return;
    guardInProgress = true;
    try {
      await flushCurrent();
      if (request.kind === "delete") {
        registry = removeConversationContinuity(registry, request.conversationId);
        queuePersist(0);
      }
      if (request.kind === "new-chat" && !isSignedInScope()) {
        registry = removeConversationContinuity(registry, GUEST_CONVERSATION_ID);
        queuePersist(0);
      }
      stopForegroundStreamingBeforeNavigation();
      replayBypass.add(request.control);
      request.control.click();
      scheduleActivation(request.kind === "new-chat" ? 260 : 100);
      window.setTimeout(() => void refreshConversationActivities(), 120);
    } finally {
      guardInProgress = false;
    }
  }

  function handleGuardedClick(event) {
    if (!(event.target instanceof Element) || confirmation.isOpen()) return;
    const control = event.target.closest("#new-chat-btn, #auth-logout-btn, #auth-menu-logout-btn, #account-signout-btn, .chat-list-item[data-id]");
    if (!(control instanceof HTMLElement)) return;
    if (replayBypass.has(control)) {
      replayBypass.delete(control);
      return;
    }
    const request = guardRequest(event.target);
    if (!request) return;
    if (!request.risky) {
      void flushCurrent();
      stopForegroundStreamingBeforeNavigation();
      if (request.kind === "delete") {
        registry = removeConversationContinuity(registry, request.conversationId);
        queuePersist(0);
      }
      if (request.kind === "new-chat" && !isSignedInScope()) {
        registry = removeConversationContinuity(registry, GUEST_CONVERSATION_ID);
        queuePersist(0);
      }
      scheduleActivation(request.kind === "new-chat" ? 260 : 100);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (guardInProgress) return;
    void confirmation.confirm(request).then((confirmed) => {
      if (confirmed) return replayGuardedAction(request);
      return null;
    });
  }

  async function changeScope(nextScope) {
    const normalized = nextScope || "guest";
    if (normalized === scope && registryLoaded) return;
    await flushCurrent();
    scope = normalized;
    registryLoaded = false;
    registry = normalizeContinuityRegistry();
    currentConversationId = "";
    transientActivities.clear();
    await loadRegistry(scope);
    scheduleActivation(160);
  }

  chatInput?.addEventListener("input", () => {
    if (!restoring) scheduleDraftSave();
  });
  chatMessages?.addEventListener("scroll", scheduleReadingSave, { passive: true });

  document.addEventListener("click", handleGuardedClick, true);
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(
      "#image-gen-btn, #websurf-basic-btn, #deep-research-btn, #cancel-image-mode, #cancel-web-search-mode, #cancel-deep-research-mode, [data-execution-mode]",
    )) {
      window.setTimeout(() => scheduleDraftSave(0), 0);
    }
    if (event.target.closest("#send-btn")) {
      window.setTimeout(() => scheduleDraftSave(0), 0);
      window.setTimeout(() => void refreshConversationActivities(), 180);
    }
  }, true);

  document.addEventListener("sentiq-auth-changed", (event) => {
    void changeScope(sessionScope(event.detail?.session));
  });
  document.addEventListener("sentiq-capabilities-change", () => {
    const record = registry.drafts[currentConversationId];
    if (record && document.documentElement.hasAttribute("data-continuity-mode-blocked")) {
      restoring = true;
      restoreToolMode(record.mode.toolMode);
      restoring = false;
    }
  });
  document.addEventListener("sentiq-ui-state-change", (event) => {
    const state = event.detail || {};
    if (currentConversationId && (state.primary === "streaming" || state.facts?.streaming)) {
      markTransientActivity(currentConversationId, "streaming");
    }
    if (currentConversationId && (state.primary === "background-task" || state.facts?.backgroundTask)) {
      markTransientActivity(currentConversationId, "research");
    }
    scheduleActivation(20);
  });
  window.addEventListener("sentiq-billing-refresh", () => void refreshConversationActivities());
  window.addEventListener("pageshow", () => {
    scheduleActivation(80);
    void refreshConversationActivities();
  });
  window.addEventListener("beforeunload", (event) => {
    saveDraftFor();
    captureReadingFor();
    if (!pendingPersist && !hasAttachments() && !hasSelectionContext()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushCurrent();
    else {
      scheduleActivation(40);
      void refreshConversationActivities();
    }
  });

  if (chatList) {
    new MutationObserver(() => {
      decorateConversationList();
      scheduleActivation(25);
    }).observe(chatList, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-id"] });
  }
  if (chatMessages) {
    new MutationObserver(() => {
      if (Date.now() <= restoreWindowUntil && currentConversationId) {
        scheduleReadingRestore(currentConversationId);
      }
      window.setTimeout(() => void refreshConversationActivities(), 80);
    }).observe(chatMessages, { childList: true, subtree: true });
  }
  const modeTargets = [imageModeBar, webModeBar, deepResearchModeBar, executionModeMenu].filter(Boolean);
  if (modeTargets.length) {
    const modeObserver = new MutationObserver(() => {
      if (!restoring) scheduleDraftSave(30);
    });
    modeTargets.forEach((target) => modeObserver.observe(target, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "hidden", "aria-hidden", "aria-checked", "aria-selected"],
    }));
  }

  startActivityRefreshLoop();
  void loadRegistry(scope).then(() => {
    scheduleActivation(100);
    return refreshConversationActivities();
  });

  window.SentIQConversationContinuity = Object.freeze({
    version: CONVERSATION_CONTINUITY_VERSION,
    getScope: () => scope,
    getConversationId: () => currentConversationId,
    getRegistry: () => normalizeContinuityRegistry(registry),
    getDraft: (conversationId = currentConversationId) => registry.drafts[conversationId] || null,
    flush: flushCurrent,
    refresh: () => reconcileActiveConversation(),
    discard(conversationId = currentConversationId) {
      registry = removeConversationContinuity(registry, conversationId);
      queuePersist(0);
      if (conversationId === currentConversationId) void restoreConversation(conversationId);
    },
    subscribe(listener, options = {}) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (options.emitCurrent !== false) {
        listener({ conversationId: currentConversationId, record: registry.drafts[currentConversationId] || null, registry });
      }
      return () => listeners.delete(listener);
    },
  });

  document.documentElement.dataset.conversationContinuityVersion = CONVERSATION_CONTINUITY_VERSION;
}

initializeConversationContinuity();
