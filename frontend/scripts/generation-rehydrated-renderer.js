(() => {
  "use strict";

  const INSTALL_KEY = "__sentiqGenerationRehydratedRendererInstalled";
  if (window[INSTALL_KEY]) return;
  window[INSTALL_KEY] = true;

  const renderers = new Map();

  function normalizeId(value) {
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized || null;
  }

  function getVisibleConversationId() {
    return normalizeId(document.querySelector(".chat-list-item.active")?.getAttribute("data-id"));
  }

  function isVisible(renderer) {
    return Boolean(renderer?.conversationId && getVisibleConversationId() === renderer.conversationId);
  }

  function render(renderer, force = false) {
    if (!renderer || !renderer.text || !isVisible(renderer)) return;
    if (!force && renderer.renderedText === renderer.text) return;

    const chat = window.SentIQChat;
    if (typeof chat?.appendMessageBubble !== "function") return;

    try {
      const previous = renderer.bubble;
      const result = chat.appendMessageBubble("assistant", renderer.text);
      const bubble = result?.bubble || null;
      if (!bubble) return;

      bubble.dataset.sentiqRehydratedGeneration = renderer.generationId;
      bubble.classList.add("no-animate");
      if (previous && previous !== bubble && previous.isConnected) previous.remove();

      renderer.bubble = bubble;
      renderer.renderedText = renderer.text;
    } catch (error) {
      console.warn("[GenerationRehydratedRenderer] Render failed:", error);
    }
  }

  function scheduleRender(renderer, force = false) {
    if (!renderer) return;
    renderer.forceRender = renderer.forceRender || force;
    if (renderer.rafId) return;
    renderer.rafId = requestAnimationFrame(() => {
      renderer.rafId = 0;
      const shouldForce = renderer.forceRender;
      renderer.forceRender = false;
      render(renderer, shouldForce);
    });
  }

  function ensureRenderer(generation) {
    const generationId = normalizeId(generation?.generationId || generation?.generation_id);
    const conversationId = normalizeId(generation?.conversationId || generation?.conversation_id || generation?.chatId || generation?.chat_id);
    if (!generationId || !conversationId) return null;

    let renderer = renderers.get(generationId);
    if (!renderer) {
      renderer = {
        generationId,
        conversationId,
        text: typeof generation.responseBuffer === "string" ? generation.responseBuffer : "",
        renderedText: "",
        bubble: null,
        rafId: 0,
        forceRender: false,
        terminal: false,
      };
      renderers.set(generationId, renderer);
    } else {
      renderer.conversationId = conversationId;
      if (typeof generation.responseBuffer === "string" && generation.responseBuffer.length >= renderer.text.length) {
        renderer.text = generation.responseBuffer;
      }
    }

    scheduleRender(renderer, true);
    return renderer;
  }

  function applyEvent(generation, event) {
    const renderer = ensureRenderer(generation);
    if (!renderer || !event || typeof event !== "object") return;

    switch (event.type) {
      case "generation_snapshot":
        if (typeof event.partial_text === "string") renderer.text = event.partial_text;
        break;
      case "token":
      case "file_token":
        if (typeof event.text === "string" && event.text) renderer.text += event.text;
        break;
      case "generation_completed":
        if (typeof event.partial_text === "string") renderer.text = event.partial_text;
        renderer.terminal = true;
        break;
      case "generation_cancelled":
      case "generation_failed":
        if (typeof event.partial_text === "string") renderer.text = event.partial_text;
        renderer.terminal = true;
        break;
      default:
        return;
    }

    scheduleRender(renderer, renderer.terminal);
  }

  function handleRehydratedGeneration(event) {
    ensureRenderer(event?.detail?.generation);
  }

  function handleGenerationEvent(event) {
    const detail = event?.detail;
    if (!detail?.generation?.rehydrated) return;
    applyEvent(detail.generation, detail.event);
  }

  function flushVisibleChat() {
    const visibleChatId = getVisibleConversationId();
    if (!visibleChatId) return;
    for (const renderer of renderers.values()) {
      if (renderer.conversationId === visibleChatId) scheduleRender(renderer, true);
    }
  }

  document.addEventListener("click", (event) => {
    const chatItem = event.target instanceof Element
      ? event.target.closest(".chat-list-item[data-id]")
      : null;
    if (!chatItem) return;
    window.setTimeout(flushVisibleChat, 0);
  }, true);

  window.addEventListener("sentiq-generation-rehydrated", handleRehydratedGeneration);
  window.addEventListener("sentiq-generation-event", handleGenerationEvent);
  window.addEventListener("pageshow", flushVisibleChat);

  window.SentIQGenerationRehydratedRenderer = Object.freeze({
    flushVisibleChat,
    get(generationId) { return renderers.get(normalizeId(generationId)) || null; },
  });

  console.info("[GenerationRehydratedRenderer] Rehydrated generation events are bridged into the existing chat renderer.");
})();
