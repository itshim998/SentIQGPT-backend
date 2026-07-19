/* ============================================================
   SentIQ Liquid Glass V4 — Phase 6.4
   Input-aware message action disclosure
   ============================================================ */

const MESSAGE_ACTIONS_VERSION = "6.4";
const MOBILE_ACTIONS_QUERY = "(hover: none), (pointer: coarse), (max-width: 768px)";
const chatMessages = document.getElementById("chat-messages");
const mobileActionsQuery = window.matchMedia?.(MOBILE_ACTIONS_QUERY) || { matches: false };

const ACTION_CONTROL_SELECTOR = "button, a[href], [role='button']";
const KNOWN_CONTEXT_ZONE_SELECTOR = [
  ".image-frame-download-btn",
  ".image-actions",
  ".deep-research-report-actions",
  ".generated-file-actions",
  ".generated-file-toolbar",
  ".generated-file-footer",
  ".generated-preview-actions",
  ".message-chart-actions",
  ".chart-actions",
].join(", ");
const RICH_ACTION_SURFACE_SELECTOR = [
  ".image-generation-card",
  ".generated-file-panel",
  ".message-chart-container",
  ".deep-research-card",
].join(", ");
const ACTION_DESCRIPTOR_PATTERN = /\b(copy|regenerat|retry|feedback|helpful|unhelpful|thumb|download|export|save file|remove|open (?:file|document))\b/i;

