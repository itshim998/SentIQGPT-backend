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
  const chatGenerationRegistry = new Map();
  let foregroundGenerationId = null;
  let stopRequestedBeforeGeneration = false;
  let pendingGenerationStarts = 0;
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

  function createSequenceGapError(expected, received) {
    const error = new Error(`Generation event sequence gap: expected ${expected}, received ${received}.`);
    error.name = "GenerationSequenceGapError";
    error.code = "generation_sequence_gap";
    error.expectedSequence = expected;
    error.receivedSequence = received;
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

  function getChatRegistry(chatId) {
    const normalized = typeof chatId === "string" && chatId.trim() ? chatId.trim() : "__unassigned__";
    let registry = chatGenerationRegistry.get(normalized);
    if (!registry) {
      registry = new Map();
      chatGenerationRegistry.set(normalized, registry);
    }
    return registry;
  }

  function publicGenerationEntry(entry) {
    return {
      generationId: entry.generationId,
      requestId: entry.requestId,
      chatId: entry.chatId,
      status: entry.status,
      responseBuffer: entry.responseBuffer,
      lastSequence: entry.lastSequence,
      subscription: entry.subscription ? {
        active: Boolean(entry.subscription.active),
        reconnectAttempts: Number(entry.subscription.reconnectAttempts || 0),
      } : null,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };
  }

  function registerGeneration(entry) {
    getChatRegistry(entry.chatId).set(entry.generationId, entry);
  }

  function dispatchGenerationEvent(entry, event) {
    try {
      window.dispatchEvent(new CustomEvent("sentiq-generation-event", {
        detail: {
          generation: publicGenerationEntry(entry),
          event,
        },
      }));
    } catch {
      // Registry observers are non-critical to generation execution.
    }
  }

  function emitSnapshotDelta(entry, snapshot) {
    const partialText = typeof snapshot?.partial_text === "string" ? snapshot.partial_text : "";
    if (!partialText) {
      entry.responseBuffer = entry.deliveredText;
      return;
    }

    let delta = "";
    if (partialText.startsWith(entry.deliveredText)) {
      delta = partialText.slice(entry.deliveredText.length);
    } else {
      delta = partialText.slice(commonPrefixLength(entry.deliveredText, partialText));
    }

    entry.deliveredText = partialText;
    entry.responseBuffer = partialText;
    if (delta) {
      entry.tokensReceived = true;
      entry.callbacks.onToken?.(delta);
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
    const hasSequence = Number.isFinite(sequence) && sequence > 0;

    if (event.type === "generation_snapshot") {
      if (hasSequence && sequence < entry.lastSequence) return false;
      if (hasSequence && sequence > entry.lastSequence) {
        entry.pendingReplayThrough = Math.max(entry.pendingReplayThrough || 0, sequence);
      }
      if (typeof event.status === "string") entry.status = event.status;
      emitSnapshotDelta(entry, event);

      const terminalSnapshot = Boolean(event.terminal)
        || ["completed", "failed", "cancelled"].includes(String(event.status || ""));
      if (terminalSnapshot && hasSequence) {
        entry.lastSequence = sequence;
        entry.pendingReplayThrough = 0;
      }
      dispatchGenerationEvent(entry, event);
      if (terminalSnapshot) {
        entry.terminal = true;
        entry.completedAt = entry.completedAt || new Date().toISOString();
        if (event.status === "cancelled") entry.cancelled = true;
        if (event.status === "failed") {
          const error = new Error(String(event.error_code || "Generation failed."));
          error.code = typeof event.error_code === "string" ? event.error_code : "generation_failed";
          entry.error = error;
          entry.callbacks.onError?.(error, {
            tokensReceived: entry.tokensReceived,
            interrupted: entry.interrupted,
          });
        }
        if (event.status === "completed") entry.callbacks.onDone?.();
        return true;
      }
      return false;
    }

    if (hasSequence) {
      if (sequence <= entry.lastSequence) return false;
      if (sequence > entry.lastSequence + 1) {
        throw createSequenceGapError(entry.lastSequence + 1, sequence);
      }

      if (entry.pendingReplayThrough && sequence <= entry.pendingReplayThrough) {
        entry.lastSequence = sequence;
        if (sequence === entry.pendingReplayThrough) entry.pendingReplayThrough = 0;
        dispatchGenerationEvent(entry, event);
        return false;
      }

      entry.lastSequence = sequence;
    }

    switch (event.type) {
      case "token": {
        const text = String(event.text || "");
        if (!text) return false;
        entry.status = "running";
        entry.deliveredText += text;
        entry.responseBuffer = entry.deliveredText;
        entry.tokensReceived = true;
        entry.callbacks.onToken?.(text);
        break;
      }
      case "file_token":
        entry.status = "running";
        if (event.text) {
          entry.tokensReceived = true;
          entry.callbacks.onFileToken?.(event.text, event);
        }
        break;
      case "file_artifact":
        entry.status = "running";
        entry.tokensReceived = true;
        entry.callbacks.onFileArtifact?.(event);
        break;
      case "thinking":
        entry.status = "running";
        if (event.text) entry.callbacks.onThinking?.(event.text);
        break;
      case "structured_response":
        entry.status = "running";
        if (event.response) {
          entry.structuredReceived = true;
          entry.callbacks.onStructuredResponse?.(event.response);
        }
        break;
      case "route":
        entry.status = "running";
        if (event.route) entry.callbacks.onRoute?.(event.route, event);
        break;
      case "tool_selected":
      case "tool_started":
      case "tool_result":
      case "tool_error":
        entry.status = "running";
        if (event.tool) entry.callbacks.onToolLifecycle?.(event);
        break;
      case "websurf_sources":
        entry.status = "running";
        if (event.web_search) entry.callbacks.onWebSurfSources?.(event.web_search, event);
        break;
      case "websurf_complete":
        entry.status = "running";
        if (event.web_search) entry.callbacks.onWebSurfComplete?.(event, event.web_search);
        break;
      case "memory":
        entry.status = "running";
        if (event.memory) entry.callbacks.onMemory?.(event.memory);
        break;
      case "sync":
        if (event.sync) entry.callbacks.onSync?.(event.sync, event.degraded || null);
        break;
      case "error": {
        entry.status = "failed";
        const error = new Error(String(event.error || "Generation failed."));
        error.code = typeof event.code === "string" ? event.code : "generation_failed";
        error.details = event;
        entry.error = error;
        entry.interrupted = entry.tokensReceived;
        entry.callbacks.onError?.(error, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        dispatchGenerationEvent(entry, event);
        return true;
      }
      case "generation_completed":
        entry.status = "completed";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.completedAt = new Date().toISOString();
        entry.callbacks.onDone?.();
        break;
      case "generation_cancelled":
        entry.status = "cancelled";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.cancelled = true;
        entry.completedAt = new Date().toISOString();
        break;
      case "generation_failed": {
        entry.status = "failed";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.completedAt = new Date().toISOString();
        const error = new Error(String(event.error_code || "Generation failed."));
        error.code = typeof event.error_code === "string" ? event.error_code : "generation_failed";
        error.details = event;
        entry.error = error;
        entry.interrupted = entry.tokensReceived;
        entry.callbacks.onError?.(error, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        break;
      }
      default:
        break;
    }

    dispatchGenerationEvent(entry, event);
    return entry.terminal;
  }

  async function subscribeOnce(entry, signal) {
    entry.subscription.active = true;
    entry.subscription.reconnectAttempts = Number(entry.subscription.reconnectAttempts || 0);
    const headers = await buildAuthHeaders();
    const url = new URL(`${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(entry.generationId)}/events`);
    if (entry.lastSequence > 0) url.searchParams.set("after", String(entry.lastSequence));

    try {
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
    } finally {
      entry.subscription.active = false;
    }
  }

  async function subscribeUntilTerminal(entry, signal) {
    while (!entry.terminal && !entry.cancelled) {
      if (signal?.aborted) return { detached: true };
      try {
        await subscribeOnce(entry, signal);
        if (entry.terminal || entry.cancelled) break;
        if (signal?.aborted) return { detached: true };
        entry.subscription.reconnectAttempts += 1;
        if (entry.subscription.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          throw new Error("Generation event stream disconnected repeatedly.");
        }
        await wait(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, entry.subscription.reconnectAttempts - 1)), signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) return { detached: true };
        if (entry.cancelRequested) return { cancelled: true };
        // A sequence gap is specifically recoverable from the last contiguous
        // sequence. Do not advance lastSequence past the gap.
        entry.subscription.reconnectAttempts += 1;
        if (entry.subscription.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) throw error;
        await wait(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, entry.subscription.reconnectAttempts - 1)), signal);
      }
    }
    return { cancelled: entry.cancelled };
  }

  async function cancelGeneration(generationId, { keepalive = false } = {}) {
    if (!generationId) return null;
    const entry = activeGenerations.get(generationId);
    if (entry) entry.cancelRequested = true;
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
    for (const id of ids) {
      const entry = activeGenerations.get(id);
      if (entry) entry.cancelRequested = true;
    }
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
    pendingGenerationStarts += 1;
    let started;
    try {
      const safeContext = { ...(context || {}), signal: null };
      started = await API.sendMessage(message, safeContext);
    } finally {
      pendingGenerationStarts = Math.max(0, pendingGenerationStarts - 1);
    }

    const generationId = typeof started?.generation_id === "string"
      ? started.generation_id
      : typeof started?.generationId === "string"
        ? started.generationId
        : "";

    if (!generationId) return API.__legacySendMessageStream(message, context, callbacks, signal);

    // Prefer the conversation that created the generation. Falling back to the
    // visible chat after the POST would incorrectly reassign a background job if
    // the user navigated while POST /api/chat was resolving.
    const chatId = context.conversationId
      || context.conversation_id
      || started?.conversation_id
      || started?.conversationId
      || document.querySelector(".chat-list-item.active")?.getAttribute("data-id")
      || "__unassigned__";

    const entry = {
      generationId,
      requestId: context.clientRequestId || context.client_request_id || started?.client_request_id || null,
      clientRequestId: context.clientRequestId || context.client_request_id || started?.client_request_id || null,
      chatId,
      status: typeof started?.status === "string" ? started.status : "queued",
      responseBuffer: "",
      lastSequence: 0,
      pendingReplayThrough: 0,
      subscription: { active: false, reconnectAttempts: 0, signal: null },
      startedAt: new Date().toISOString(),
      completedAt: null,
      callbacks,
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
    registerGeneration(entry);
    foregroundGenerationId = generationId;
    callbacks.onGenerationStarted?.(generationId, started);
    dispatchGenerationEvent(entry, {
      type: "generation_started",
      generation_id: generationId,
      sequence: 0,
      status: entry.status,
    });

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
      if (activeGenerations.get(generationId) === entry && entry.terminal) activeGenerations.delete(generationId);
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
    } else if (pendingGenerationStarts > 0) {
      stopRequestedBeforeGeneration = true;
    }
  }

  const legacySendMessageStream = API.sendMessageStream.bind(API);
  API.__legacySendMessageStream = legacySendMessageStream;
  API.sendMessageStream = patchedSendMessageStream;

  document.addEventListener("click", handleExplicitStop, true);

  window.SentIQGenerationLifecycle = Object.freeze({
    cancelGeneration,
    cancelAllGenerations,
    getActiveGenerations: () => Array.from(activeGenerations.values()).map((entry) => ({
      generationId: entry.generationId,
      chatId: entry.chatId,
      status: entry.status,
      lastSequence: entry.lastSequence,
    })),
    getChatGenerations: (chatId) => Array.from(getChatRegistry(chatId).values()).map(publicGenerationEntry),
    getGeneration: (generationId) => {
      const entry = Array.from(chatGenerationRegistry.values()).map((registry) => registry.get(generationId)).find(Boolean);
      return entry ? publicGenerationEntry(entry) : null;
    },
    getGenerationRegistry: () => {
      const result = {};
      for (const [chatId, registry] of chatGenerationRegistry.entries()) {
        result[chatId] = Array.from(registry.values()).map(publicGenerationEntry);
      }
      return result;
    },
  });

  console.info("[GenerationLifecycle] Phase 7/8 generation sequencing + per-chat registry installed.");
})();
