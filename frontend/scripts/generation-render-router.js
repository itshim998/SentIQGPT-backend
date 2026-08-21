import { SENTIQ_API_BASE } from "./config.js";

(() => {
  "use strict";

  const INSTALL_KEY = "__sentiqGenerationRenderRouterInstalled";
  if (window[INSTALL_KEY]) return;

  const API = window.SentIQAPI;
  if (!API?.sendMessageStream) {
    console.warn("[GenerationRenderRouter] SentIQ API is not ready; renderer router was not installed.");
    return;
  }
  window[INSTALL_KEY] = true;

  const lifecycle = window.SentIQGenerationLifecycle;
  if (!lifecycle?.getGenerationEntry || !lifecycle?.registerExternalGeneration) {
    console.warn("[GenerationRenderRouter] Canonical generation lifecycle registry is unavailable.");
    return;
  }

  const pendingBeforeStart = [];
  let chatListObserver = null;
  let activeChatObserver = null;

  const RUNNING = new Set(["queued", "running", "cancel_requested", "waiting_for_tool", "generating", "persisting"]);
  const TERMINAL = new Set(["completed", "failed", "cancelled"]);
  const REHYDRATION_RECONNECT_MAX = 8;
  const REHYDRATION_RECONNECT_BASE_MS = 350;
  const REHYDRATION_RECONNECT_MAX_MS = 5000;

  function nowIso() { return new Date().toISOString(); }
  function normalizeId(value) { const normalized = typeof value === "string" ? value.trim() : ""; return normalized || null; }
  function getVisibleConversationId() { return normalizeId(document.querySelector(".chat-list-item.active")?.getAttribute("data-id")); }
  function resolveConversationId(context = {}, started = {}) {
    return normalizeId(started?.conversation_id || started?.conversationId || context?.conversationId || context?.conversation_id || context?.chatId || context?.chat_id || getVisibleConversationId());
  }
  function getChatGenerations(conversationId) {
    const id = normalizeId(conversationId); if (!id) return [];
    return lifecycle.getGenerationEntries(id) || [];
  }
  function getGenerationEntry(generationId) {
    return lifecycle.getGenerationEntry(generationId);
  }
  function getAllGenerations() {
    const registry = lifecycle.getGenerationRegistryEntries?.() || {};
    return Object.entries(registry).map(([conversationId, generations]) => ({ conversationId, generations: Array.isArray(generations) ? generations : [] }));
  }
  function getChatIndicatorState(conversationId) {
    const generations = getChatGenerations(conversationId); if (!generations.length) return null;
    for (const generation of generations) if (RUNNING.has(generation.status)) return "generating";
    for (const generation of generations) if (generation.status === "completed" && !generation.readyAcknowledged) return "ready";
    return null;
  }
  function ensureIndicator(chatItem) {
    if (!chatItem) return null;
    let indicator = chatItem.querySelector(":scope > .sentiq-generation-indicator");
    if (indicator) return indicator;
    indicator = document.createElement("span"); indicator.className = "sentiq-generation-indicator"; indicator.setAttribute("aria-live", "polite"); indicator.setAttribute("aria-atomic", "true"); chatItem.appendChild(indicator); return indicator;
  }
  function updateChatIndicator(conversationId) {
    const id = normalizeId(conversationId); if (!id) return;
    const chatList = document.getElementById("chat-list"); if (!chatList) return;
    const state = getChatIndicatorState(id);
    const items = Array.from(chatList.querySelectorAll(".chat-list-item[data-id]")).filter((item) => normalizeId(item.getAttribute("data-id")) === id);
    for (const item of items) {
      const indicator = state ? ensureIndicator(item) : item.querySelector(":scope > .sentiq-generation-indicator");
      item.dataset.generationState = state || "idle";
      if (!indicator) continue;
      indicator.classList.toggle("is-generating", state === "generating"); indicator.classList.toggle("is-ready", state === "ready");
      indicator.textContent = state === "generating" ? "● Generating…" : state === "ready" ? "✓ Response ready" : ""; indicator.hidden = !state;
    }
  }
  function updateAllIndicators() {
    const ids = new Set(getAllGenerations().map((item) => item.conversationId));
    document.querySelectorAll(".chat-list-item[data-id]").forEach((item) => { const id = normalizeId(item.getAttribute("data-id")); if (id) ids.add(id); });
    for (const id of ids) updateChatIndicator(id);
  }
  function acknowledgeReady(conversationId) {
    const generations = getChatGenerations(conversationId); if (!generations.length) return;
    for (const generation of generations) if (generation.status === "completed") generation.readyAcknowledged = true;
    updateChatIndicator(conversationId);
  }
  function invokeOriginal(entry, callbackName, args) {
    const callback = entry?.originalCallbacks?.[callbackName] || entry?.callbacks?.[callbackName]; if (typeof callback !== "function") return;
    try { callback(...args); } catch (error) { console.warn(`[GenerationRenderRouter] ${callbackName} callback failed:`, error); }
  }
  function queueCallback(entry, callbackName, args) {
    if (!Array.isArray(entry.pendingCallbacks)) entry.pendingCallbacks = [];
    entry.pendingCallbacks.push({ callbackName, args });
  }
  function isVisible(entry) { return Boolean(entry?.conversationId && getVisibleConversationId() === entry.conversationId); }
  function flushEntry(entry) {
    if (!entry || !isVisible(entry)) return;
    const queued = Array.isArray(entry.pendingCallbacks) ? entry.pendingCallbacks.splice(0) : [];
    for (const item of queued) invokeOriginal(entry, item.callbackName, item.args);
    if (entry.status === "completed") entry.readyAcknowledged = true;
    updateChatIndicator(entry.conversationId);
  }
  function flushChat(conversationId) { for (const entry of getChatGenerations(conversationId)) flushEntry(entry); acknowledgeReady(conversationId); }
  function routeCallback(entry, callbackName, args) {
    if (!entry) return;
    if (callbackName === "onGenerationStarted") entry.startedDelivered = true;
    if (isVisible(entry)) { invokeOriginal(entry, callbackName, args); if (callbackName === "onDone" && entry.status === "completed") entry.readyAcknowledged = true; updateChatIndicator(entry.conversationId); return; }
    queueCallback(entry, callbackName, args); updateChatIndicator(entry.conversationId);
  }
  function handleCallback(entry, callbackName, args) {
    if (!entry) { pendingBeforeStart.push({ callbackName, args }); return; }
    if (callbackName === "onToken" && typeof args[0] === "string") entry.responseBuffer += args[0];
    routeCallback(entry, callbackName, args);
  }
  function markTerminal(entry, status) {
    entry.status = status; entry.completedAt = entry.completedAt || nowIso(); entry.subscription = null;
    if (status === "completed" && isVisible(entry)) entry.readyAcknowledged = true;
    updateChatIndicator(entry.conversationId);
  }
  function prepareCanonicalEntry(entry, callbacks, conversationId, rehydrated = false) {
    if (!entry) return null;
    entry.conversationId = entry.conversationId || conversationId;
    entry.chatId = entry.chatId || conversationId;
    entry.originalCallbacks = entry.originalCallbacks || callbacks || {};
    entry.callbacks = entry.callbacks || callbacks || {};
    entry.pendingCallbacks = Array.isArray(entry.pendingCallbacks) ? entry.pendingCallbacks : [];
    entry.readyAcknowledged = Boolean(entry.readyAcknowledged);
    entry.startedDelivered = Boolean(entry.startedDelivered);
    entry.rehydrated = rehydrated || Boolean(entry.rehydrated);
    entry.deliveredText = typeof entry.deliveredText === "string" ? entry.deliveredText : entry.responseBuffer || "";
    entry.tokensReceived = Boolean(entry.tokensReceived);
    entry.structuredReceived = Boolean(entry.structuredReceived);
    entry.interrupted = Boolean(entry.interrupted);
    entry.cancelled = Boolean(entry.cancelled);
    entry.cancelRequested = Boolean(entry.cancelRequested);
    entry.terminal = Boolean(entry.terminal) || TERMINAL.has(String(entry.status || ""));
    return entry;
  }

  function makeWrappedCallbacks(callbacks, entryRef, context) {
    const wrapped = { ...callbacks };
    const callbackNames = ["onGenerationStarted", "onToken", "onFileToken", "onFileArtifact", "onThinking", "onStructuredResponse", "onRoute", "onToolLifecycle", "onWebSurfSources", "onWebSurfComplete", "onMemory", "onSync"];
    for (const name of callbackNames) wrapped[name] = (...args) => handleCallback(entryRef.current, name, args);
    wrapped.onGenerationStarted = (generationId, started) => {
      const resolvedGenerationId = normalizeId(generationId); const conversationId = resolveConversationId(context, started || {});
      if (!resolvedGenerationId || !conversationId) { pendingBeforeStart.push({ callbackName: "onGenerationStarted", args: [generationId, started] }); return; }
      const entry = prepareCanonicalEntry(getGenerationEntry(resolvedGenerationId), wrapped, conversationId, false);
      if (!entry) { pendingBeforeStart.push({ callbackName: "onGenerationStarted", args: [generationId, started] }); return; }
      entry.requestId = entry.requestId || normalizeId(context?.clientRequestId || context?.client_request_id || started?.client_request_id);
      entry.clientRequestId = entry.clientRequestId || entry.requestId;
      entry.status = typeof started?.status === "string" ? started.status : entry.status || "running";
      entry.lastSequence = Math.max(Number(entry.lastSequence || 0), Number(started?.last_event_sequence || 0));
      entryRef.current = entry;
      routeCallback(entry, "onGenerationStarted", [generationId, started]); flushEntry(entry); updateChatIndicator(conversationId);
    };
    wrapped.onDone = (...args) => { const entry = entryRef.current; if (entry) { markTerminal(entry, "completed"); handleCallback(entry, "onDone", args); } };
    wrapped.onError = (...args) => { const entry = entryRef.current; if (entry) { markTerminal(entry, "failed"); handleCallback(entry, "onError", args); } };
    return wrapped;
  }

  const originalSendMessageStream = API.sendMessageStream.bind(API);
  API.sendMessageStream = async function routedSendMessageStream(message, context = {}, callbacks = {}, signal = null) {
    const entryRef = { current: null }; const wrappedCallbacks = makeWrappedCallbacks(callbacks, entryRef, context);
    const result = await originalSendMessageStream(message, context, wrappedCallbacks, signal);
    const entry = entryRef.current;
    if (entry) {
      entry.subscription = null;
      if (!entry.completedAt && result?.cancelled) markTerminal(entry, "cancelled");
      else if (!entry.completedAt && result?.detached) { entry.status = "running"; entry.subscription = "detached"; }
      updateChatIndicator(entry.conversationId);
    }
    return result;
  };

  async function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    try { const token = await window.SentIQAuth?.getAccessToken?.(); if (token) headers.Authorization = `Bearer ${token}`; } catch {}
    try { const anon = localStorage.getItem("sentiq_anonymous_quota_id"); if (anon) headers["X-SentIQ-Anonymous-Id"] = anon; } catch {}
    return headers;
  }

  function createRehydratedEntry(persisted, conversationId) {
    const generationId = normalizeId(persisted?.id || persisted?.generation_id); const chatId = normalizeId(conversationId || persisted?.conversation_id);
    if (!generationId || !chatId) return null;

    const existing = getGenerationEntry(generationId);
    if (existing) {
      prepareCanonicalEntry(existing, existing.callbacks, chatId, true);
      existing.status = typeof persisted.status === "string" ? persisted.status : existing.status;
      existing.lastSequence = Math.max(Number(existing.lastSequence || 0), Number(persisted.last_event_sequence || 0));
      if (typeof persisted.partial_text === "string" && persisted.partial_text.length >= String(existing.responseBuffer || "").length) existing.responseBuffer = persisted.partial_text;
      existing.deliveredText = typeof existing.responseBuffer === "string" ? existing.responseBuffer : existing.deliveredText;
      existing.completedAt = persisted.completed_at || existing.completedAt;
      return existing;
    }

    const entry = lifecycle.registerExternalGeneration({
      generationId,
      conversationId: chatId,
      chatId,
      requestId: normalizeId(persisted.client_request_id),
      clientRequestId: normalizeId(persisted.client_request_id),
      status: typeof persisted.status === "string" ? persisted.status : "queued",
      responseBuffer: typeof persisted.partial_text === "string" ? persisted.partial_text : "",
      lastSequence: Math.max(0, Number(persisted.last_event_sequence || 0)),
      subscription: { active: false, reconnectAttempts: 0, signal: null },
      startedAt: persisted.started_at || nowIso(),
      completedAt: persisted.completed_at || null,
      callbacks: {},
      pendingCallbacks: [],
      rehydrated: true,
      deliveredText: typeof persisted.partial_text === "string" ? persisted.partial_text : "",
      terminal: TERMINAL.has(String(persisted.status || "")),
    });
    if (!entry) return null;
    prepareCanonicalEntry(entry, entry.callbacks, chatId, true);
    updateChatIndicator(chatId);
    window.dispatchEvent(new CustomEvent("sentiq-generation-rehydrated", { detail: { generation: { ...entry }, persisted } }));
    return entry;
  }

  function handleRehydratedEvent(entry, event) {
    if (!event || typeof event !== "object") return false;
    const sequence = Number(event.sequence || 0);
    if (sequence > 0 && sequence <= entry.lastSequence) return false;
    if (event.type === "generation_snapshot") {
      if (typeof event.status === "string") entry.status = event.status;
      if (typeof event.partial_text === "string") { entry.responseBuffer = event.partial_text; entry.deliveredText = event.partial_text; }
    } else if (event.type === "token" || event.type === "file_token") {
      if (typeof event.text === "string") { entry.responseBuffer += event.text; entry.deliveredText = entry.responseBuffer; }
    } else if (event.type === "generation_completed") {
      entry.status = "completed"; if (typeof event.partial_text === "string") { entry.responseBuffer = event.partial_text; entry.deliveredText = event.partial_text; } entry.completedAt = nowIso(); entry.terminal = true;
    } else if (event.type === "generation_cancelled") {
      entry.status = "cancelled"; entry.completedAt = nowIso(); entry.terminal = true;
    } else if (event.type === "generation_failed") {
      entry.status = "failed"; entry.completedAt = nowIso(); entry.terminal = true;
    } else if (RUNNING.has(String(event.status)) || ["generation_started", "route", "thinking", "tool_started", "tool_result"].includes(String(event.type))) {
      entry.status = "running";
    }
    if (sequence > 0) entry.lastSequence = sequence;
    dispatchRehydratedEvent(entry, event);
    updateChatIndicator(entry.conversationId);
    return entry.terminal;
  }

  function dispatchRehydratedEvent(entry, event) {
    try { window.dispatchEvent(new CustomEvent("sentiq-generation-event", { detail: { generation: { generationId: entry.generationId, conversationId: entry.conversationId, status: entry.status, responseBuffer: entry.responseBuffer, lastSequence: entry.lastSequence, rehydrated: true }, event } })); } catch {}
  }

  async function subscribeRehydratedGeneration(entry) {
    if (!entry || TERMINAL.has(entry.status) || entry.subscription.active) return;
    let attempts = 0;
    const controller = new AbortController();
    entry.subscription = { active: true, reconnectAttempts: 0, signal: controller };
    while (!entry.terminal && !TERMINAL.has(entry.status)) {
      try {
        const url = new URL(`${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(entry.generationId)}/events`);
        if (entry.lastSequence > 0) url.searchParams.set("after", String(entry.lastSequence));
        const response = await fetch(url.toString(), { method: "GET", headers: await authHeaders(), cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Generation rehydration subscription failed: HTTP ${response.status}`);
        const reader = response.body?.getReader?.(); if (!reader) throw new Error("Generation event stream unavailable.");
        const decoder = new TextDecoder(); let buffer = ""; let done = false;
        while (!done && !entry.terminal) {
          const chunk = await reader.read(); if (chunk.done) { done = true; break; }
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim(); if (!payload || payload === "[DONE]") continue;
            try { const event = JSON.parse(payload); if (handleRehydratedEvent(entry, event)) { done = true; break; } } catch {}
          }
        }
        if (entry.terminal) break;
        attempts += 1; entry.subscription.reconnectAttempts = attempts;
      } catch (error) {
        if (controller.signal.aborted) break;
        attempts += 1; entry.subscription.reconnectAttempts = attempts;
      }
      if (attempts > REHYDRATION_RECONNECT_MAX || entry.terminal) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(REHYDRATION_RECONNECT_MAX_MS, REHYDRATION_RECONNECT_BASE_MS * (2 ** Math.max(0, attempts - 1)))));
    }
    entry.subscription.active = false;
  }

  function rehydrateGeneration(persisted, conversationId) {
    const entry = createRehydratedEntry(persisted, conversationId);
    if (!entry) return null;
    if (RUNNING.has(entry.status)) void subscribeRehydratedGeneration(entry);
    updateChatIndicator(entry.conversationId);
    return entry;
  }

  function installStyles() {
    if (document.getElementById("sentiq-generation-render-router-styles")) return;
    const style = document.createElement("style"); style.id = "sentiq-generation-render-router-styles";
    style.textContent = `.chat-list-item[data-generation-state="generating"],.chat-list-item[data-generation-state="ready"]{position:relative}.sentiq-generation-indicator{display:block;margin-top:2px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.62rem;line-height:1.2;letter-spacing:.015em;opacity:.78;pointer-events:none}.sentiq-generation-indicator.is-generating{opacity:.68}.sentiq-generation-indicator.is-ready{opacity:.86}@media (min-width:769px){.app-container.sidebar-collapsed .sentiq-generation-indicator{display:none}}`;
    document.head?.appendChild(style);
  }

  function installObservers() {
    const handleChatVisibilityChange = () => { const visibleChatId = getVisibleConversationId(); if (visibleChatId) flushChat(visibleChatId); updateAllIndicators(); };
    document.addEventListener("click", (event) => { const item = event.target instanceof Element ? event.target.closest(".chat-list-item[data-id]") : null; if (!item) return; window.setTimeout(handleChatVisibilityChange, 0); }, true);
    activeChatObserver = new MutationObserver(() => { const visibleChatId = getVisibleConversationId(); if (visibleChatId) flushChat(visibleChatId); });
    activeChatObserver.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class", "data-id"] });
    chatListObserver = new MutationObserver(() => updateAllIndicators());
    const observeTarget = document.getElementById("chat-list") || document.body; chatListObserver.observe(observeTarget, { subtree: true, childList: true });
    window.addEventListener("resize", updateAllIndicators); handleChatVisibilityChange();
  }

  window.SentIQChatGenerationRegistry = Object.freeze({
    get(conversationId, generationId) { return getGenerationEntry(generationId)?.conversationId === normalizeId(conversationId) ? getGenerationEntry(generationId) : null; },
    getChat(conversationId) { return getChatGenerations(conversationId); },
    getAll() { return getAllGenerations(); },
    flushChat,
    rehydrateGeneration,
  });

  installStyles(); installObservers(); updateAllIndicators();
  console.info("[GenerationRenderRouter] Phase 9/10 rendering now consumes the canonical lifecycle generation registry.");
})();
