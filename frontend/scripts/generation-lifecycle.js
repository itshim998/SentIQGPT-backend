import { SENTIQ_API_BASE } from "./config.js";
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "./shared/brand.js";

(() => {
  "use strict";

  const INSTALL_KEY = "__sentiqGenerationLifecycleInstalled";
  if (window[INSTALL_KEY]) return;

  const API = window.SentIQAPI;
  if (!API?.sendMessage || !API?.sendMessageStream) {
    console.warn("[GenerationLifecycle] SentIQ API is not ready; lifecycle adapter was not installed.");
    return;
  }
  window[INSTALL_KEY] = true;

  const activeGenerations = new Map();
  let foregroundGenerationId = null;
  let stopRequestedBeforeGeneration = false;
  let pageTeardownStarted = false;
  const MAX_RECONNECT_ATTEMPTS = 8;
  const RECONNECT_BASE_MS = 350;
  const RECONNECT_MAX_MS = 5000;

  function createAnonymousId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function getAnonymousId() {
    try {
      const current = localStorage.getItem(STORAGE_KEYS.anonymousQuotaId);
      if (current && current.length <= 96) return current;
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEYS.anonymousQuotaId);
      if (legacy && legacy.length <= 96) {
        localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, legacy);
        return legacy;
      }
      const created = createAnonymousId();
      localStorage.setItem(STORAGE_KEYS.anonymousQuotaId, created);
      return created;
    } catch {
      return createAnonymousId();
    }
  }

  async function buildAuthHeaders() {
    const headers = {
      "Content-Type": "application/json",
      "X-SentIQ-Anonymous-Id": getAnonymousId(),
    };
    try {
      const token = await window.SentIQAuth?.getAccessToken?.();
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
      // Guest requests can still identify themselves through the anonymous id.
    }
    return headers;
  }

  function createAbortError(message = "Generation subscription closed.") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }

  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(createAbortError());
        return;
      }
      let timer;
      const onAbort = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(createAbortError());
      };
      timer = window.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function commonPrefixLength(left, right) {
    const max = Math.min(left.length, right.length);
    let index = 0;
    while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
    return index;
  }

  function emitSnapshotDelta(entry, snapshot) {
    const partialText = typeof snapshot?.partial_text === "string" ? snapshot.partial_text : "";
    if (!partialText) return;
    let delta = "";
    if (partialText.startsWith(entry.deliveredText)) {
      delta = partialText.slice(entry.deliveredText.length);
    } else {
      delta = partialText.slice(commonPrefixLength(entry.deliveredText, partialText));
    }
    if (delta) {
      entry.deliveredText = partialText;
      entry.tokensReceived = true;
      entry.callbacks.onToken?.(delta);
    } else {
      entry.deliveredText = partialText;
    }
  }

  function extractSsePayload(line) {
    if (!line.startsWith("data: ")) return null;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return payload === "[DONE]" ? "[DONE]" : null;
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function emitEvent(entry, event) {
    if (!event || typeof event !== "object") return false;
    if (event.generation_id && event.generation_id !== entry.generationId) return false;

    const sequence = Number(event.sequence);
    if (Number.isFinite(sequence) && sequence > 0 && sequence <= entry.lastSequence) return false;
    if (Number.isFinite(sequence) && sequence > 0) entry.lastSequence = sequence;

    switch (event.type) {
      case "generation_snapshot":
        emitSnapshotDelta(entry, event);
        return false;
      case "token": {
        const text = String(event.text || "");
        if (!text) return false;
        entry.deliveredText += text;
        entry.tokensReceived = true;
        entry.callbacks.onToken?.(text);
        return false;
      }
      case "file_token":
        if (event.text) {
          entry.tokensReceived = true;
          entry.callbacks.onFileToken?.(event.text, event);
        }
        return false;
      case "file_artifact":
        entry.tokensReceived = true;
        entry.callbacks.onFileArtifact?.(event);
        return false;
      case "thinking":
        if (event.text) entry.callbacks.onThinking?.(event.text);
        return false;
      case "structured_response":
        if (event.response) {
          entry.structuredReceived = true;
          entry.callbacks.onStructuredResponse?.(event.response);
        }
        return false;
      case "route":
        if (event.route) entry.callbacks.onRoute?.(event.route, event);
        return false;
      case "tool_selected":
      case "tool_started":
      case "tool_result":
      case "tool_error":
        if (event.tool) entry.callbacks.onToolLifecycle?.(event);
        return false;
      case "websurf_sources":
        if (event.web_search) entry.callbacks.onWebSurfSources?.(event.web_search, event);
        return false;
      case "websurf_complete":
        if (event.web_search) entry.callbacks.onWebSurfComplete?.(event, event.web_search);
        return false;
      case "memory":
        if (event.memory) entry.callbacks.onMemory?.(event.memory);
        return false;
      case "sync":
        if (event.sync) entry.callbacks.onSync?.(event.sync, event.degraded || null);
        return false;
      case "error": {
        const error = new Error(String(event.error || "Generation failed."));
        error.code = typeof event.code === "string" ? event.code : "generation_failed";
        error.details = event;
        entry.error = error;
        entry.interrupted = entry.tokensReceived;
        entry.callbacks.onError?.(error, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        return true;
      }
      case "generation_completed":
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.callbacks.onDone?.();
        return true;
      case "generation_cancelled":
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.cancelled = true;
        return true;
      case "generation_failed": {
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        const error = new Error(String(event.error_code || "Generation failed."));
        error.code = typeof event.error_code === "string" ? event.error_code : "generation_failed";
        error.details = event;
        entry.error = error;
        entry.interrupted = entry.tokensReceived;
        entry.callbacks.onError?.(error, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        return true;
      }
      default:
        return false;
    }
  }

  async function subscribeOnce(entry, signal) {
    const headers = await buildAuthHeaders();
    const url = new URL(`${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(entry.generationId)}/events`);
    if (entry.lastSequence > 0) url.searchParams.set("after", String(entry.lastSequence));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body?.error || `Generation subscription failed: HTTP ${response.status}`);
      error.status = response.status;
      error.code = body?.code || "generation_subscription_failed";
      throw error;
    }
    if (!response.body?.getReader) throw new Error("Generation event stream is unavailable.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processLines = (lines) => {
      for (const line of lines) {
        const event = extractSsePayload(line);
        if (event === "[DONE]") return true;
        if (event && emitEvent(entry, event)) return true;
      }
      return false;
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer) {
          const lines = buffer.split("\n");
          buffer = "";
          if (processLines(lines)) return;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      if (processLines(lines) || entry.terminal) return;
    }
  }

  async function subscribeUntilTerminal(entry, signal) {
    let reconnectAttempts = 0;
    while (!entry.terminal && !entry.cancelled) {
      if (signal?.aborted) return { detached: true };
      try {
        await subscribeOnce(entry, signal);
        if (entry.terminal || entry.cancelled) break;
        if (signal?.aborted) return { detached: true };
        reconnectAttempts += 1;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          throw new Error("Generation event stream disconnected repeatedly.");
        }
        await wait(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1)), signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) return { detached: true };
        if (entry.cancelRequested) return { cancelled: true };
        reconnectAttempts += 1;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) throw error;
        await wait(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1)), signal);
      }
    }
    return { cancelled: entry.cancelled };
  }

  async function cancelGeneration(generationId, { keepalive = false } = {}) {
    if (!generationId) return null;
    const headers = await buildAuthHeaders();
    const response = await fetch(
      `${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(generationId)}/cancel`,
      { method: "POST", headers, body: "{}", keepalive },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body?.error || `Generation cancellation failed: HTTP ${response.status}`);
      error.code = body?.code || "generation_cancel_failed";
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => null);
  }

  async function cancelAllGenerations({ keepalive = false } = {}) {
    const ids = Array.from(activeGenerations.keys());
    if (!ids.length) return null;
    const headers = await buildAuthHeaders();
    const response = await fetch(`${SENTIQ_API_BASE}/api/chat/generations/cancel-all`, {
      method: "POST",
      headers,
      body: JSON.stringify({ generation_ids: ids }),
      keepalive,
    });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  }

  async function patchedSendMessageStream(message, context = {}, callbacks = {}, signal = null) {
    const safeContext = { ...(context || {}), signal: null };
    const started = await API.sendMessage(message, safeContext);
    const generationId = typeof started?.generation_id === "string"
      ? started.generation_id
      : typeof started?.generationId === "string"
        ? started.generationId
        : "";

    if (!generationId) {
      return API.__legacySendMessageStream(message, context, callbacks, signal);
    }

    const activeChatId = document.querySelector(".chat-list-item.active")?.getAttribute("data-id") || context.conversationId || null;
    const entry = {
      generationId,
      chatId: activeChatId,
      clientRequestId: context.clientRequestId || context.client_request_id || null,
      callbacks,
      lastSequence: 0,
      deliveredText: "",
      tokensReceived: false,
      structuredReceived: false,
      interrupted: false,
      cancelled: false,
      cancelRequested: false,
      terminal: false,
      error: null,
    };
    activeGenerations.set(generationId, entry);
    foregroundGenerationId = generationId;
    callbacks.onGenerationStarted?.(generationId, started);

    if (stopRequestedBeforeGeneration) {
      stopRequestedBeforeGeneration = false;
      entry.cancelRequested = true;
      void cancelGeneration(generationId).catch((error) => {
        console.warn("[GenerationLifecycle] Stop raced generation creation:", error);
      });
    }

    try {
      const result = await subscribeUntilTerminal(entry, signal);
      if (entry.cancelRequested || entry.cancelled) {
        return {
          structured: entry.structuredReceived,
          tokensReceived: entry.tokensReceived,
          interrupted: false,
          cancelled: true,
          detached: false,
          error: null,
        };
      }
      if (result?.detached) {
        return {
          structured: entry.structuredReceived,
          tokensReceived: entry.tokensReceived,
          interrupted: false,
          cancelled: false,
          detached: true,
          error: null,
        };
      }
      if (entry.error && !entry.tokensReceived) throw entry.error;
      return {
        structured: entry.structuredReceived,
        tokensReceived: entry.tokensReceived,
        interrupted: entry.interrupted,
        cancelled: false,
        detached: false,
        error: entry.error,
      };
    } finally {
      if (activeGenerations.get(generationId) === entry && entry.terminal) {
        activeGenerations.delete(generationId);
      }
      if (foregroundGenerationId === generationId && entry.terminal) foregroundGenerationId = null;
    }
  }

  function handleExplicitStop(event) {
    const button = event.target instanceof Element ? event.target.closest("#send-btn") : null;
    if (!button || !button.classList.contains("is-stop")) return;
    const generationId = foregroundGenerationId;
    const entry = generationId ? activeGenerations.get(generationId) : null;
    if (entry) {
      entry.cancelRequested = true;
      void cancelGeneration(generationId).catch((error) => {
        console.warn("[GenerationLifecycle] Explicit Stop cancellation failed:", error);
      });
    } else {
      stopRequestedBeforeGeneration = true;
    }
  }

  function handlePageTeardown() {
    if (pageTeardownStarted) return;
    pageTeardownStarted = true;
    for (const entry of activeGenerations.values()) entry.cancelRequested = true;
    void cancelAllGenerations({ keepalive: true }).catch(() => undefined);
  }

  const legacySendMessageStream = API.sendMessageStream.bind(API);
  API.__legacySendMessageStream = legacySendMessageStream;
  API.sendMessageStream = patchedSendMessageStream;

  document.addEventListener("click", handleExplicitStop, true);
  window.addEventListener("pagehide", handlePageTeardown, true);
  window.addEventListener("beforeunload", handlePageTeardown, true);

  window.SentIQGenerationLifecycle = Object.freeze({
    cancelGeneration,
    cancelAllGenerations,
    getActiveGenerations: () => Array.from(activeGenerations.values()).map((entry) => ({
      generationId: entry.generationId,
      chatId: entry.chatId,
      status: entry.terminal ? "terminal" : entry.cancelRequested ? "cancel_requested" : "running",
    })),
  });

  console.info("[GenerationLifecycle] Phase 4 frontend transport lifecycle installed.");
})();