if (chatMessages) {
  const pendingMessages = new Set();
  let frameId = 0;
  let actionZoneId = 0;
  let openMessage = null;

  function isMobileMode() {
    return Boolean(mobileActionsQuery.matches);
  }

  function setAttributeIfChanged(element, name, value) {
    if (!element || element.getAttribute(name) === value) return;
    element.setAttribute(name, value);
  }

  function isActionControl(element) {
    return element instanceof Element && element.matches(ACTION_CONTROL_SELECTOR);
  }

  function describeControl(control) {
    return [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.textContent,
      typeof control.className === "string" ? control.className : "",
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function isRelevantContextControl(control) {
    return isActionControl(control) && ACTION_DESCRIPTOR_PATTERN.test(describeControl(control));
  }

  function resolveContextZone(control, message) {
    const groupedZone = control.closest([
      ".image-actions",
      ".deep-research-report-actions",
      ".generated-file-actions",
      ".generated-file-toolbar",
      ".generated-file-footer",
      ".generated-preview-actions",
      ".message-chart-actions",
      ".chart-actions",
      "[class*='-actions']",
      "[class*='__actions']",
      "[class*='toolbar']",
      "[class*='controls']",
    ].join(", "));

    if (
      groupedZone
      && groupedZone !== message
      && message.contains(groupedZone)
      && !groupedZone.classList.contains("message-action-bar")
    ) {
      return groupedZone;
    }
    return control;
  }

  function discoverActionZones(message) {
    const zones = new Set();
    const standardBar = message.querySelector(":scope > .message-action-bar");
    if (standardBar?.querySelector(ACTION_CONTROL_SELECTOR)) zones.add(standardBar);

    message.querySelectorAll(KNOWN_CONTEXT_ZONE_SELECTOR).forEach((zone) => {
      if (isActionControl(zone) || zone.querySelector(ACTION_CONTROL_SELECTOR)) zones.add(zone);
    });

    message.querySelectorAll(RICH_ACTION_SURFACE_SELECTOR).forEach((surface) => {
      surface.querySelectorAll(ACTION_CONTROL_SELECTOR).forEach((control) => {
        if (!isRelevantContextControl(control)) return;
        zones.add(resolveContextZone(control, message));
      });
    });

    return Array.from(zones).filter((zone) => message.contains(zone));
  }

  function ensureZoneId(zone) {
    if (zone.id) return zone.id;
    actionZoneId += 1;
    zone.id = `message-action-zone-${actionZoneId}`;
    return zone.id;
  }

  function getZoneControls(zone) {
    const controls = [];
    if (isActionControl(zone)) controls.push(zone);
    zone.querySelectorAll?.(ACTION_CONTROL_SELECTOR).forEach((control) => controls.push(control));
    return controls;
  }

  function suppressControlTabStop(control) {
    if (!control.hasAttribute("data-message-action-original-tabindex")) {
      control.setAttribute(
        "data-message-action-original-tabindex",
        control.hasAttribute("tabindex") ? control.getAttribute("tabindex") : "__none__",
      );
    }
    control.setAttribute("tabindex", "-1");
  }

  function restoreControlTabStop(control) {
    if (!control.hasAttribute("data-message-action-original-tabindex")) return;
    const original = control.getAttribute("data-message-action-original-tabindex");
    if (original === "__none__") control.removeAttribute("tabindex");
    else control.setAttribute("tabindex", original || "0");
    control.removeAttribute("data-message-action-original-tabindex");
  }

  function setZoneAccess(zone, enabled) {
    if (!zone) return;
    if (isMobileMode()) {
      zone.setAttribute("aria-hidden", enabled ? "false" : "true");
      zone.setAttribute("data-message-action-access", enabled ? "open" : "closed");
      getZoneControls(zone).forEach((control) => {
        if (enabled) restoreControlTabStop(control);
        else suppressControlTabStop(control);
      });
      return;
    }

    zone.removeAttribute("aria-hidden");
    zone.removeAttribute("data-message-action-access");
    getZoneControls(zone).forEach(restoreControlTabStop);
  }

  function closeMessage(message, options = {}) {
    if (!(message instanceof HTMLElement)) return;
    message.classList.remove("message-actions-open");
    message.setAttribute("data-message-actions-open", "false");
    const trigger = message.querySelector(":scope > .message-actions-disclosure .message-actions-trigger");
    setAttributeIfChanged(trigger, "aria-expanded", "false");
    setAttributeIfChanged(trigger, "aria-label", "Show message actions");
    message.querySelectorAll("[data-message-action-zone]").forEach((zone) => setZoneAccess(zone, false));
    if (openMessage === message) openMessage = null;
    if (options.restoreFocus) trigger?.focus();
  }

  function openMessageActions(message) {
    if (!(message instanceof HTMLElement)) return;
    if (openMessage && openMessage !== message) closeMessage(openMessage);
    openMessage = message;
    message.classList.add("message-actions-open");
    message.setAttribute("data-message-actions-open", "true");
    const trigger = message.querySelector(":scope > .message-actions-disclosure .message-actions-trigger");
    setAttributeIfChanged(trigger, "aria-expanded", "true");
    setAttributeIfChanged(trigger, "aria-label", "Hide message actions");
    message.querySelectorAll("[data-message-action-zone]").forEach((zone) => setZoneAccess(zone, true));
  }

  function toggleMessageActions(message) {
    if (message.getAttribute("data-message-actions-open") === "true") closeMessage(message);
    else openMessageActions(message);
  }

  function createDisclosure(message) {
    const disclosure = document.createElement("div");
    disclosure.className = "message-actions-disclosure";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "message-actions-trigger";
    trigger.setAttribute("aria-label", "Show message actions");
    trigger.setAttribute("title", "Message actions");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">',
      '<circle cx="5" cy="12" r="1.7"></circle>',
      '<circle cx="12" cy="12" r="1.7"></circle>',
      '<circle cx="19" cy="12" r="1.7"></circle>',
      "</svg>",
    ].join("");
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleMessageActions(message);
    });

    disclosure.appendChild(trigger);
    return disclosure;
  }

  function syncDisclosure(message, zones) {
    let disclosure = message.querySelector(":scope > .message-actions-disclosure");
    if (!zones.length) {
      disclosure?.remove();
      message.removeAttribute("data-message-actions-version");
      message.removeAttribute("data-message-actions-open");
      message.classList.remove("message-actions-open");
      if (openMessage === message) openMessage = null;
      return;
    }

    message.setAttribute("data-message-actions-version", MESSAGE_ACTIONS_VERSION);
    if (!message.hasAttribute("data-message-actions-open")) {
      message.setAttribute("data-message-actions-open", "false");
    }

    if (!disclosure) {
      disclosure = createDisclosure(message);
      const standardBar = message.querySelector(":scope > .message-action-bar");
      message.insertBefore(disclosure, standardBar || null);
    }

    const trigger = disclosure.querySelector(".message-actions-trigger");
    const controlledIds = zones.map(ensureZoneId).join(" ");
    setAttributeIfChanged(trigger, "aria-controls", controlledIds);
    setAttributeIfChanged(
      trigger,
      "aria-label",
      message.getAttribute("data-message-actions-open") === "true"
        ? "Hide message actions"
        : "Show message actions",
    );
  }

  function syncMessage(message) {
    if (!(message instanceof HTMLElement) || !message.classList.contains("message")) return;

    const zones = discoverActionZones(message);
    const zoneSet = new Set(zones);
    message.querySelectorAll("[data-message-action-zone]").forEach((zone) => {
      if (zoneSet.has(zone)) return;
      zone.removeAttribute("data-message-action-zone");
      zone.removeAttribute("data-message-action-access");
      zone.removeAttribute("aria-hidden");
      getZoneControls(zone).forEach(restoreControlTabStop);
    });

    zones.forEach((zone) => {
      zone.setAttribute(
        "data-message-action-zone",
        zone.classList.contains("message-action-bar") ? "standard" : "context",
      );
      getZoneControls(zone).forEach((control) => {
        const title = control.getAttribute("title");
        if (!control.hasAttribute("aria-label") && title) control.setAttribute("aria-label", title);
      });
      if (zone.classList.contains("message-action-bar")) {
        setAttributeIfChanged(zone, "role", "toolbar");
        setAttributeIfChanged(zone, "aria-label", "Response actions");
      }
    });

    syncDisclosure(message, zones);
    const isOpen = message.getAttribute("data-message-actions-open") === "true";
    zones.forEach((zone) => setZoneAccess(zone, !isMobileMode() || isOpen));
  }

  function flushPendingMessages() {
    frameId = 0;
    const messages = Array.from(pendingMessages);
    pendingMessages.clear();
    messages.forEach(syncMessage);
  }

  function scheduleMessage(message) {
    if (!(message instanceof HTMLElement)) return;
    pendingMessages.add(message);
    if (!frameId) frameId = requestAnimationFrame(flushPendingMessages);
  }

  function collectMessages(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    const message = element.matches(".message") ? element : element.closest(".message");
    if (message) scheduleMessage(message);
    element.querySelectorAll?.(".message").forEach(scheduleMessage);
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      collectMessages(record.target);
      record.addedNodes.forEach(collectMessages);
      record.removedNodes.forEach((node) => {
        if (node === openMessage || node.contains?.(openMessage)) openMessage = null;
      });
    });
  });

  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "title", "aria-label", "href", "disabled"],
  });

  chatMessages.addEventListener("focusin", (event) => {
    if (!isMobileMode()) return;
    const zone = event.target instanceof Element
      ? event.target.closest("[data-message-action-zone]")
      : null;
    const message = zone?.closest(".message");
    if (message) openMessageActions(message);
  });

  chatMessages.addEventListener("keydown", (event) => {
    const toolbar = event.target instanceof Element
      ? event.target.closest(".message-action-bar[role='toolbar']")
      : null;
    if (toolbar && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      const controls = getZoneControls(toolbar).filter((control) => (
        !control.hasAttribute("disabled")
        && control.getAttribute("aria-disabled") !== "true"
        && control.getAttribute("tabindex") !== "-1"
      ));
      if (controls.length) {
        event.preventDefault();
        const currentIndex = controls.indexOf(document.activeElement);
        let nextIndex = currentIndex;
        if (event.key === "Home") nextIndex = 0;
        else if (event.key === "End") nextIndex = controls.length - 1;
        else {
          const direction = event.key === "ArrowRight" ? 1 : -1;
          nextIndex = (Math.max(0, currentIndex) + direction + controls.length) % controls.length;
        }
        controls[nextIndex]?.focus();
      }
      return;
    }

    if (event.key !== "Escape" || !openMessage) return;
    event.preventDefault();
    closeMessage(openMessage, { restoreFocus: true });
  });

  document.addEventListener("pointerdown", (event) => {
    if (!isMobileMode() || !openMessage || !(event.target instanceof Node)) return;
    if (!openMessage.contains(event.target)) closeMessage(openMessage);
  }, { passive: true });

  const handleInputModeChange = () => {
    if (!isMobileMode() && openMessage) closeMessage(openMessage);
    chatMessages.querySelectorAll(".message").forEach(scheduleMessage);
  };
  if (typeof mobileActionsQuery.addEventListener === "function") {
    mobileActionsQuery.addEventListener("change", handleInputModeChange);
  } else {
    mobileActionsQuery.addListener?.(handleInputModeChange);
  }

  chatMessages.querySelectorAll(".message").forEach(scheduleMessage);
}
