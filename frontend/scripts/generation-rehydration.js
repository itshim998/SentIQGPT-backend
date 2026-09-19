import "./generation-session.js";

(() => {
  "use strict";

  const INSTALL_KEY = "__sentiqGenerationRehydrationInstalled";
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  const API_BASE = window.SENTIQ_API_BASE || "";

  function normalizeId(value) { const normalized = typeof value === "string" ? value.trim() : ""; return normalized || null; }
  async function authHeaders() {
    const headers = { "Content-Type": "application/json", "X-SentIQ-Anonymous-Id": localStorage.getItem("sentiq_anonymous_quota_id") || "" };
    try { const token = await window.SentIQAuth?.getAccessToken?.(); if (token) headers.Authorization = `Bearer ${token}`; } catch {}
    return headers;
  }
  async function fetchGenerationState(conversationId) {
    const id = normalizeId(conversationId); if (!id || !API_BASE) return [];
    const response = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}/generations`, { method: "GET", headers: await authHeaders(), cache: "no-store" });
    if (!response.ok) throw new Error(`Generation rehydration failed: HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    return Array.isArray(payload?.generations) ? payload.generations : [];
  }
  function getVisibleConversationId() { return normalizeId(document.querySelector(".chat-list-item.active")?.getAttribute("data-id")); }
  function reconcileConversation(conversationId, generations) {
    const registry = window.SentIQChatGenerationRegistry; if (!registry) return;
    const localGenerations = registry.getChat(conversationId); const localById = new Map(localGenerations.map((entry) => [entry.generationId, entry]));
    for (const persisted of generations) {
      const generationId = normalizeId(persisted?.id); if (!generationId) continue;
      if (!localById.has(generationId)) {
        registry.rehydrateGeneration?.(persisted, conversationId);
        continue;
      }
      const local = localById.get(generationId);
      local.status = String(persisted.status || local.status);
      local.lastSequence = Math.max(Number(local.lastSequence || 0), Number(persisted.last_event_sequence || 0));
      if (typeof persisted.partial_text === "string" && persisted.partial_text.length >= local.responseBuffer.length) local.responseBuffer = persisted.partial_text;
      if (persisted.completed_at) local.completedAt = persisted.completed_at;
      if (persisted.status === "cancelled") local.cancelRequested = true;
    }
    registry.flushChat(conversationId);
    window.dispatchEvent(new CustomEvent("sentiq-generation-state-rehydrated", { detail: { conversationId, generations } }));
  }
  function hasActiveGenerations(conversationId) {
    const registry = window.SentIQChatGenerationRegistry;
    if (!registry) return false;
    const gens = registry.getChat?.(conversationId) || [];
    return gens.some((g) => !g.terminal && ["queued", "running", "cancel_requested", "waiting_for_tool", "generating", "persisting"].includes(String(g.status || "")));
  }

  let refreshTimer = null; let refreshInFlight = null; let lastRehydratedId = null; let lastRehydrateTime = 0; let lastKnownVisibleId = null;
  async function rehydrateVisibleChat() {
    const conversationId = getVisibleConversationId(); if (!conversationId) return [];
    if (document.querySelector(".message.assistant .typing-active") || document.querySelector(".message.assistant.typing-active")) return [];
    if (refreshInFlight) return refreshInFlight;
    const now = Date.now();
    const hasActive = hasActiveGenerations(conversationId);
    const minInterval = hasActive ? 3000 : 30000;
    if (conversationId === lastRehydratedId && now - lastRehydrateTime < minInterval) return [];
    lastKnownVisibleId = conversationId;
    refreshInFlight = (async () => {
      try {
        const generations = await fetchGenerationState(conversationId);
        lastRehydratedId = conversationId;
        lastRehydrateTime = Date.now();
        reconcileConversation(conversationId, generations);
        return generations;
      } catch (error) {
        lastRehydrateTime = Date.now();
        console.warn("[GenerationRehydration] Unable to refresh generation state:", error?.message || error);
        return [];
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }
  function scheduleRehydrate(delay = 40) { if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => { refreshTimer = null; void rehydrateVisibleChat(); }, delay); }
  function scheduleRehydrateIfChanged(delay = 300) {
    const visibleId = getVisibleConversationId();
    if (visibleId && visibleId !== lastKnownVisibleId) {
      lastKnownVisibleId = visibleId;
      scheduleRehydrate(delay);
    }
  }
  document.addEventListener("click", (event) => {
    const item = event.target instanceof Element ? event.target.closest(".chat-list-item[data-id]") : null;
    if (item) {
      const id = normalizeId(item.getAttribute("data-id"));
      if (id !== lastKnownVisibleId) {
        lastKnownVisibleId = id;
        scheduleRehydrate(0);
      }
    }
  }, true);

  const chatListTarget = document.getElementById("chat-list");
  if (chatListTarget) {
    const observer = new MutationObserver(() => scheduleRehydrateIfChanged(300));
    observer.observe(chatListTarget, { childList: true, subtree: false });
  }

  window.SentIQGenerationRehydration = Object.freeze({ refresh: rehydrateVisibleChat, getConversationGenerations: fetchGenerationState });
  scheduleRehydrate(250);
  console.info("[GenerationRehydration] Phase 11 generation state reconciliation + registry recreation installed.");
})();
