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

  const MAX_REGISTRY_ENTRIES_PER_CHAT = 15;

  function pruneTerminalEntryCallbacks(entry) {
    if (!entry) return;
    entry.subscription = null;
  }

  function registerGeneration(entry) {
    if (!entry?.generationId) return;
    const registry = getChatRegistry(entry.chatId);
    registry.set(entry.generationId, entry);
    if (entry.conversationId && entry.conversationId !== entry.chatId) {
      getChatRegistry(entry.conversationId).set(entry.generationId, entry);
    }
    if (entry.localChatId && entry.localChatId !== entry.chatId && entry.localChatId !== entry.conversationId) {
      getChatRegistry(entry.localChatId).set(entry.generationId, entry);
    }
    if (registry.size > MAX_REGISTRY_ENTRIES_PER_CHAT) {
      for (const [id, item] of registry.entries()) {
        if (item.terminal || ["completed", "failed", "cancelled"].includes(String(item.status || ""))) {
          registry.delete(id);
          if (registry.size <= MAX_REGISTRY_ENTRIES_PER_CHAT) break;
        }
      }
    }
  }

  function isGenerationRunning(entry) {
    return Boolean(entry && !entry.terminal && !["completed", "failed", "cancelled"].includes(String(entry.status || "")));
  }

  function getVisibleConversationId() {
    const id = document.querySelector(".chat-list-item.active")?.getAttribute("data-id");
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }

  function getStopTargetEntry() {
    const foreground = foregroundGenerationId ? getGenerationEntry(foregroundGenerationId) : null;
    if (isGenerationRunning(foreground)) return foreground;

    const visibleChatId = getVisibleConversationId();
    if (visibleChatId) {
      const visibleGenerations = getGenerationEntries(visibleChatId).filter(isGenerationRunning);
      if (visibleGenerations.length) {
        return visibleGenerations.sort((left, right) => {
          const leftTime = Date.parse(left.startedAt || "") || 0;
          const rightTime = Date.parse(right.startedAt || "") || 0;
          return rightTime - leftTime;
        })[0];
      }
    }

    const registryEntries = Array.from(chatGenerationRegistry.values())
      .flatMap((registry) => Array.from(registry.values()))
      .filter(isGenerationRunning);
    if (!registryEntries.length) return null;
    return registryEntries.sort((left, right) => {
      const leftTime = Date.parse(left.startedAt || "") || 0;
      const rightTime = Date.parse(right.startedAt || "") || 0;
      return rightTime - leftTime;
    })[0];
  }

  function registerExternalGeneration(entry) {
    const generationId = typeof entry?.generationId === "string" ? entry.generationId.trim() : "";
    const chatId = typeof (entry?.chatId || entry?.conversationId) === "string"
      ? String(entry.chatId || entry.conversationId).trim()
      : "";
    if (!generationId || !chatId) return null;

    const existing = getChatRegistry(chatId).get(generationId);
    if (existing) {
      if (!existing.terminal && !activeGenerations.has(generationId)) activeGenerations.set(generationId, existing);
      if (!existing.terminal && !isGenerationRunning(getGenerationEntry(foregroundGenerationId || ""))) foregroundGenerationId = generationId;
      return existing;
    }

    const canonical = {
      ...entry,
      generationId,
      chatId,
      localChatId: entry.localChatId || null,
      conversationId: entry.conversationId || chatId,
      requestId: entry.requestId || entry.clientRequestId || null,
      clientRequestId: entry.clientRequestId || entry.requestId || null,
      status: typeof entry.status === "string" ? entry.status : "queued",
      responseBuffer: typeof entry.responseBuffer === "string" ? entry.responseBuffer : "",
      lastSequence: Number.isFinite(Number(entry.lastSequence)) ? Number(entry.lastSequence) : 0,
      subscription: entry.subscription || { active: false, reconnectAttempts: 0, signal: null },
      startedAt: entry.startedAt || new Date().toISOString(),
      completedAt: entry.completedAt || null,
      callbacks: entry.callbacks || {},
      pendingCallbacks: Array.isArray(entry.pendingCallbacks) ? entry.pendingCallbacks : [],
      terminal: Boolean(entry.terminal) || ["completed", "failed", "cancelled"].includes(String(entry.status || "")),
      cancelRequested: Boolean(entry.cancelRequested),
      cancelled: Boolean(entry.cancelled),
      tokensReceived: Boolean(entry.tokensReceived),
      structuredReceived: Boolean(entry.structuredReceived),
      interrupted: Boolean(entry.interrupted),
      error: entry.error || null,
    };

    registerGeneration(canonical);
    if (!canonical.terminal) {
      activeGenerations.set(generationId, canonical);
      if (!isGenerationRunning(getGenerationEntry(foregroundGenerationId || ""))) foregroundGenerationId = generationId;
    }
    return canonical;
  }

  function unregisterGeneration(generationId) {
    const normalized = typeof generationId === "string" ? generationId.trim() : "";
    if (!normalized) return false;
    activeGenerations.delete(normalized);
    for (const registry of chatGenerationRegistry.values()) {
      if (registry.delete(normalized)) {
        if (foregroundGenerationId === normalized) foregroundGenerationId = null;
        return true;
      }
    }
    if (foregroundGenerationId === normalized) foregroundGenerationId = null;
    return false;
  }

  function getGenerationEntry(generationId) {
    const normalized = typeof generationId === "string" ? generationId.trim() : "";
    if (!normalized) return null;
    return Array.from(chatGenerationRegistry.values()).map((registry) => registry.get(normalized)).find(Boolean) || null;
  }

  function getGenerationEntries(chatId) {
    const registry = getChatRegistry(chatId);
    return Array.from(registry.values());
  }

  function getGenerationRegistryEntries() {
    const result = {};
    for (const [chatId, registry] of chatGenerationRegistry.entries()) {
      result[chatId] = Array.from(registry.values());
    }
    return result;
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
      const terminalSnapshot = Boolean(event.terminal)
        || ["completed", "failed", "cancelled"].includes(String(event.status || ""));

      if (hasSequence && sequence < entry.lastSequence && !terminalSnapshot) return false;
      if (hasSequence && sequence > entry.lastSequence) {
        entry.pendingReplayThrough = Math.max(entry.pendingReplayThrough || 0, sequence);
      }
      if (typeof event.status === "string") entry.status = event.status;
      emitSnapshotDelta(entry, event);

      if (hasSequence) {
        entry.lastSequence = Math.max(entry.lastSequence, sequence);
        entry.pendingReplayThrough = 0;
      }
      dispatchGenerationEvent(entry, event);
      if (terminalSnapshot) {
        entry.terminal = true;
        entry.completedAt = entry.completedAt || new Date().toISOString();
        activeGenerations.delete(entry.generationId);
        if (event.status === "cancelled") {
          entry.cancelled = true;
          if (!entry.cancelledDispatched) {
            entry.cancelledDispatched = true;
            entry.callbacks.onCancelled?.();
          }
        }
        if (event.status === "failed") {
          const error = new Error(String(event.error_code || "Generation failed."));
          error.code = typeof event.error_code === "string" ? event.error_code : "generation_failed";
          entry.error = error;
          if (!entry.errorDispatched) {
            entry.errorDispatched = true;
            entry.callbacks.onError?.(error, {
              tokensReceived: entry.tokensReceived,
              interrupted: entry.interrupted,
            });
          }
        }
        if (event.status === "completed") {
          if (!entry.doneDispatched) {
            entry.doneDispatched = true;
            entry.callbacks.onDone?.();
          }
        }
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        pruneTerminalEntryCallbacks(entry);
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
        entry.status = "completed";
        if (event.response) {
          entry.structuredReceived = true;
          entry.callbacks.onStructuredResponse?.(event.response);
        }
        entry.terminal = true;
        entry.completedAt = new Date().toISOString();
        activeGenerations.delete(entry.generationId);
        entry.callbacks.onDone?.();
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        pruneTerminalEntryCallbacks(entry);
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
        pruneTerminalEntryCallbacks(entry);
        return true;
      }
      case "generation_completed":
        entry.status = "completed";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.completedAt = new Date().toISOString();
        activeGenerations.delete(entry.generationId);
        entry.callbacks.onDone?.();
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        pruneTerminalEntryCallbacks(entry);
        break;
      case "generation_cancelled":
        entry.status = "cancelled";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.cancelled = true;
        entry.completedAt = new Date().toISOString();
        activeGenerations.delete(entry.generationId);
        if (!entry.cancelledDispatched) {
          entry.cancelledDispatched = true;
          entry.callbacks.onCancelled?.();
        }
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        pruneTerminalEntryCallbacks(entry);
        break;
      case "generation_failed": {
        entry.status = "failed";
        emitSnapshotDelta(entry, event);
        entry.terminal = true;
        entry.completedAt = new Date().toISOString();
        activeGenerations.delete(entry.generationId);
        const error = new Error(String(event.error_code || "Generation failed."));
        error.code = typeof event.error_code === "string" ? event.error_code : "generation_failed";
        error.details = event;
        entry.error = error;
        entry.interrupted = entry.tokensReceived;
        entry.callbacks.onError?.(error, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        pruneTerminalEntryCallbacks(entry);
        break;
      }
      default:
        break;
    }

    dispatchGenerationEvent(entry, event);
    return entry.terminal;
  }

  async function reconcileEntryDurableStatus(entry) {
    if (!entry) return;
    try {
      const headers = await buildAuthHeaders();
      const url = `${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(entry.generationId)}`;
      const response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
      });
      if (response && response.status === 404) {
        const err = new Error("Generation record not found.");
        err.code = "generation_not_found";
        entry.status = "failed";
        entry.terminal = true;
        entry.error = err;
        entry.interrupted = Boolean(entry.tokensReceived);
        if (!entry.errorDispatched) {
          entry.errorDispatched = true;
          entry.callbacks.onError?.(err, {
            tokensReceived: entry.tokensReceived,
            interrupted: entry.interrupted,
          });
        }
        return;
      }
      if (response && response.ok) {
        const data = await response.json().catch(() => ({}));
        const status = String(data?.status || "");
        if (status === "completed") {
          entry.status = "completed";
          entry.terminal = true;
          entry.completedAt = data?.completed_at || new Date().toISOString();
          if (!entry.doneDispatched) {
            entry.doneDispatched = true;
            entry.callbacks.onDone?.();
          }
          return;
        }
        if (status === "failed") {
          entry.status = "failed";
          entry.terminal = true;
          entry.completedAt = data?.failed_at || new Date().toISOString();
          const err = new Error(String(data?.error_code || "generation_failed"));
          err.code = data?.error_code || "generation_failed";
          entry.error = err;
          entry.interrupted = Boolean(entry.tokensReceived);
          if (!entry.errorDispatched) {
            entry.errorDispatched = true;
            entry.callbacks.onError?.(err, {
              tokensReceived: entry.tokensReceived,
              interrupted: entry.interrupted,
            });
          }
          return;
        }
        if (status === "cancelled") {
          entry.status = "cancelled";
          entry.terminal = true;
          entry.cancelled = true;
          entry.completedAt = data?.cancelled_at || new Date().toISOString();
          if (!entry.cancelledDispatched) {
            entry.cancelledDispatched = true;
            entry.callbacks.onCancelled?.();
          }
          return;
        }
      }
    } catch {}

    // Never report success from [DONE] alone without authoritative completion established
    entry.status = "failed";
    entry.terminal = true;
    const err = new Error("Generation stream concluded without authoritative completion.");
    err.code = "generation_unconfirmed";
    entry.error = err;
    entry.interrupted = Boolean(entry.tokensReceived);
    if (!entry.errorDispatched) {
      entry.errorDispatched = true;
      entry.callbacks.onError?.(err, {
        tokensReceived: entry.tokensReceived,
        interrupted: entry.interrupted,
      });
    }
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
        error.code = body?.code || (response.status === 404 ? "generation_not_found" : "generation_subscription_failed");
        console.warn(`[GenerationLifecycle] Subscription HTTP error generation=${entry.generationId} endpoint=/api/chat/generations/${entry.generationId}/events status=HTTP ${response.status} code=${error.code}`);
        throw error;
      }
      if (!response.body?.getReader) throw new Error("Generation event stream is unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processLines = async (lines) => {
        for (const line of lines) {
          const event = extractSsePayload(line);
          if (event === "[DONE]") {
            entry.terminal = true;
            if (entry.status === "completed") {
              entry.completedAt = entry.completedAt || new Date().toISOString();
              if (!entry.doneDispatched) {
                entry.doneDispatched = true;
                entry.callbacks.onDone?.();
              }
            } else if (entry.status === "failed" || entry.status === "cancelled") {
              // Terminal status was already established authoritatively
            } else {
              await reconcileEntryDurableStatus(entry);
            }
            activeGenerations.delete(entry.generationId);
            if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
            pruneTerminalEntryCallbacks(entry);
            return true;
          }
          if (event && emitEvent(entry, event)) return true;
        }
        return false;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) {
              const lines = buffer.split("\n");
              buffer = "";
              if (await processLines(lines)) return;
            }
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          if ((await processLines(lines)) || entry.terminal) return;
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
    } finally {
      if (entry.subscription) {
        entry.subscription.active = false;
      }
    }
  }

  async function pollDurableStatusUntilTerminal(entry, signal) {
    const pollIntervalMs = Number(window.__SENTIQ_POLL_INTERVAL_MS) || 1500;
    const maxPollAttemptsPerCycle = 20;
    const maxTotalPollAttempts = 80;
    let cycleAttempts = 0;
    let totalAttempts = Number(entry.totalPollAttempts || 0);

    while (!entry.terminal && !entry.cancelled && !entry.cancelRequested) {
      if (signal?.aborted) return { detached: true };
      cycleAttempts += 1;
      totalAttempts += 1;
      entry.totalPollAttempts = totalAttempts;

      try {
        const headers = await buildAuthHeaders();
        const url = `${SENTIQ_API_BASE}/api/chat/generations/${encodeURIComponent(entry.generationId)}`;
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal,
          cache: "no-store",
        });

        if (response.status === 404) {
          const err = new Error("Generation record not found.");
          err.code = "generation_not_found";
          entry.status = "failed";
          entry.terminal = true;
          entry.error = err;
          entry.interrupted = Boolean(entry.tokensReceived);
          activeGenerations.delete(entry.generationId);
          if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
          entry.callbacks.onError?.(err, {
            tokensReceived: entry.tokensReceived,
            interrupted: entry.interrupted,
          });
          pruneTerminalEntryCallbacks(entry);
          return { failed: true, error: err };
        }

        if (response.ok) {
          const data = await response.json().catch(() => ({}));
          const status = String(data?.status || "");
          if (typeof data?.partial_text === "string" && data.partial_text.length > entry.deliveredText.length) {
            const newText = data.partial_text.slice(entry.deliveredText.length);
            entry.deliveredText = data.partial_text;
            entry.responseBuffer = data.partial_text;
            entry.tokensReceived = true;
            totalAttempts = 0;
            entry.totalPollAttempts = 0;
            entry.callbacks.onToken?.(newText);
          }
          if (["completed", "failed", "cancelled"].includes(status)) {
            entry.status = status;
            entry.terminal = true;
            entry.completedAt = data?.completed_at || new Date().toISOString();
            activeGenerations.delete(entry.generationId);
            if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
            if (status === "completed") {
              entry.callbacks.onDone?.();
            } else if (status === "cancelled") {
              entry.cancelled = true;
              if (!entry.cancelledDispatched) {
                entry.cancelledDispatched = true;
                entry.callbacks.onCancelled?.();
              }
            } else {
              const err = new Error(String(data?.error_code || "generation_failed"));
              err.code = data?.error_code || "generation_failed";
              entry.error = err;
              entry.callbacks.onError?.(err, {
                tokensReceived: entry.tokensReceived,
                interrupted: entry.interrupted,
              });
            }
            pruneTerminalEntryCallbacks(entry);
            return { completed: status === "completed", status };
          }
        }
      } catch (err) {
        if (err?.name === "AbortError" || signal?.aborted) return { detached: true };
      }

      if (totalAttempts >= maxTotalPollAttempts) {
        const timeoutError = new Error("Generation recovery timed out before reaching a terminal state.");
        timeoutError.code = "generation_recovery_timeout";
        entry.status = "failed";
        entry.terminal = true;
        entry.error = timeoutError;
        entry.interrupted = Boolean(entry.tokensReceived);
        activeGenerations.delete(entry.generationId);
        if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
        entry.callbacks.onError?.(timeoutError, {
          tokensReceived: entry.tokensReceived,
          interrupted: entry.interrupted,
        });
        pruneTerminalEntryCallbacks(entry);
        return { failed: true, error: timeoutError };
      }

      if (cycleAttempts >= maxPollAttemptsPerCycle) {
        return { resumeSse: true };
      }

      await wait(pollIntervalMs, signal);
    }

    if (entry.cancelRequested || entry.cancelled) {
      entry.cancelled = true;
      entry.status = "cancelled";
      entry.terminal = true;
      activeGenerations.delete(entry.generationId);
      if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
      if (!entry.cancelledDispatched) {
        entry.cancelledDispatched = true;
        entry.callbacks.onCancelled?.();
      }
      pruneTerminalEntryCallbacks(entry);
      return { cancelled: true };
    }
    return { cancelled: entry.cancelled };
  }

  async function subscribeUntilTerminal(entry, signal) {
    const reconnectBaseMs = Number(window.__SENTIQ_RECONNECT_BASE_MS) || RECONNECT_BASE_MS;
    const reconnectMaxMs = Number(window.__SENTIQ_RECONNECT_MAX_MS) || RECONNECT_MAX_MS;
    while (!entry.terminal && !entry.cancelled && !entry.cancelRequested) {
      if (signal?.aborted) return { detached: true };
      try {
        await subscribeOnce(entry, signal);
        if (entry.terminal || entry.cancelled || entry.cancelRequested) break;
        if (!entry.subscription) entry.subscription = { active: false, reconnectAttempts: 0, signal: null };
        entry.subscription.reconnectAttempts += 1;
        console.warn(`[GenerationLifecycle] Stream closed before terminal state; reconnecting generation=${entry.generationId} endpoint=/api/chat/generations/${entry.generationId}/events attempt=${entry.subscription.reconnectAttempts}`);
        if (entry.subscription.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          const pollResult = await pollDurableStatusUntilTerminal(entry, signal);
          if (entry.terminal || entry.cancelled || entry.cancelRequested) return pollResult;
          if (pollResult?.resumeSse && entry.subscription) {
            entry.subscription.reconnectAttempts = 0;
          }
        }
        await wait(Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.max(0, entry.subscription.reconnectAttempts - 1))), signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) return { detached: true };
        if (entry.terminal || entry.cancelRequested) return { cancelled: Boolean(entry.cancelled), completed: entry.terminal && entry.status === "completed" };
        if (error?.status === 404 || error?.code === "generation_not_found") {
          const notFoundError = new Error("Generation record not found.");
          notFoundError.code = "generation_not_found";
          entry.status = "failed";
          entry.terminal = true;
          entry.error = notFoundError;
          entry.interrupted = Boolean(entry.tokensReceived);
          activeGenerations.delete(entry.generationId);
          if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
          entry.callbacks.onError?.(notFoundError, {
            tokensReceived: entry.tokensReceived,
            interrupted: entry.interrupted,
          });
          pruneTerminalEntryCallbacks(entry);
          return { failed: true, error: notFoundError };
        }
        if (!entry.subscription) entry.subscription = { active: false, reconnectAttempts: 0, signal: null };
        entry.subscription.reconnectAttempts += 1;
        const statusOrErr = error?.status ? `HTTP ${error.status}` : (error?.message || "stream_error");
        console.warn(`[GenerationLifecycle] Subscription error generation=${entry.generationId} endpoint=/api/chat/generations/${entry.generationId}/events status=${statusOrErr} attempt=${entry.subscription.reconnectAttempts}`);
        if (entry.subscription.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          const pollResult = await pollDurableStatusUntilTerminal(entry, signal);
          if (entry.terminal || entry.cancelled || entry.cancelRequested) return pollResult;
          if (pollResult?.resumeSse && entry.subscription) {
            entry.subscription.reconnectAttempts = 0;
          }
        }
        await wait(Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.max(0, entry.subscription.reconnectAttempts - 1))), signal);
      }
    }

    if (!entry.terminal && !entry.cancelled && !entry.cancelRequested && !signal?.aborted) {
      const interruptedError = new Error("Generation stream disconnected before completion.");
      interruptedError.code = "stream_interrupted";
      entry.status = "failed";
      entry.terminal = true;
      entry.error = interruptedError;
      entry.interrupted = Boolean(entry.tokensReceived);
      activeGenerations.delete(entry.generationId);
      if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
      entry.callbacks.onError?.(interruptedError, {
        tokensReceived: entry.tokensReceived,
        interrupted: entry.interrupted,
      });
      pruneTerminalEntryCallbacks(entry);
      return { failed: true, error: interruptedError };
    }

    return { completed: entry.terminal && entry.status === "completed", cancelled: entry.cancelled };
  }

  async function cancelGeneration(generationId, { keepalive = false } = {}) {
    if (!generationId) return null;
    const entry = getGenerationEntry(generationId);
    if (entry) {
      if (!entry.terminal) {
        entry.cancelRequested = true;
        activeGenerations.set(generationId, entry);
      }
    }
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
    const ids = Array.from(new Set([
      ...activeGenerations.keys(),
      ...Array.from(chatGenerationRegistry.values()).flatMap((registry) => Array.from(registry.values()).filter(isGenerationRunning).map((entry) => entry.generationId)),
    ]));
    if (!ids.length) return null;
    for (const id of ids) {
      const entry = getGenerationEntry(id);
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

  function buildRequestContextPayload(context = {}) {
    if (window.SentIQAPI?.buildChatRequestContext) {
      return window.SentIQAPI.buildChatRequestContext(context);
    }
    return {
      recent_messages: Array.isArray(context.recentMessages) ? context.recentMessages : (Array.isArray(context.recent_messages) ? context.recent_messages : []),
      memories: Array.isArray(context.memories) ? context.memories : [],
      file_references: Array.isArray(context.fileReferences) ? context.fileReferences : (Array.isArray(context.file_references) ? context.file_references : []),
      image_attachments: Array.isArray(context.imageAttachments) ? context.imageAttachments : (Array.isArray(context.image_attachments) ? context.image_attachments : []),
      web_search_mode: context.webSearchMode || context.web_search_mode || "none",
      trusted_profile: context.trustedProfile || context.trusted_profile || undefined,
    };
  }

  async function streamFastGeneration(message, context = {}, callbacks = {}, signal = null) {
    pendingGenerationStarts += 1;
    let entry = null;
    let generationId = "";
    try {
      const headers = await buildAuthHeaders();
      const conversationId =
        typeof context.conversationId === "string" && context.conversationId.trim()
          ? context.conversationId.trim()
          : typeof context.conversation_id === "string" && context.conversation_id.trim()
            ? context.conversation_id.trim()
            : undefined;
      const clientRequestId =
        typeof context.clientRequestId === "string" && context.clientRequestId.trim()
          ? context.clientRequestId.trim()
          : undefined;
      const generationSessionId =
        typeof context.generation_session_id === "string" && context.generation_session_id.trim()
          ? context.generation_session_id.trim()
          : typeof context.generationSessionId === "string" && context.generationSessionId.trim()
            ? context.generationSessionId.trim()
            : undefined;

      if (window.SentIQGenerationSession?.claim && clientRequestId) {
        void window.SentIQGenerationSession.claim(clientRequestId).catch(() => {});
      }

      const payload = {
        message,
        ...(conversationId ? { conversationId } : {}),
        ...(clientRequestId ? { client_request_id: clientRequestId } : {}),
        ...(generationSessionId ? { generation_session_id: generationSessionId } : {}),
        execution_mode: "fast",
        context: buildRequestContextPayload(context),
      };

      const response = await fetch(`${SENTIQ_API_BASE}/api/chat/stream`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
        cache: "no-store",
      });

      if (response.status === 404 || response.status === 405) {
        return streamTwoRequestGeneration(message, context, callbacks, signal);
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const error = new Error(errorBody?.error || `Generation request failed: HTTP ${response.status}`);
        error.status = response.status;
        error.code = errorBody?.code || "generation_request_failed";
        callbacks.onError?.(error, { tokensReceived: false, interrupted: false });
        throw error;
      }

      window.dispatchEvent?.(new CustomEvent("sentiq-billing-refresh"));

      const headerGenId = response.headers.get("x-generation-id") || response.headers.get("X-Generation-Id");
      const headerConvId = response.headers.get("x-conversation-id") || response.headers.get("X-Conversation-Id");
      const headerReqId = response.headers.get("x-client-request-id") || response.headers.get("X-Client-Request-Id");

      const localChatId = context.chatId
        || context.localChatId
        || document.querySelector(".chat-list-item.active")?.getAttribute("data-id")
        || null;

      const chatId = context.chatId
        || context.localChatId
        || context.conversationId
        || context.conversation_id
        || headerConvId
        || localChatId
        || "__unassigned__";

      const canonicalConversationId = headerConvId
        || context.conversationId
        || context.conversation_id
        || chatId;

      const initEntry = (genId, convId) => {
        if (entry) return entry;
        generationId = genId;
        entry = {
          generationId: genId,
          requestId: clientRequestId || headerReqId || null,
          clientRequestId: clientRequestId || headerReqId || null,
          chatId,
          localChatId,
          conversationId: convId || canonicalConversationId,
          status: "running",
          responseBuffer: "",
          lastSequence: 0,
          pendingReplayThrough: 0,
          subscription: { active: true, reconnectAttempts: 0, signal },
          startedAt: new Date().toISOString(),
          completedAt: null,
          callbacks,
          pendingCallbacks: [],
          readyAcknowledged: false,
          startedDelivered: false,
          rehydrated: false,
          deliveredText: "",
          tokensReceived: false,
          structuredReceived: false,
          interrupted: false,
          cancelled: false,
          cancelRequested: false,
          terminal: false,
          error: null,
        };
        activeGenerations.set(genId, entry);
        registerGeneration(entry);
        foregroundGenerationId = genId;
        callbacks.onGenerationStarted?.(genId, {
          generation_id: genId,
          conversation_id: convId || canonicalConversationId,
          client_request_id: clientRequestId || headerReqId || null,
          status: "running",
        });
        dispatchGenerationEvent(entry, {
          type: "generation_started",
          generation_id: genId,
          sequence: 0,
          status: entry.status,
        });
        if (stopRequestedBeforeGeneration) {
          stopRequestedBeforeGeneration = false;
          entry.cancelRequested = true;
          void cancelGeneration(genId).catch((err) => {
            console.warn("[GenerationLifecycle] Stop raced generation creation:", err);
          });
        }
        return entry;
      };

      if (headerGenId) {
        initEntry(headerGenId, headerConvId);
      }

      if (!response.body?.getReader) {
        throw new Error("Generation stream body is unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const processLines = async (lines) => {
        for (const line of lines) {
          const event = extractSsePayload(line);
          if (!event) continue;
          if (event === "[DONE]") {
            if (entry) {
              entry.terminal = true;
              if (entry.status === "completed") {
                entry.completedAt = entry.completedAt || new Date().toISOString();
                if (!entry.doneDispatched) {
                  entry.doneDispatched = true;
                  entry.callbacks.onDone?.();
                }
              } else if (entry.status === "failed" || entry.status === "cancelled") {
                // Terminal status was already established authoritatively
              } else {
                await reconcileEntryDurableStatus(entry);
              }
              activeGenerations.delete(entry.generationId);
              if (foregroundGenerationId === entry.generationId) foregroundGenerationId = null;
              pruneTerminalEntryCallbacks(entry);
            }
            return true;
          }
          if (!entry && event?.generation_id) {
            initEntry(event.generation_id, event.conversation_id);
          }
          if (entry && emitEvent(entry, event)) return true;
        }
        return false;
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) {
              const lines = buffer.split("\n");
              buffer = "";
              if (await processLines(lines)) break;
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          if ((await processLines(lines)) || (entry && entry.terminal)) break;
        }
      } finally {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
        if (entry) entry.subscription.active = false;
      }

      if (entry && !entry.terminal && !entry.cancelled && !entry.cancelRequested && !signal?.aborted) {
        await subscribeUntilTerminal(entry, signal);
      }

      if (entry?.cancelRequested || entry?.cancelled) {
        return {
          structured: Boolean(entry?.structuredReceived),
          tokensReceived: Boolean(entry?.tokensReceived),
          interrupted: false,
          cancelled: true,
          detached: false,
          error: null,
        };
      }

      if (entry?.error && !entry?.tokensReceived && !entry?.structuredReceived) {
        throw entry.error;
      }

      return {
        structured: Boolean(entry?.structuredReceived),
        tokensReceived: Boolean(entry?.tokensReceived),
        interrupted: Boolean(entry?.interrupted),
        cancelled: false,
        detached: false,
        error: entry?.error || null,
      };
    } finally {
      pendingGenerationStarts = Math.max(0, pendingGenerationStarts - 1);
      if (entry) {
        if (activeGenerations.get(generationId) === entry && entry.terminal) activeGenerations.delete(generationId);
        if (foregroundGenerationId === generationId && entry.terminal) foregroundGenerationId = null;
        if (entry.terminal) pruneTerminalEntryCallbacks(entry);
      }
    }
  }

  async function streamTwoRequestGeneration(message, context = {}, callbacks = {}, signal = null) {
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

    const localChatId = context.chatId
      || context.localChatId
      || document.querySelector(".chat-list-item.active")?.getAttribute("data-id")
      || null;

    const chatId = context.chatId
      || context.localChatId
      || context.conversationId
      || context.conversation_id
      || started?.conversation_id
      || started?.conversationId
      || localChatId
      || "__unassigned__";

    const conversationId = started?.conversation_id
      || started?.conversationId
      || context.conversationId
      || context.conversation_id
      || chatId;

    const entry = {
      generationId,
      requestId: context.clientRequestId || context.client_request_id || started?.client_request_id || null,
      clientRequestId: context.clientRequestId || context.client_request_id || started?.client_request_id || null,
      chatId,
      localChatId,
      conversationId,
      status: typeof started?.status === "string" ? started.status : "queued",
      responseBuffer: "",
      lastSequence: 0,
      pendingReplayThrough: 0,
      subscription: { active: false, reconnectAttempts: 0, signal: null },
      startedAt: new Date().toISOString(),
      completedAt: null,
      callbacks,
      pendingCallbacks: [],
      readyAcknowledged: false,
      startedDelivered: false,
      rehydrated: false,
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
      if (entry.error && !entry.tokensReceived && !entry.structuredReceived) throw entry.error;
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
      if (entry.terminal) pruneTerminalEntryCallbacks(entry);
    }
  }

  async function patchedSendMessageStream(message, context = {}, callbacks = {}, signal = null) {
    const isFast = (context.executionMode || context.execution_mode) === "fast";
    if (isFast) {
      return streamFastGeneration(message, context, callbacks, signal);
    }
    return streamTwoRequestGeneration(message, context, callbacks, signal);
  }

  function handleExplicitStop(event) {
    const button = event.target instanceof Element ? event.target.closest("#send-btn") : null;
    if (!button || !button.classList.contains("is-stop")) return;
    const entry = getStopTargetEntry();
    const generationId = entry?.generationId || null;
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
    registerExternalGeneration,
    unregisterGeneration,
    getGenerationEntry,
    getGenerationEntries,
    getGenerationRegistryEntries,
    getActiveGenerations: () => Array.from(activeGenerations.values()).map((entry) => publicGenerationEntry(entry)),
    getChatGenerations: (chatId) => Array.from(getChatRegistry(chatId).values()).map(publicGenerationEntry),
    getGeneration: (generationId) => {
      const entry = getGenerationEntry(generationId);
      return entry ? publicGenerationEntry(entry) : null;
    },
    getGenerationRegistry: () => {
      const result = {};
      for (const [chatId, registry] of chatGenerationRegistry.entries()) {
        result[chatId] = Array.from(registry.values()).map(publicGenerationEntry);
      }
      return result;
    },
    pollDurableStatusUntilTerminal,
    subscribeUntilTerminal,
    subscribeOnce,
    createGenerationEntry: (options = {}) => {
      const entry = {
        generationId: options.generationId,
        requestId: options.requestId || null,
        clientRequestId: options.clientRequestId || null,
        chatId: options.chatId || "__unassigned__",
        localChatId: options.localChatId || null,
        conversationId: options.conversationId || options.chatId || "__unassigned__",
        status: options.status || "queued",
        responseBuffer: options.responseBuffer || "",
        lastSequence: options.lastSequence || 0,
        pendingReplayThrough: 0,
        subscription: options.subscription || { active: false, reconnectAttempts: 0, signal: null },
        startedAt: options.startedAt || new Date().toISOString(),
        completedAt: null,
        callbacks: options.callbacks || {},
        pendingCallbacks: [],
        readyAcknowledged: false,
        startedDelivered: false,
        rehydrated: false,
        deliveredText: options.deliveredText || "",
        tokensReceived: Boolean(options.tokensReceived),
        structuredReceived: false,
        interrupted: false,
        cancelled: false,
        cancelRequested: false,
        terminal: false,
        error: null,
      };
      registerGeneration(entry);
      if (!entry.terminal) activeGenerations.set(entry.generationId, entry);
      return entry;
    },
  });
})();