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

  const registry = new Map(); // conversationId -> Map<generationId, GenerationState>
  const pendingBeforeStart = [];
  let chatListObserver = null;
  let activeChatObserver = null;

  const RUNNING = new Set(["queued", "running", "cancel_requested"]);

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeId(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || null;
  }

  function getVisibleConversationId() {
    return normalizeId(document.querySelector(".chat-list-item.active")?.getAttribute("data-id"));
  }

  function resolveConversationId(context = {}, started = {}) {
    return normalizeId(
      started?.conversation_id
      || started?.conversationId
      || context?.conversationId
      || context?.conversation_id
      || context?.chatId
      || context?.chat_id
      || getVisibleConversationId(),
    );
  }

  function getChatRegistry(conversationId, create = true) {
    const id = normalizeId(conversationId);
    if (!id) return null;
    let generations = registry.get(id);
    if (!generations && create) {
      generations = new Map();
      registry.set(id, generations);
    }
    return generations || null;
  }

  function getChatIndicatorState(conversationId) {
    const generations = getChatRegistry(conversationId, false);
    if (!generations?.size) return null;

    for (const generation of generations.values()) {
      if (RUNNING.has(generation.status)) return "generating";
    }

    for (const generation of generations.values()) {
      if (generation.status === "completed" && !generation.readyAcknowledged) return "ready";
    }

    return null;
  }

  function ensureIndicator(chatItem) {
    if (!chatItem) return null;
    let indicator = chatItem.querySelector(":scope > .sentiq-generation-indicator");
    if (indicator) return indicator;
    indicator = document.createElement("span");
    indicator.className = "sentiq-generation-indicator";
    indicator.setAttribute("aria-live", "polite");
    indicator.setAttribute("aria-atomic", "true");
    chatItem.appendChild(indicator);
    return indicator;
  }

  function updateChatIndicator(conversationId) {
    const id = normalizeId(conversationId);
    if (!id) return;
    const chatList = document.getElementById("chat-list");
    if (!chatList) return;
    const state = getChatIndicatorState(id);
    const items = Array.from(chatList.querySelectorAll(".chat-list-item[data-id]"))
      .filter((item) => normalizeId(item.getAttribute("data-id")) === id);

    for (const item of items) {
      const indicator = state ? ensureIndicator(item) : item.querySelector(":scope > .sentiq-generation-indicator");
      item.dataset.generationState = state || "idle";
      if (!indicator) continue;

      indicator.classList.toggle("is-generating", state === "generating");
      indicator.classList.toggle("is-ready", state === "ready");
      indicator.textContent = state === "generating" ? "● Generating…" : state === "ready" ? "✓ Response ready" : "";
      indicator.hidden = !state;
    }
  }

  function updateAllIndicators() {
    const ids = new Set(registry.keys());
    document.querySelectorAll(".chat-list-item[data-id]").forEach((item) => {
      const id = normalizeId(item.getAttribute("data-id"));
      if (id) ids.add(id);
    });
    for (const id of ids) updateChatIndicator(id);
  }

  function acknowledgeReady(conversationId) {
    const generations = getChatRegistry(conversationId, false);
    if (!generations) return;
    for (const generation of generations.values()) {
      if (generation.status === "completed") generation.readyAcknowledged = true;
    }
    updateChatIndicator(conversationId);
  }

  function invokeOriginal(entry, callbackName, args) {
    const callback = entry?.callbacks?.[callbackName];
    if (typeof callback !== "function") return;
    try {
      callback(...args);
    } catch (error) {
      console.warn(`[GenerationRenderRouter] ${callbackName} callback failed:`, error);
    }
  }

  function queueCallback(entry, callbackName, args) {
    entry.pendingCallbacks.push({ callbackName, args });
  }

  function isVisible(entry) {
    return Boolean(entry?.conversationId && getVisibleConversationId() === entry.conversationId);
  }

  function flushEntry(entry) {
    if (!entry || !isVisible(entry)) return;
    const queued = entry.pendingCallbacks.splice(0);
    for (const item of queued) invokeOriginal(entry, item.callbackName, item.args);
    if (entry.status === "completed") entry.readyAcknowledged = true;
    updateChatIndicator(entry.conversationId);
  }

  function flushChat(conversationId) {
    const generations = getChatRegistry(conversationId, false);
    if (!generations) return;
    for (const entry of generations.values()) flushEntry(entry);
    acknowledgeReady(conversationId);
  }

  function routeCallback(entry, callbackName, args) {
    if (!entry) return;
    if (callbackName === "onGenerationStarted") entry.startedDelivered = true;

    if (isVisible(entry)) {
      invokeOriginal(entry, callbackName, args);
      if (callbackName === "onDone" && entry.status === "completed") entry.readyAcknowledged = true;
      updateChatIndicator(entry.conversationId);
      return;
    }

    queueCallback(entry, callbackName, args);
    updateChatIndicator(entry.conversationId);
  }

  function handleCallback(entry, callbackName, args) {
    if (!entry) {
      pendingBeforeStart.push({ callbackName, args });
      return;
    }
    if (callbackName === "onToken" && typeof args[0] === "string") entry.responseBuffer += args[0];
    routeCallback(entry, callbackName, args);
  }

  function markTerminal(entry, status) {
    entry.status = status;
    entry.completedAt = nowIso();
    entry.subscription = null;
    if (status === "completed" && isVisible(entry)) entry.readyAcknowledged = true;
    updateChatIndicator(entry.conversationId);
  }

  function makeWrappedCallbacks(callbacks, entryRef, context) {
    const wrapped = { ...callbacks };
    const callbackNames = [
      "onGenerationStarted",
      "onToken",
      "onFileToken",
      "onFileArtifact",
      "onThinking",
      "onStructuredResponse",
      "onRoute",
      "onToolLifecycle",
      "onWebSurfSources",
      "onWebSurfComplete",
      "onMemory",
      "onSync",
    ];

    for (const name of callbackNames) {
      wrapped[name] = (...args) => handleCallback(entryRef.current, name, args);
    }

    wrapped.onGenerationStarted = (generationId, started) => {
      const resolvedGenerationId = normalizeId(generationId);
      const conversationId = resolveConversationId(context, started || {});
      if (!resolvedGenerationId || !conversationId) {
        pendingBeforeStart.push({ callbackName: "onGenerationStarted", args: [generationId, started] });
        return;
      }

      const chatGenerations = getChatRegistry(conversationId, true);
      const entry = {
        generationId: resolvedGenerationId,
        conversationId,
        requestId: normalizeId(context?.clientRequestId || context?.client_request_id),
        status: "running",
        responseBuffer: "",
        lastSequence: Number(started?.last_event_sequence || 0),
        subscription: "sse",
        startedAt: nowIso(),
        completedAt: null,
        readyAcknowledged: false,
        startedDelivered: false,
        callbacks,
        pendingCallbacks: [],
      };
      entryRef.current = entry;
      chatGenerations.set(resolvedGenerationId, entry);
      routeCallback(entry, "onGenerationStarted", [generationId, started]);
      flushEntry(entry);
      updateChatIndicator(conversationId);
    };

    wrapped.onDone = (...args) => {
      const entry = entryRef.current;
      if (entry) {
        markTerminal(entry, "completed");
        handleCallback(entry, "onDone", args);
      }
    };

    wrapped.onError = (...args) => {
      const entry = entryRef.current;
      if (entry) {
        markTerminal(entry, "failed");
        handleCallback(entry, "onError", args);
      }
    };

    return wrapped;
  }

  const originalSendMessageStream = API.sendMessageStream.bind(API);

  API.sendMessageStream = async function routedSendMessageStream(message, context = {}, callbacks = {}, signal = null) {
    const entryRef = { current: null };
    const wrappedCallbacks = makeWrappedCallbacks(callbacks, entryRef, context);
    const result = await originalSendMessageStream(message, context, wrappedCallbacks, signal);

    const entry = entryRef.current;
    if (entry) {
      entry.subscription = null;
      if (!entry.completedAt && result?.cancelled) {
        markTerminal(entry, "cancelled");
      } else if (!entry.completedAt && result?.detached) {
        entry.status = "running";
        entry.subscription = "detached";
      }
      updateChatIndicator(entry.conversationId);
    }

    return result;
  };

  function installStyles() {
    if (document.getElementById("sentiq-generation-render-router-styles")) return;
    const style = document.createElement("style");
    style.id = "sentiq-generation-render-router-styles";
    style.textContent = `
      .chat-list-item[data-generation-state="generating"],
      .chat-list-item[data-generation-state="ready"] { position: relative; }
      .sentiq-generation-indicator {
        display: block;
        margin-top: 2px;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.62rem;
        line-height: 1.2;
        letter-spacing: 0.015em;
        opacity: 0.78;
        pointer-events: none;
      }
      .sentiq-generation-indicator.is-generating { opacity: 0.68; }
      .sentiq-generation-indicator.is-ready { opacity: 0.86; }
      @media (min-width: 769px) {
        .app-container.sidebar-collapsed .sentiq-generation-indicator { display: none; }
      }
    `;
    document.head?.appendChild(style);
  }

  function installObservers() {
    const handleChatVisibilityChange = () => {
      const visibleChatId = getVisibleConversationId();
      if (visibleChatId) flushChat(visibleChatId);
      updateAllIndicators();
    };

    document.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(".chat-list-item[data-id]") : null;
      if (!item) return;
      window.setTimeout(handleChatVisibilityChange, 0);
    }, true);

    activeChatObserver = new MutationObserver(() => {
      const visibleChatId = getVisibleConversationId();
      if (visibleChatId) flushChat(visibleChatId);
    });
    activeChatObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-id"],
    });

    chatListObserver = new MutationObserver(() => updateAllIndicators());
    const observeTarget = document.getElementById("chat-list") || document.body;
    chatListObserver.observe(observeTarget, { subtree: true, childList: true });

    window.addEventListener("resize", updateAllIndicators);
    handleChatVisibilityChange();
  }

  window.SentIQChatGenerationRegistry = Object.freeze({
    get(conversationId, generationId) {
      return getChatRegistry(conversationId, false)?.get(generationId) || null;
    },
    getChat(conversationId) {
      const generations = getChatRegistry(conversationId, false);
      return generations ? Array.from(generations.values()) : [];
    },
    getAll() {
      return Array.from(registry.entries()).map(([conversationId, generations]) => ({
        conversationId,
        generations: Array.from(generations.values()),
      }));
    },
    flushChat,
  });

  installStyles();
  installObservers();
  updateAllIndicators();

  console.info("[GenerationRenderRouter] Phase 9/10 conversation-scoped rendering + background indicators installed.");
})();
