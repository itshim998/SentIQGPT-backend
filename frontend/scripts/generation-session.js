import { SENTIQ_API_BASE } from "./config.js";
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "./shared/brand.js";

(() => {
  "use strict";
  const KEY = "__sentiqGenerationSessionInstalled";
  if (window[KEY]) return;
  window[KEY] = true;
  const LEASE_HEARTBEAT_MS = 15000;
  let sessionId = null;
  let openPromise = null;
  let heartbeatTimer = null;
  let closed = false;
  const rehydratedEntries = new Map();

  function createAnonymousId() { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
  function getAnonymousId() { try { const current = localStorage.getItem(STORAGE_KEYS.anonymousQuotaId); if (current && current.length <= 96) return current; const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.anonymousQuotaId); if (legacy && legacy.length <= 96) { localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, legacy); return legacy; } const created = createAnonymousId(); localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, created); return created; } catch { return createAnonymousId(); } }
  async function headers() { const value = { "Content-Type": "application/json", "X-SentIQ-Anonymous-Id": getAnonymousId() }; try { const token = await window.SentIQAuth?.getAccessToken?.(); if (token) value.Authorization = `Bearer ${token}`; } catch {} return value; }
  function hasAnyActiveGenerations() {
    try {
      const active = window.SentIQGenerationLifecycle?.getActiveGenerations?.();
      return Array.isArray(active) && active.length > 0;
    } catch {
      return false;
    }
  }
  function startHeartbeat() {
    if (heartbeatTimer || !sessionId) return;
    heartbeatTimer = window.setInterval(() => {
      if (hasAnyActiveGenerations()) void heartbeat();
    }, LEASE_HEARTBEAT_MS);
  }
  async function openSession() {
    if (closed) return null;
    try {
      const response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions`, {
        method: "POST",
        headers: await headers(),
        body: "{}",
        cache: "no-store"
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      sessionId = typeof data.generation_session_id === "string" && data.generation_session_id !== "undefined"
        ? data.generation_session_id
        : (data.session?.id || null);
      startHeartbeat();
      return sessionId;
    } catch {
      return null;
    }
  }
  async function ensure() { if (sessionId && sessionId !== "undefined" && !closed) return sessionId; if (!openPromise) openPromise = openSession().finally(() => { openPromise = null; }); return openPromise; }
  async function claim(clientRequestId) {
    if (!clientRequestId) return true;
    try {
      let id = await ensure();
      if (!id || id === "undefined") return true;
      let response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(id)}/claim-request`, {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ client_request_id: clientRequestId }),
        keepalive: true,
        cache: "no-store",
      });
      if (!response.ok && (response.status === 409 || response.status === 404 || response.status === 410)) {
        sessionId = null;
        id = await openSession();
        if (!id || id === "undefined") return true;
        response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(id)}/claim-request`, {
          method: "POST",
          headers: await headers(),
          body: JSON.stringify({ client_request_id: clientRequestId }),
          keepalive: true,
          cache: "no-store",
        });
      }
      return true;
    } catch (err) {
      console.warn("[generation-session] claim warning:", err);
      return true;
    }
  }
  async function heartbeat() {
    if (!sessionId || sessionId === "undefined" || closed) return;
    try {
      await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
        method: "POST",
        headers: await headers(),
        body: "{}",
        keepalive: true,
        cache: "no-store"
      });
    } catch {}
  }
  async function close() { if (!sessionId || sessionId === "undefined" || closed) return; closed = true; if (heartbeatTimer) window.clearInterval(heartbeatTimer); heartbeatTimer = null; const id = sessionId; sessionId = null; try { await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(id)}/close`, { method: "POST", headers: await headers(), body: "{}", keepalive: true, cache: "no-store" }); } catch {} }
  function reopenAfterRestore() { if (!closed) return; closed = false; sessionId = null; void ensure(); }

  function currentVisibleChatId() { return document.querySelector(".chat-list-item.active")?.getAttribute("data-id") || null; }
  function findRehydratedGeneration(generationId) { return rehydratedEntries.get(generationId) || null; }
  function ensureRehydratedRenderer(entry) {
    if (!entry || entry.terminal || entry.renderer || currentVisibleChatId() !== entry.conversationId) return;
    if (document.querySelector(".message.assistant .typing-active") || document.querySelector(".message.assistant.typing-active")) return;
    if (entry.requestId && document.querySelector(`.message.assistant[data-request-id="${entry.requestId}"]`)) return;
    const messages = document.querySelector("#chat-messages");
    if (!messages) return;
    const bubble = document.createElement("div");
    bubble.className = "message assistant sentiq-rehydrated-generation";
    bubble.dataset.chatId = entry.conversationId;
    if (entry.requestId) bubble.dataset.requestId = entry.requestId;
    const content = document.createElement("div");
    content.className = "message-content sentiq-reveal-target is-visible";
    content.textContent = entry.responseBuffer || "";
    bubble.appendChild(content); messages.appendChild(bubble);
    entry.renderer = { bubble, content, renderedText: entry.responseBuffer || "" };
  }
  function syncRehydratedRenderer(entry) {
    if (!entry || entry.terminal) return;
    if (document.querySelector(".message.assistant .typing-active") || document.querySelector(".message.assistant.typing-active")) return;
    ensureRehydratedRenderer(entry);
    if (!entry.renderer) return;
    const next = String(entry.responseBuffer || "");
    if (next === entry.renderer.renderedText) return;
    entry.renderer.content.textContent = next; entry.renderer.renderedText = next;
  }
  function handleRehydratedEvent(event) {
    const detail = event?.detail || {}; const generation = detail.generation || {}; const generationId = generation.generationId || generation.generation_id; if (!generationId) return;
    const entry = findRehydratedGeneration(generationId); if (!entry) return;
    if (generation.conversationId) entry.conversationId = generation.conversationId;
    if (typeof generation.responseBuffer === "string") entry.responseBuffer = generation.responseBuffer;
    const payload = detail.event || {};
    if (["generation_completed", "generation_cancelled", "generation_failed"].includes(String(payload.type))) {
      entry.terminal = true;
      entry.renderer = null;
    }
    syncRehydratedRenderer(entry);
  }
  const MAX_REHYDRATED_ENTRIES = 20;
  function pruneRehydratedEntries() {
    if (rehydratedEntries.size <= MAX_REHYDRATED_ENTRIES) return;
    for (const [id, item] of rehydratedEntries.entries()) {
      if (item.terminal) {
        rehydratedEntries.delete(id);
        if (rehydratedEntries.size <= MAX_REHYDRATED_ENTRIES) break;
      }
    }
  }
  function handleRehydratedRegistration(event) {
    const persisted = event?.detail?.persisted || {}; const generation = event?.detail?.generation || {};
    const generationId = generation.generationId || generation.generation_id || persisted.id || persisted.generation_id; if (!generationId) return;
    pruneRehydratedEntries();
    rehydratedEntries.set(generationId, { generationId, conversationId: generation.conversationId || persisted.conversation_id || null, requestId: generation.requestId || persisted.client_request_id || null, status: generation.status || persisted.status || "queued", responseBuffer: generation.responseBuffer || persisted.partial_text || "", renderer: null, terminal: Boolean(generation.terminal) });
    syncRehydratedRenderer(rehydratedEntries.get(generationId));
  }
  document.addEventListener("sentiq-generation-rehydrated", handleRehydratedRegistration);
  document.addEventListener("sentiq-generation-event", handleRehydratedEvent);
  document.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".chat-list-item[data-id]") : null;
    if (item) window.setTimeout(() => { for (const entry of rehydratedEntries.values()) if (entry.conversationId === currentVisibleChatId()) syncRehydratedRenderer(entry); }, 0);
  }, true);
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("#send-btn") : null;
    if (!button?.classList.contains("is-stop")) return;
    const visible = currentVisibleChatId();
    const candidate = Array.from(rehydratedEntries.values()).find((entry) => entry.conversationId === visible && !entry.terminal && ["queued","running","cancel_requested","waiting_for_tool","generating","persisting"].includes(entry.status));
    if (candidate) void window.SentIQGenerationLifecycle?.cancelGeneration?.(candidate.generationId).catch?.(() => undefined);
  }, true);
  window.addEventListener("pageshow", () => { for (const entry of rehydratedEntries.values()) if (entry.conversationId === currentVisibleChatId()) syncRehydratedRenderer(entry); });

  function bridgeLifecycleRegistry() {
    const lifecycle = window.SentIQGenerationLifecycle;
    const router = window.SentIQChatGenerationRegistry;
    if (!lifecycle || !router || lifecycle.__sentiqRegistryBridgeInstalled) return;
    const mergedChat = (chatId) => {
      const map = new Map();
      for (const item of lifecycle.getChatGenerations?.(chatId) || []) map.set(item.generationId, item);
      for (const item of router.getChat?.(chatId) || []) map.set(item.generationId, item);
      return Array.from(map.values());
    };
    const mergedAll = () => {
      const map = new Map();
      for (const group of lifecycle.getGenerationRegistry?.() ? Object.entries(lifecycle.getGenerationRegistry()) : []) for (const item of group[1] || []) map.set(item.generationId, { ...item });
      for (const group of router.getAll?.() || []) for (const item of group.generations || []) map.set(item.generationId, { ...item });
      return Array.from(map.values());
    };
    const bridged = Object.freeze({
      ...lifecycle,
      __sentiqRegistryBridgeInstalled: true,
      getActiveGenerations: () => {
        const map = new Map((lifecycle.getActiveGenerations?.() || []).map((item) => [item.generationId, item]));
        for (const item of mergedAll()) if (["queued","running","cancel_requested","waiting_for_tool","generating","persisting"].includes(item.status)) map.set(item.generationId, item);
        return Array.from(map.values());
      },
      getChatGenerations: mergedChat,
      getGeneration: (generationId) => mergedAll().find((item) => item.generationId === generationId) || lifecycle.getGeneration?.(generationId) || null,
      getGenerationRegistry: () => mergedAll().reduce((acc, item) => { (acc[item.chatId || item.conversationId || "__unassigned__"] ||= []).push(item); return acc; }, {}),
    });
    window.SentIQGenerationLifecycle = bridged;
  }
  const bridgeTimer = window.setInterval(() => { bridgeLifecycleRegistry(); if (window.SentIQGenerationLifecycle?.__sentiqRegistryBridgeInstalled) window.clearInterval(bridgeTimer); }, 250);
  bridgeLifecycleRegistry();

  const API = window.SentIQAPI;
  if (API?.sendMessage && !API.__generationSessionWrappedSendMessage) {
    const originalSendMessage = API.sendMessage.bind(API);
    API.sendMessage = async (message, context = {}) => {
      const clientRequestId = context?.clientRequestId || context?.client_request_id || "";
      if (clientRequestId) {
        try {
          await claim(clientRequestId);
        } catch (claimErr) {
          console.warn("[generation-session] claim error ignored:", claimErr);
        }
      }
      let id = null;
      try {
        id = sessionId || await ensure();
      } catch {}
      return originalSendMessage(message, id ? { ...(context || {}), generation_session_id: id } : context);
    };
    API.__generationSessionWrappedSendMessage = true;
  }

  window.addEventListener("pagehide", (event) => { if (!event.persisted) void close(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) reopenAfterRestore(); });
  window.SentIQGenerationSession = Object.freeze({ ensure, heartbeat, close, getId: () => sessionId, isClosed: () => closed });
})();
