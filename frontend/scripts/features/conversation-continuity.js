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
const DRAFT_SAVE_DELAY_MS = 180;
const REGISTRY_SAVE_DELAY_MS = 180;
const SCROLL_SAVE_DELAY_MS = 120;
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
  let registryLoadScope = "";
  let persistPromise = Promise.resolve();
  let draftSaveTimer = 0;
  let registryPersistTimer = 0;
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
    const requestedScope = targetScope || "guest";
    if (registryLoaded && requestedScope === scope) return registry;
    if (registryLoadPromise && registryLoadScope === requestedScope) return registryLoadPromise;
    const loadPromise = Storage.getConfig(registryKey(requestedScope))
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
        if (registryLoadPromise === loadPromise) {
          registryLoadPromise = null;
          registryLoadScope = "";
        }
      });
    registryLoadPromise = loadPromise;
    registryLoadScope = requestedScope;
    return loadPromise;
  }

  function queuePersist(delay = REGISTRY_SAVE_DELAY_MS) {
    pendingPersist = true;
    window.clearTimeout(registryPersistTimer);
    registryPersistTimer = window.setTimeout(() => { void persistRegistry(); }, Math.max(0, delay));
  }

  async function persistRegistry() {
    window.clearTimeout(registryPersistTimer);
    registryPersistTimer = 0;
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
    const isToolLocked = document.getElementById("execution-mode-control")?.classList.contains("tool-fast-locked")
      || document.querySelector('[data-execution-mode="intuitive"]')?.classList.contains("is-tool-locked");
    if (isToolLocked && typeof window.SentIQChat?.getPreferredExecutionMode === "function") {
      return window.SentIQChat.getPreferredExecutionMode();
    }
    const active = executionModeMenu?.querySelector(
      "[data-execution-mode].active, [data-execution-mode][aria-checked='true'], [data-execution-mode][aria-selected='true']",
    );
    return active?.getAttribute("data-execution-mode") === "intuitive" ? "intuitive" : "fast";
  }

  function readModeSnapshot() {
    return { toolMode: readToolMode(), executionMode: readExecutionMode() };
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

  function sameDraft(left, right) {
    const a = normalizeDraftRecord(left);
    const b = normalizeDraftRecord(right);
    return a.text === b.text
      && a.mode.toolMode === b.mode.toolMode
      && a.mode.executionMode === b.mode.executionMode;
  }

  function sameReading(left, right) {
    if (!left || !right) return false;
    return Boolean(
      left.atBottom === right.atBottom
      && left.anchorFromEnd === right.anchorFromEnd
      && Math.abs(Number(left.anchorOffset || 0) - Number(right.anchorOffset || 0)) < 2
      && Math.abs(Number(left.ratio || 0) - Number(right.ratio || 0)) < 0.002
      && Math.abs(Number(left.scrollTop || 0) - Number(right.scrollTop || 0)) < 2
    );
  }

  function commitDraft(conversationId, record) {
    if (restoring || !conversationId) return false;
    const normalized = normalizeDraftRecord(record);
    const existing = registry.drafts[conversationId] || normalizeDraftRecord();
    const existingHasContent = draftRecordHasContent(existing);
    const nextHasContent = draftRecordHasContent(normalized);
    if (!existingHasContent && !nextHasContent) return false;
    if (sameDraft(existing, normalized) && existingHasContent === nextHasContent) return false;
    registry = updateRegistryDraft(registry, conversationId, normalized);
    queuePersist();
    decorateConversationList();
    return true;
  }

  function saveDraftFor(conversationId = currentConversationId) {
    return commitDraft(conversationId, currentDraftRecord());
  }

  function buildReadingRecord() {
    if (!chatMessages) return null;
    const messages = [...chatMessages.querySelectorAll(".message")];
    const scrollTop = chatMessages.scrollTop;
    const anchorIndex = messages.findIndex((message) => (
      message.offsetTop + message.offsetHeight > scrollTop + 1
    ));
    const anchor = anchorIndex >= 0 ? messages[anchorIndex] : null;
    return captureReadingRecord({
      scrollTop,
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
      anchorFromEnd: anchor ? messages.length - anchorIndex - 1 : null,
      anchorOffset: anchor ? scrollTop - anchor.offsetTop : 0,
      updatedAt: Date.now(),
    });
  }

  function commitReading(conversationId, record) {
    if (!conversationId || !record || applyingScroll) return false;
    if (sameReading(registry.reading[conversationId], record)) return false;
    registry = updateRegistryReading(registry, conversationId, record);
    queuePersist();
    return true;
  }

  function captureReadingFor(conversationId = currentConversationId) {
    return commitReading(conversationId, buildReadingRecord());
  }

  function scheduleDraftSave(delay = DRAFT_SAVE_DELAY_MS) {
    const conversationId = currentConversationId;
    const record = currentDraftRecord();
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => commitDraft(conversationId, record), Math.max(0, delay));
  }

  function scheduleReadingSave() {
    if (applyingScroll || !currentConversationId) return;
    const conversationId = currentConversationId;
    const record = buildReadingRecord();
    window.clearTimeout(scrollSaveTimer);
    scrollSaveTimer = window.setTimeout(() => commitReading(conversationId, record), SCROLL_SAVE_DELAY_MS);
  }

  async function flushCurrent() {
    window.clearTimeout(draftSaveTimer);
    window.clearTimeout(scrollSaveTimer);
    draftSaveTimer = 0;
    scrollSaveTimer = 0;
    saveDraftFor();
    captureReadingFor();
    await persistRegistry();
  }

  function capabilityInteractive(key) {
    const capability = window.SentIQCapabilities?.get?.(key);
    if (!capability) return true;
    return typeof capability.interactive === "boolean" ? capability.interactive : capability.available;
  }
  const capabilityAvailable = capabilityInteractive;

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
      if (!capabilityInteractive("image-generation")) {
        document.documentElement.dataset.continuityModeBlocked = "image";
        return false;
      }
      document.getElementById("image-gen-btn")?.click();
      return true;
    }
    if (toolMode === "deep-research") {
      if (!capabilityInteractive("deep-research")) {
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
    if (typeof window.SentIQChat?.setStoredPreferenceExecutionMode === "function") {
      window.SentIQChat.setStoredPreferenceExecutionMode(target);
    }
    const isToolLocked = document.getElementById("execution-mode-control")?.classList.contains("tool-fast-locked")
      || document.querySelector('[data-execution-mode="intuitive"]')?.classList.contains("is-tool-locked");
    if (isToolLocked && target === "intuitive") {
      return;
    }
    const option = executionModeMenu?.querySelector(`[data-execution-mode="${target}"]`);
    if (option instanceof HTMLButtonElement && !option.disabled && option.getAttribute("aria-disabled") !== "true" && readExecutionMode() !== target) option.click();
  }

  function restoreReadingPosition(conversationId, sequence) {
    if (!chatMessages || !conversationId || sequence !== restoreSequence) return;
    const record = registry.reading[conversationId];
    if (!record) return;
    const messages = [...chatMessages.querySelectorAll(".message")];
    const anchorIndex = record.anchorFromEnd === null ? -1 : messages.length - 1 - record.anchorFromEnd;
    const anchor = anchorIndex >= 0 && anchorIndex < messages.length ? messages[anchorIndex] : null;
    applyingScroll = true;
    chatMessages.scrollTop = resolveRestoredScrollTop(record, {
      scrollHeight: chatMessages.scrollHeight,
      clientHeight: chatMessages.clientHeight,
      anchorOffsetTop: anchor?.offsetTop,
    });
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
    const storedRecord = registry.drafts[conversationId] || null;
    restoring = true;
    if (chatInput) {
      chatInput.value = storedRecord?.text || "";
      chatInput.dispatchEvent(new Event("input", { bubbles: true }));
      chatInput.dataset.continuityDraft = storedRecord?.text.trim() ? "restored" : "empty";
    }
    restoreToolMode(storedRecord?.mode.toolMode || "none");
    if (storedRecord) restoreExecutionMode(storedRecord.mode.executionMode);
    restoring = false;
    restoreWindowUntil = Date.now() + RESTORE_WINDOW_MS;
    scheduleReadingRestore(conversationId, sequence);
    document.documentElement.dataset.continuityConversation = conversationId;
    document.dispatchEvent(new CustomEvent("sentiq-conversation-continuity-restored", {
      detail: {
        conversationId,
        hasDraft: Boolean(storedRecord && draftRecordHasContent(storedRecord)),
        mode: storedRecord?.mode || null,
      },
    }));
    listeners.forEach((listener) => {
      try { listener({ conversationId, record: storedRecord, registry }); } catch { /* subscriber isolation */ }
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
    if (previousId) saveDraftFor(previousId);
    else if (chatInput?.value) commitDraft(nextId, currentDraftRecord());
    currentConversationId = nextId;
    await restoreConversation(nextId, previousId);
    void refreshConversationActivities();
  }

  function scheduleActivation(delay = 60) {
    window.clearTimeout(activationTimer);
    activationTimer = window.setTimeout(() => { void reconcileActiveConversation(); }, Math.max(0, delay));
  }

  function transientActivity(type, updatedAt = Date.now()) {
    const label = type === "research" ? "Researching" : type === "syncing" ? "Syncing" : "Generating";
    return { type, label, updatedAt };
  }

  function markTransientActivity(conversationId, type) {
    if (!conversationId || !["streaming", "research", "syncing"].includes(type)) return;
    const activity = transientActivity(type);
    transientActivities.set(conversationId, { activity, type, source: "transient", updatedAt: activity.updatedAt });
    decorateConversationList();
  }

  function clearTransientActivity(conversationId, type = "") {
    const entry = transientActivities.get(conversationId);
    if (!entry || (type && entry.type !== type)) return;
    transientActivities.delete(conversationId);
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
    const label = marker.querySelector(".conversation-activity-label");
    if (label && label.textContent !== activity.label) label.textContent = activity.label;
    const accessibleLabel = `${activity.label} in this conversation`;
    if (marker.getAttribute("aria-label") !== accessibleLabel) marker.setAttribute("aria-label", accessibleLabel);
    if (marker.title !== accessibleLabel) marker.title = accessibleLabel;
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
          transientActivities.set(chat.id, { activity, type: activity.type, source: "persisted", updatedAt: now });
        }
      }
      for (const [conversationId, entry] of transientActivities) {
        if (persistedIds.has(conversationId)) continue;
        if (entry.source === "persisted" || now - Number(entry.updatedAt || 0) > TRANSIENT_ACTIVITY_GRACE_MS) {
          transientActivities.delete(conversationId);
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
    sendButton.click();
    document.documentElement.dataset.continuityStreamingIsolation = "stopped-before-navigation";
    return true;
  }

  function currentDiscardRisk(options = {}) {
    return draftRecordIsMeaningful(currentDraftRecord(), {
      hasAttachments: options.includeNonPersistent !== false && hasAttachments(),
      hasSelectionContext: options.includeNonPersistent !== false && hasSelectionContext(),
    });
  }

  function storedDraftRisk(conversationId) {
    return draftRecordIsMeaningful(registry.drafts[conversationId]);
  }

  function guardRequest(target) {
    if (!(target instanceof HTMLElement)) return null;
    const deleteButton = target.closest(".chat-delete-btn");
    if (deleteButton) {
      const item = deleteButton.closest(".chat-list-item[data-id]");
      const conversationId = item?.getAttribute("data-id") || "";
      const active = item?.classList.contains("active");
      return {
        control: deleteButton,
        kind: "delete",
        conversationId,
        risky: storedDraftRisk(conversationId) || (active && currentDiscardRisk()),
        title: "Delete this conversation and its draft?",
        message: "The conversation, its saved reading position, and any unsent draft in it will be removed.",
        confirmLabel: "Delete conversation",
        intent: "danger",
      };
    }

    if (target.closest("#new-chat-btn")) {
      const guestContentWillBeDiscarded = !isSignedInScope() && currentDiscardRisk({ includeNonPersistent: false });
      return {
        control: newChatButton,
        kind: "new-chat",
        conversationId: currentConversationId,
        risky: guestContentWillBeDiscarded || hasAttachments() || hasSelectionContext(),
        title: "Start a new conversation?",
        message: isSignedInScope()
          ? "Your typed draft is saved with this conversation, but attached files or selected context cannot move to the new chat."
          : "This guest draft cannot be revisited after starting a new conversation.",
        confirmLabel: "Start new conversation",
      };
    }

    const logout = target.closest("#auth-logout-btn, #auth-menu-logout-btn, #account-signout-btn");
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

    const chatItem = target.closest(".chat-list-item[data-id]");
    if (chatItem && !target.closest(".chat-rename-btn, .chat-delete-btn, .chat-rename-input")) {
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

  function scheduleDeletedConversationCleanup(conversationId, attempt = 0) {
    if (!conversationId) return;
    const delays = [420, 1200, 3000];
    window.setTimeout(async () => {
      const chat = await Storage.getChat?.(conversationId).catch(() => null);
      if (chat && attempt < delays.length - 1) {
        scheduleDeletedConversationCleanup(conversationId, attempt + 1);
        return;
      }
      if (chat) return;
      registry = removeConversationContinuity(registry, conversationId);
      queuePersist(0);
      decorateConversationList();
    }, delays[Math.min(attempt, delays.length - 1)]);
  }

  function prepareNavigation(request) {
    saveDraftFor();
    captureReadingFor();
    stopForegroundStreamingBeforeNavigation();
    if (request.kind === "new-chat" && !isSignedInScope()) {
      registry = removeConversationContinuity(registry, GUEST_CONVERSATION_ID);
      queuePersist(0);
    }
  }

  async function replayGuardedAction(request) {
    if (!request?.control?.isConnected) return;
    guardInProgress = true;
    try {
      await flushCurrent();
      prepareNavigation(request);
      replayBypass.add(request.control);
      request.control.click();
      if (request.kind === "delete") scheduleDeletedConversationCleanup(request.conversationId);
      scheduleActivation(request.kind === "new-chat" ? 320 : 100);
      window.setTimeout(() => void refreshConversationActivities(), 160);
    } finally {
      guardInProgress = false;
    }
  }

  function handleGuardedClick(event) {
    if (!(event.target instanceof HTMLElement) || confirmation.isOpen()) return;
    const request = guardRequest(event.target);
    if (!request) return;
    if (replayBypass.has(request.control)) {
      replayBypass.delete(request.control);
      return;
    }
    if (!request.risky) {
      prepareNavigation(request);
      if (request.kind === "delete") scheduleDeletedConversationCleanup(request.conversationId);
      scheduleActivation(request.kind === "new-chat" ? 320 : 100);
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
    const streaming = Boolean(state.primary === "streaming" || state.facts?.streaming);
    const backgroundTask = Boolean(state.primary === "background-task" || state.facts?.backgroundTask);
    if (currentConversationId && streaming) markTransientActivity(currentConversationId, "streaming");
    else if (currentConversationId) clearTransientActivity(currentConversationId, "streaming");
    if (currentConversationId && backgroundTask) markTransientActivity(currentConversationId, "research");
    else if (currentConversationId) clearTransientActivity(currentConversationId, "research");
    scheduleActivation(20);
  });
  window.addEventListener("sentiq-billing-refresh", () => void refreshConversationActivities());
  window.addEventListener("pageshow", () => {
    scheduleActivation(80);
    void refreshConversationActivities();
  });
  window.addEventListener("pagehide", () => { void flushCurrent(); });
  window.addEventListener("beforeunload", (event) => {
    const currentRecord = currentDraftRecord();
    const existingRecord = registry.drafts[currentConversationId] || normalizeDraftRecord();
    const existingHasContent = draftRecordHasContent(existingRecord);
    const currentHasContent = draftRecordHasContent(currentRecord);
    const draftWouldBeLost = currentConversationId
      ? (!(sameDraft(existingRecord, currentRecord) && existingHasContent === currentHasContent)
        && (existingHasContent || currentHasContent))
      : draftRecordIsMeaningful(currentRecord);
    saveDraftFor();
    captureReadingFor();
    if (!draftWouldBeLost && !hasAttachments() && !hasSelectionContext()) return;
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
    }).observe(chatList, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-id"],
    });
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
        listener({
          conversationId: currentConversationId,
          record: registry.drafts[currentConversationId] || null,
          registry,
        });
      }
      return () => listeners.delete(listener);
    },
  });

  document.documentElement.dataset.conversationContinuityVersion = CONVERSATION_CONTINUITY_VERSION;
}

initializeConversationContinuity();
