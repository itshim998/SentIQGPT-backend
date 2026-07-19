/* ============================================================
   SentIQ Liquid Glass V4 — Phase 6.3
   Identity and metadata presentation
   ============================================================ */

const IDENTITY_METADATA_VERSION = "6.3";
const chatMessages = document.getElementById("chat-messages");

const STATE_RULES = Object.freeze([
  { selector: ".message-error-wrap, .response-recovery-row", kind: "system", label: "System notice" },
  { selector: ".deep-research-card", kind: "deep-research", label: "Deep research" },
  { selector: ".generated-file-panel", kind: "file", label: "Generated file" },
  { selector: ".message-chart-container", kind: "chart", label: "Chart" },
  { selector: ".image-generation-card, .message-image-container", kind: "image", label: "Generated image" },
  { selector: ".web-search-panel, .websurf-v2-panel, .websurf-v2-presentation", kind: "web", label: "Web research" },
]);

if (chatMessages) {
  const pendingMessages = new Set();
  let frameId = 0;

  function normalizeLabel(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[.…]+$/g, "")
      .trim();
  }

  function resolveToolActivity(message) {
    const loader = message.querySelector(".response-inline-loader");
    const label = normalizeLabel(loader?.textContent);
    if (!loader || !label || /^thinking$/i.test(label)) return null;
    return {
      mode: "compact",
      kind: "tool-active",
      label,
    };
  }

  function resolveAssistantIdentity(message) {
    const activity = resolveToolActivity(message);
    if (activity) return activity;

    for (const rule of STATE_RULES) {
      if (message.querySelector(rule.selector)) {
        return {
          mode: "compact",
          kind: rule.kind,
          label: rule.label,
        };
      }
    }

    return {
      mode: "implicit",
      kind: "assistant",
      label: "SentIQ response",
    };
  }

  function setAttributeIfChanged(element, name, value) {
    if (!element || element.getAttribute(name) === value) return;
    element.setAttribute(name, value);
  }

  function setTextIfChanged(element, value) {
    if (!element || element.textContent === value) return;
    element.textContent = value;
  }

  function applyIdentity(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains("message")) return;

    const isUser = message.classList.contains("user");
    const isAssistant = message.classList.contains("assistant");
    if (!isUser && !isAssistant) return;

    const header = message.querySelector(":scope > .message-header");
    const avatar = header?.querySelector(".message-avatar");
    const sender = header?.querySelector(".message-sender");

    message.dataset.identityMetadataVersion = IDENTITY_METADATA_VERSION;
    setAttributeIfChanged(message, "role", "group");
    if (avatar) setAttributeIfChanged(avatar, "aria-hidden", "true");

    if (isUser) {
      message.dataset.identityMode = "implicit";
      message.dataset.identityKind = "user";
      setAttributeIfChanged(message, "aria-label", "Your message");
      if (header) setAttributeIfChanged(header, "aria-hidden", "true");
      return;
    }

    const identity = resolveAssistantIdentity(message);
    message.dataset.identityMode = identity.mode;
    message.dataset.identityKind = identity.kind;
    setAttributeIfChanged(
      message,
      "aria-label",
      identity.mode === "compact" ? `${identity.label} response` : identity.label,
    );

    if (!header) return;
    setAttributeIfChanged(header, "aria-hidden", identity.mode === "compact" ? "false" : "true");
    if (identity.mode === "compact") {
      setAttributeIfChanged(header, "role", "note");
      setAttributeIfChanged(header, "aria-label", identity.label);
      setTextIfChanged(sender, identity.label);
    } else {
      header.removeAttribute("role");
      header.removeAttribute("aria-label");
    }
  }

  function flushPendingMessages() {
    frameId = 0;
    const messages = Array.from(pendingMessages);
    pendingMessages.clear();
    messages.forEach(applyIdentity);
  }

  function scheduleMessage(message) {
    if (!(message instanceof HTMLElement)) return;
    pendingMessages.add(message);
    if (!frameId) frameId = requestAnimationFrame(flushPendingMessages);
  }

  function collectMessage(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    const message = element.matches(".message") ? element : element.closest(".message");
    if (message) scheduleMessage(message);
    element.querySelectorAll?.(".message").forEach(scheduleMessage);
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      collectMessage(record.target);
      record.addedNodes.forEach(collectMessage);
    });
  });

  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "data-loader-kind", "data-response-status", "aria-busy"],
  });

  chatMessages.querySelectorAll(".message").forEach(scheduleMessage);
}
