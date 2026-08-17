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
  function createAnonymousId() { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
  function getAnonymousId() { try { const current = localStorage.getItem(STORAGE_KEYS.anonymousQuotaId); if (current && current.length <= 96) return current; const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.anonymousQuotaId); if (legacy && legacy.length <= 96) { localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, legacy); return legacy; } const created = createAnonymousId(); localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, created); return created; } catch { return createAnonymousId(); } }
  async function headers() { const value = { "Content-Type": "application/json", "X-SentIQ-Anonymous-Id": getAnonymousId() }; try { const token = await window.SentIQAuth?.getAccessToken?.(); if (token) value.Authorization = `Bearer ${token}`; } catch {} return value; }
  function startHeartbeat() { if (heartbeatTimer || !sessionId) return; heartbeatTimer = window.setInterval(() => { void heartbeat(); }, LEASE_HEARTBEAT_MS); }
  async function openSession() { if (closed) return null; const response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions`, { method: "POST", headers: await headers(), body: "{}", cache: "no-store" }); if (!response.ok) throw new Error(`Generation session open failed: ${response.status}`); const data = await response.json().catch(() => ({})); sessionId = typeof data.generation_session_id === "string" ? data.generation_session_id : null; startHeartbeat(); return sessionId; }
  async function ensure() { if (sessionId && !closed) return sessionId; if (!openPromise) openPromise = openSession().finally(() => { openPromise = null; }); return openPromise; }
  async function claim(clientRequestId) { if (!clientRequestId) return true; const id = await ensure(); if (!id) return true; const response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(id)}/claim-request`, { method: "POST", headers: await headers(), body: JSON.stringify({ client_request_id: clientRequestId }), keepalive: true, cache: "no-store" }); return response.ok; }
  async function heartbeat() { if (!sessionId || closed) return; try { const response = await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(sessionId)}/heartbeat`, { method: "POST", headers: await headers(), body: "{}", keepalive: true, cache: "no-store" }); if (!response.ok) { sessionId = null; await ensure(); } } catch {} }
  async function close() { if (!sessionId || closed) return; closed = true; if (heartbeatTimer) window.clearInterval(heartbeatTimer); heartbeatTimer = null; const id = sessionId; sessionId = null; try { await fetch(`${SENTIQ_API_BASE}/api/chat/generation-sessions/${encodeURIComponent(id)}/close`, { method: "POST", headers: await headers(), body: "{}", keepalive: true, cache: "no-store" }); } catch {} }
  function reopenAfterRestore() { if (!closed) return; closed = false; sessionId = null; void ensure(); }

  const API = window.SentIQAPI;
  if (API?.sendMessage && !API.__generationSessionWrappedSendMessage) {
    const originalSendMessage = API.sendMessage.bind(API);
    API.sendMessage = async (message, context = {}) => {
      const clientRequestId = context?.clientRequestId || context?.client_request_id || "";
      if (clientRequestId && !(await claim(clientRequestId))) throw Object.assign(new Error("Unable to bind generation to browser session"), { code: "generation_session_claim_failed" });
      const id = sessionId || await ensure();
      return originalSendMessage(message, id ? { ...(context || {}), generation_session_id: id } : context);
    };
    API.__generationSessionWrappedSendMessage = true;
  }

  window.addEventListener("pagehide", (event) => { if (!event.persisted) void close(); });
  window.addEventListener("pageshow", (event) => { if (event.persisted) reopenAfterRestore(); });
  window.SentIQGenerationSession = Object.freeze({ ensure, heartbeat, close, getId: () => sessionId, isClosed: () => closed });
})();
