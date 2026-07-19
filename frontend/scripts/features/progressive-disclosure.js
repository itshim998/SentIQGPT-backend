/* SentIQ Liquid Glass V4 — Phase 9.2 intelligent progressive disclosure */

const PROGRESSIVE_DISCLOSURE_VERSION = "9.2";
const MOBILE_QUERY = "(hover: none), (pointer: coarse), (max-width: 768px)";
const CONTROL_SELECTOR = "button, a[href], [role='button']";
const SURFACE_SELECTOR = [
  ".deep-research-card",
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(",");
const ASSET_ZONE_SELECTOR = [
  ".asset-image-overlay",
  ".asset-result-actions",
  ".generated-file-actions",
  ".generated-file-toolbar",
  ".generated-file-footer",
  ".generated-preview-actions",
  ".message-chart-actions",
  ".chart-actions",
  ".image-actions",
].join(",");
const RESEARCH_ZONE_SELECTOR = [
  ".deep-research-report-actions",
  ".deep-research-actions",
  ".deep-research-action-row",
  ".deep-research-source-actions",
  ".deep-research-export-actions",
].join(",");
const CRITICAL_RESEARCH_SELECTOR = ".deep-research-cancel-wrapper, .deep-research-cancel-btn";
const ACTION_LABEL_PATTERN = /\b(copy|retry|regenerate|continue|resume|download|export|open|save|remove|share|feedback|helpful|unhelpful|cancel|stop|view)\b/i;

function initializeProgressiveDisclosure() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQProgressiveDisclosure?.version === PROGRESSIVE_DISCLOSURE_VERSION) return;

  const chatMessages = document.getElementById("chat-messages");
  const accountPanel = document.getElementById("account-panel");
  const accountButton = document.getElementById("account-btn");
  const mobileQuery = window.matchMedia?.(MOBILE_QUERY) || { matches: false };
  const pendingRoots = new Set();
  const triggerBindings = new WeakSet();
  const originalTabIndex = new WeakMap();
  const accountAnchor = accountPanel ? document.createComment("sentiq-account-panel-home") : null;
  let frame = 0;
  let sheet = null;
  let sheetPanel = null;
  let sheetActions = null;
  let sheetTitle = null;
  let sheetDescription = null;
  let sheetSource = null;
  let restoreFocus = null;
  let accountBackdrop = null;

  if (accountPanel && accountAnchor) accountPanel.parentNode?.insertBefore(accountAnchor, accountPanel);

  function isMobile() {
    return Boolean(mobileQuery.matches);
  }

  function setAttributeIfChanged(element, name, value) {
    if (!(element instanceof Element)) return;
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function describeControl(control) {
    const explicit = [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.querySelector?.(".message-action-label, .generated-file-action-label, span")?.textContent,
      control.textContent,
    ].find((value) => String(value || "").trim());
    return String(explicit || "Action").replace(/\s+/g, " ").trim();
  }

  function isSecondaryControl(control) {
    if (!(control instanceof HTMLElement)) return false;
    if (control.matches(".progressive-disclosure-trigger, .progressive-sheet-action")) return false;
    if (control.matches(CRITICAL_RESEARCH_SELECTOR)) return false;
    const descriptor = `${describeControl(control)} ${typeof control.className === "string" ? control.className : ""}`;
    return ACTION_LABEL_PATTERN.test(descriptor);
  }

  function controlsForZones(zones) {
    const controls = [];
    const seen = new Set();
    zones.forEach((zone) => {
      if (!(zone instanceof HTMLElement)) return;
      const candidates = zone.matches(CONTROL_SELECTOR)
        ? [zone]
        : Array.from(zone.querySelectorAll(CONTROL_SELECTOR));
      candidates.forEach((control) => {
        if (!isSecondaryControl(control) || seen.has(control)) return;
        seen.add(control);
        controls.push(control);
      });
    });
    return controls;
  }

  function setControlAccess(control, enabled) {
    if (!(control instanceof HTMLElement)) return;
    if (enabled) {
      if (originalTabIndex.has(control)) {
        const value = originalTabIndex.get(control);
        if (value === null) control.removeAttribute("tabindex");
        else setAttributeIfChanged(control, "tabindex", value);
        originalTabIndex.delete(control);
      }
      control.removeAttribute("data-progressive-suppressed");
      return;
    }
    if (!originalTabIndex.has(control)) {
      originalTabIndex.set(control, control.hasAttribute("tabindex") ? control.getAttribute("tabindex") : null);
    }
    setAttributeIfChanged(control, "tabindex", "-1");
    setAttributeIfChanged(control, "data-progressive-suppressed", "true");
  }

  function setZoneAccess(zone, enabled) {
    if (!(zone instanceof HTMLElement)) return;
    setAttributeIfChanged(zone, "data-progressive-mobile-access", enabled ? "open" : "closed");
    setAttributeIfChanged(zone, "aria-hidden", enabled ? "false" : "true");
    controlsForZones([zone]).forEach((control) => setControlAccess(control, enabled));
  }

  function kindForSurface(surface) {
    return surface.matches(".deep-research-card") ? "research" : "asset";
  }

  function zonesForSurface(surface, kind = kindForSurface(surface)) {
    if (!(surface instanceof HTMLElement)) return [];
    const selector = kind === "research" ? RESEARCH_ZONE_SELECTOR : ASSET_ZONE_SELECTOR;
    return Array.from(new Set(surface.querySelectorAll(selector)));
  }

  function assetKind(surface) {
    return surface?.dataset.assetResultKind
      || (surface?.matches(".image-generation-card") ? "image" : "")
      || (surface?.matches(".message-chart-container") ? "chart" : "")
      || (surface?.matches(".generated-file-panel") ? "file" : "")
      || "asset";
  }

  function titleForKind(kind, surface = null) {
    if (kind === "research") return surface?.classList.contains("running") ? "Research controls" : "Research actions";
    if (kind === "image") return "Image actions";
    if (kind === "chart") return "Chart actions";
    if (kind === "file") return "File actions";
    if (kind === "message") return "Message actions";
    return "Available actions";
  }

  function ensureSurfaceTrigger(surface, kind, zones) {
    if (!(surface instanceof HTMLElement)) return;
    const controls = controlsForZones(zones);
    let trigger = surface.querySelector(
      ":scope > .progressive-disclosure-trigger, :scope > .asset-result-header > .progressive-disclosure-trigger, :scope > .deep-research-workspace-header > .progressive-disclosure-trigger, :scope > .image-generation-frame > .progressive-disclosure-trigger",
    );
    if (!controls.length) {
      trigger?.remove();
      return;
    }
    if (!trigger) {
      trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "progressive-disclosure-trigger";
      trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>';
      const host = kind === "research"
        ? surface.querySelector(":scope > .deep-research-workspace-header") || surface
        : surface.querySelector(":scope > .asset-result-header")
          || surface.querySelector(":scope > .image-generation-frame")
          || surface;
      host.appendChild(trigger);
    }
    const resolvedKind = kind === "asset" ? assetKind(surface) : kind;
    setAttributeIfChanged(trigger, "aria-label", `Show ${titleForKind(resolvedKind, surface).toLowerCase()}`);
    setAttributeIfChanged(trigger, "title", titleForKind(resolvedKind, surface));
    setAttributeIfChanged(trigger, "aria-haspopup", "dialog");
    trigger.dataset.progressiveKind = resolvedKind;
    if (triggerBindings.has(trigger)) return;
    triggerBindings.add(trigger);
    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSheet({
        title: titleForKind(trigger.dataset.progressiveKind, surface),
        description: kind === "research" ? "Controls relevant to this research task." : "Controls for this generated result.",
        controls: controlsForZones(zonesForSurface(surface, kind)),
        source: surface,
        trigger,
      });
    });
  }

  function markSurface(surface) {
    if (!(surface instanceof HTMLElement)) return;
    const kind = kindForSurface(surface);
    surface.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
    surface.dataset.progressiveSurface = kind;
    const zones = zonesForSurface(surface, kind);
    zones.forEach((zone) => {
      zone.dataset.progressiveZone = kind;
      zone.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
      if (isMobile()) setZoneAccess(zone, false);
      else {
        zone.removeAttribute("data-progressive-mobile-access");
        zone.removeAttribute("aria-hidden");
        controlsForZones([zone]).forEach((control) => setControlAccess(control, true));
      }
    });
    const running = kind === "research" && (surface.classList.contains("running") || surface.getAttribute("aria-busy") === "true");
    surface.dataset.progressiveRelevant = running ? "true" : "false";
    ensureSurfaceTrigger(surface, kind, zones);
  }

  function markMessage(message) {
    if (!(message instanceof HTMLElement)) return;
    message.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
    const bar = message.querySelector(":scope > .message-action-bar");
    if (!bar) return;
    bar.dataset.progressiveZone = "message";
    bar.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
  }

  function syncAccountPlacement() {
    if (!(accountPanel instanceof HTMLElement) || !accountAnchor) return;
    if (isMobile()) {
      if (accountPanel.parentElement !== document.body) document.body.appendChild(accountPanel);
      return;
    }
    if (accountAnchor.parentNode && accountPanel.previousSibling !== accountAnchor) {
      accountAnchor.parentNode.insertBefore(accountPanel, accountAnchor.nextSibling);
    }
  }

  function markAccountSurface() {
    if (!(accountPanel instanceof HTMLElement)) return;
    syncAccountPlacement();
    accountPanel.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
    accountPanel.dataset.progressiveSurface = "account";
    accountPanel.querySelectorAll(".account-panel-actions, .account-panel-signout").forEach((zone) => {
      zone.dataset.progressiveZone = "account";
    });
    syncAccountBackdrop();
  }

  function collect(root) {
    if (!(root instanceof Node)) return;
    const element = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
    if (!(element instanceof Element)) return;
    const surface = element.matches(SURFACE_SELECTOR) ? element : element.closest(SURFACE_SELECTOR);
    if (surface) pendingRoots.add(surface);
    element.querySelectorAll?.(SURFACE_SELECTOR).forEach((item) => pendingRoots.add(item));
    const message = element.matches(".message") ? element : element.closest(".message");
    if (message) pendingRoots.add(message);
    element.querySelectorAll?.(".message").forEach((item) => pendingRoots.add(item));
    schedule();
  }

  function flush() {
    frame = 0;
    const roots = Array.from(pendingRoots);
    pendingRoots.clear();
    roots.forEach((root) => {
      if (!root.isConnected) return;
      if (root.matches(SURFACE_SELECTOR)) markSurface(root);
      if (root.matches(".message")) markMessage(root);
    });
    markAccountSurface();
  }

  function schedule() {
    if (!frame) frame = window.requestAnimationFrame(flush);
  }

  function createSheet() {
    if (sheet) return;
    sheet = document.createElement("div");
    sheet.id = "sentiq-secondary-action-sheet";
    sheet.className = "sentiq-secondary-action-sheet";
    sheet.hidden = true;
    setAttributeIfChanged(sheet, "aria-hidden", "true");
    sheet.innerHTML = [
      '<button class="sentiq-secondary-action-backdrop" type="button" tabindex="-1" aria-label="Close actions"></button>',
      '<section class="sentiq-secondary-action-panel" role="dialog" aria-modal="true" aria-labelledby="sentiq-secondary-action-title" aria-describedby="sentiq-secondary-action-description">',
      '<span class="sentiq-secondary-action-handle" aria-hidden="true"></span>',
      '<header class="sentiq-secondary-action-header">',
      '<span><strong id="sentiq-secondary-action-title"></strong><small id="sentiq-secondary-action-description"></small></span>',
      '<button class="sentiq-secondary-action-close" type="button" aria-label="Close actions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>',
      '</header>',
      '<div class="sentiq-secondary-action-list"></div>',
      '</section>',
    ].join("");
    document.body.appendChild(sheet);
    sheetPanel = sheet.querySelector(".sentiq-secondary-action-panel");
    sheetActions = sheet.querySelector(".sentiq-secondary-action-list");
    sheetTitle = sheet.querySelector("#sentiq-secondary-action-title");
    sheetDescription = sheet.querySelector("#sentiq-secondary-action-description");
    sheet.querySelector(".sentiq-secondary-action-backdrop")?.addEventListener("click", () => closeSheet());
    sheet.querySelector(".sentiq-secondary-action-close")?.addEventListener("click", () => closeSheet());
  }

  function createProxy(control) {
    const proxy = document.createElement("button");
    proxy.type = "button";
    proxy.className = "progressive-sheet-action";
    proxy.disabled = Boolean(control.disabled || control.getAttribute("aria-disabled") === "true");
    const icon = control.querySelector?.("svg")?.cloneNode(true);
    if (icon) {
      icon.setAttribute("aria-hidden", "true");
      icon.removeAttribute("id");
      const iconWrap = document.createElement("span");
      iconWrap.className = "progressive-sheet-action-icon";
      iconWrap.appendChild(icon);
      proxy.appendChild(iconWrap);
    }
    const copy = document.createElement("span");
    copy.className = "progressive-sheet-action-copy";
    copy.textContent = describeControl(control);
    proxy.appendChild(copy);
    if (control.getAttribute("aria-pressed")) setAttributeIfChanged(proxy, "aria-pressed", control.getAttribute("aria-pressed"));
    proxy.addEventListener("click", () => {
      if (proxy.disabled || !control.isConnected) return;
      control.click();
      closeSheet({ restore: false });
    });
    return proxy;
  }

  function openSheet({ title, description, controls, source, trigger }) {
    if (!isMobile()) return false;
    const actionable = Array.from(new Set(controls || [])).filter((control) => isSecondaryControl(control));
    if (!actionable.length) return false;
    createSheet();
    sheetSource = source instanceof HTMLElement ? source : null;
    restoreFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
    sheetTitle.textContent = title || "Available actions";
    sheetDescription.textContent = description || "Choose an action.";
    sheetActions.replaceChildren(...actionable.map(createProxy));
    sheet.hidden = false;
    setAttributeIfChanged(sheet, "aria-hidden", "false");
    sheet.dataset.open = "true";
    document.body.classList.add("sentiq-secondary-actions-open");
    sheetSource?.setAttribute("data-progressive-sheet-open", "true");
    window.requestAnimationFrame(() => sheetActions.querySelector("button:not(:disabled)")?.focus());
    return true;
  }

  function closeSheet(options = {}) {
    if (!sheet || sheet.hidden) return;
    sheet.dataset.open = "false";
    setAttributeIfChanged(sheet, "aria-hidden", "true");
    sheet.hidden = true;
    document.body.classList.remove("sentiq-secondary-actions-open");
    sheetSource?.removeAttribute("data-progressive-sheet-open");
    const focusTarget = restoreFocus;
    sheetSource = null;
    restoreFocus = null;
    if (options.restore !== false && focusTarget instanceof HTMLElement && focusTarget.isConnected) focusTarget.focus();
  }

  function openMessageActions(message, trigger) {
    if (!(message instanceof HTMLElement)) return false;
    const standardBar = message.querySelector(":scope > .message-action-bar");
    let controls = standardBar ? controlsForZones([standardBar]) : [];
    let title = "Message actions";
    let description = "Actions for this message.";
    if (!controls.length) {
      controls = controlsForZones(Array.from(message.querySelectorAll("[data-message-action-zone]")));
      title = "Available actions";
      description = "Actions related to this response.";
    }
    return openSheet({ title, description, controls, source: message, trigger });
  }

  function createAccountBackdrop() {
    if (accountBackdrop) return;
    accountBackdrop = document.createElement("button");
    accountBackdrop.type = "button";
    accountBackdrop.className = "progressive-account-backdrop";
    accountBackdrop.setAttribute("aria-label", "Close account menu");
    accountBackdrop.hidden = true;
    accountBackdrop.addEventListener("click", () => accountButton?.click());
    document.body.appendChild(accountBackdrop);
  }

  function syncAccountBackdrop() {
    if (!(accountPanel instanceof HTMLElement)) return;
    const open = isMobile() && (accountPanel.classList.contains("visible") || accountPanel.getAttribute("aria-hidden") === "false");
    if (open) createAccountBackdrop();
    if (accountBackdrop) {
      accountBackdrop.hidden = !open;
      setAttributeIfChanged(accountBackdrop, "aria-hidden", open ? "false" : "true");
    }
    document.body.classList.toggle("sentiq-account-sheet-open", open);
    accountPanel.dataset.progressiveAccountSheet = isMobile() ? "true" : "false";
  }

  chatMessages?.addEventListener("click", (event) => {
    if (!isMobile() || !(event.target instanceof Element)) return;
    const trigger = event.target.closest(".message-actions-trigger");
    if (!trigger) return;
    const message = trigger.closest(".message");
    if (!message || !openMessageActions(message, trigger)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (sheet && !sheet.hidden) {
        event.preventDefault();
        closeSheet();
      }
      return;
    }
    if (event.key !== "Tab" || !sheet || sheet.hidden || !(sheetPanel instanceof HTMLElement)) return;
    const controls = Array.from(sheetPanel.querySelectorAll("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])"));
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("sentiq-ui-state-change", () => {
    if (sheetSource && !sheetSource.isConnected) closeSheet({ restore: false });
    schedule();
  });

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      collect(record.target);
      record.addedNodes.forEach(collect);
    });
    syncAccountBackdrop();
  });

  if (chatMessages) {
    observer.observe(chatMessages, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-busy", "aria-hidden", "disabled", "data-asset-result-kind"],
    });
    collect(chatMessages);
  }
  if (accountPanel) {
    observer.observe(accountPanel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "aria-hidden", "style"],
    });
  }

  const handleModeChange = () => {
    if (!isMobile()) closeSheet({ restore: false });
    chatMessages?.querySelectorAll(SURFACE_SELECTOR).forEach((surface) => pendingRoots.add(surface));
    markAccountSurface();
    schedule();
  };
  if (typeof mobileQuery.addEventListener === "function") mobileQuery.addEventListener("change", handleModeChange);
  else mobileQuery.addListener?.(handleModeChange);

  if (window.visualViewport) {
    const syncViewport = () => {
      const height = `${Math.round(window.visualViewport.height)}px`;
      if (document.documentElement.style.getPropertyValue("--sentiq-progressive-viewport-height") !== height) {
        document.documentElement.style.setProperty("--sentiq-progressive-viewport-height", height);
      }
    };
    window.visualViewport.addEventListener("resize", syncViewport, { passive: true });
    syncViewport();
  }

  window.SentIQProgressiveDisclosure = Object.freeze({
    version: PROGRESSIVE_DISCLOSURE_VERSION,
    openSheet,
    closeSheet,
    openMessageActions,
    sync: schedule,
    isMobile,
  });

  document.documentElement.dataset.progressiveDisclosureVersion = PROGRESSIVE_DISCLOSURE_VERSION;
  markAccountSurface();
  schedule();
}

initializeProgressiveDisclosure();
