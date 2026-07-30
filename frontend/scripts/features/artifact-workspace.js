import {
  ARTIFACT_WORKSPACE_MEDIA_QUERY,
  ARTIFACT_WORKSPACE_VERSION,
  buildArtifactWorkspaceTitle,
  getArtifactWorkspacePlaceholderHeight,
  normalizeArtifactWorkspaceKind,
  shouldOfferArtifactWorkspace,
} from "./artifact-workspace-state.mjs";

const ARTIFACT_SELECTOR = ".generated-file-panel, .message-chart-container";
const FOCUSABLE_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function initializeArtifactWorkspace() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQArtifactWorkspace?.version === ARTIFACT_WORKSPACE_VERSION) return;

  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const mediaQuery = window.matchMedia?.(ARTIFACT_WORKSPACE_MEDIA_QUERY) || { matches: false };
  const decorated = new WeakSet();
  const backgroundState = new Map();
  let active = null;
  let observerFrame = 0;
  const pendingSurfaces = new Set();

  const overlay = document.createElement("div");
  overlay.className = "sentiq-artifact-workspace-overlay";
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  overlay.dataset.sentiqArtifactWorkspace = ARTIFACT_WORKSPACE_VERSION;

  const shell = document.createElement("section");
  shell.className = "sentiq-artifact-workspace-shell";
  shell.setAttribute("role", "dialog");
  shell.setAttribute("aria-modal", "true");
  shell.setAttribute("aria-labelledby", "sentiq-artifact-workspace-title");

  const header = document.createElement("header");
  header.className = "sentiq-artifact-workspace-header";
  const heading = document.createElement("div");
  heading.className = "sentiq-artifact-workspace-heading";
  const kicker = document.createElement("span");
  kicker.textContent = "Artifact workspace";
  const title = document.createElement("strong");
  title.id = "sentiq-artifact-workspace-title";
  heading.append(kicker, title);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "sentiq-artifact-workspace-close";
  closeButton.setAttribute("aria-label", "Close artifact workspace");
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>';
  header.append(heading, closeButton);

  const content = document.createElement("div");
  content.className = "sentiq-artifact-workspace-content";
  shell.append(header, content);
  overlay.appendChild(shell);
  document.body.appendChild(overlay);

  function getActions(surface) {
    if (surface.matches(".generated-file-panel")) {
      return surface.querySelector(":scope > .generated-file-header .generated-file-actions");
    }
    return surface.querySelector(":scope > .asset-chart-header .asset-result-actions");
  }

  function getSurfaceTitle(surface) {
    const kind = normalizeArtifactWorkspaceKind(surface.className);
    const visibleTitle = surface.querySelector(
      ".generated-file-title, .asset-result-kicker, .asset-result-meta",
    )?.textContent;
    const formatClass = Array.from(surface.classList).find((name) => name.startsWith("format-")) || "";
    return buildArtifactWorkspaceTitle({ kind, title: visibleTitle, format: formatClass });
  }

  function createExpandButton(surface) {
    const kind = normalizeArtifactWorkspaceKind(surface.className);
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === "file"
      ? "generated-file-action sentiq-artifact-expand"
      : "asset-result-action sentiq-artifact-expand";
    button.dataset.sentiqArtifactExpand = ARTIFACT_WORKSPACE_VERSION;
    button.setAttribute("aria-label", "Open in expanded artifact workspace");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '<path d="M8 3H3v5"></path><path d="M16 3h5v5"></path>',
      '<path d="M8 21H3v-5"></path><path d="M16 21h5v-5"></path>',
      "</svg>",
      "<span>Expand</span>",
    ].join("");
    button.addEventListener("click", () => openWorkspace(surface, button));
    return button;
  }

  function syncButtonAvailability(button, surface) {
    const kind = normalizeArtifactWorkspaceKind(surface.className);
    const offered = shouldOfferArtifactWorkspace({
      mediaMatches: Boolean(mediaQuery.matches),
      connected: surface.isConnected,
      kind,
    });
    button.hidden = !offered;
    button.disabled = !offered;
    button.setAttribute("aria-hidden", offered ? "false" : "true");
  }

  function decorateSurface(surface) {
    if (!(surface instanceof HTMLElement) || !surface.isConnected) return;
    const actions = getActions(surface);
    if (!(actions instanceof HTMLElement)) return;
    let button = actions.querySelector(":scope > .sentiq-artifact-expand");
    if (!(button instanceof HTMLButtonElement)) {
      button = createExpandButton(surface);
      actions.appendChild(button);
    }
    decorated.add(surface);
    surface.dataset.sentiqArtifactWorkspaceReady = ARTIFACT_WORKSPACE_VERSION;
    syncButtonAvailability(button, surface);
  }

  function scheduleSurface(surface) {
    if (!(surface instanceof HTMLElement) || !surface.matches(ARTIFACT_SELECTOR)) return;
    pendingSurfaces.add(surface);
    if (observerFrame) return;
    observerFrame = window.requestAnimationFrame(() => {
      observerFrame = 0;
      const batch = Array.from(pendingSurfaces);
      pendingSurfaces.clear();
      batch.forEach(decorateSurface);
      if (active && !active.placeholder.isConnected) closeWorkspace({ restoreFocus: false });
    });
  }

  function collect(node) {
    const element = node instanceof Element
      ? node
      : node?.parentElement instanceof Element
        ? node.parentElement
        : null;
    if (!element) return;
    if (element.matches(ARTIFACT_SELECTOR)) scheduleSurface(element);
    const closest = element.closest(ARTIFACT_SELECTOR);
    if (closest instanceof HTMLElement) scheduleSurface(closest);
    element.querySelectorAll?.(ARTIFACT_SELECTOR).forEach(scheduleSurface);
  }

  function setBackgroundInert(enabled) {
    const siblings = Array.from(document.body.children).filter((node) => (
      node instanceof HTMLElement
      && node !== overlay
      && !["SCRIPT", "STYLE", "LINK"].includes(node.tagName)
    ));
    siblings.forEach((node) => {
      if (enabled) {
        if (!backgroundState.has(node)) {
          backgroundState.set(node, {
            inert: Boolean(node.inert),
            hadInert: node.hasAttribute("inert"),
            ariaHidden: node.getAttribute("aria-hidden"),
          });
        }
        node.inert = true;
        node.setAttribute("inert", "");
        node.setAttribute("aria-hidden", "true");
        return;
      }
      const previous = backgroundState.get(node);
      if (!previous) return;
      node.inert = previous.inert;
      if (previous.hadInert) node.setAttribute("inert", "");
      else node.removeAttribute("inert");
      if (previous.ariaHidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", previous.ariaHidden);
      backgroundState.delete(node);
    });
  }

  function resizeArtifact(surface) {
    window.requestAnimationFrame(() => {
      surface.querySelectorAll(".js-plotly-plot").forEach((plot) => {
        window.Plotly?.Plots?.resize?.(plot);
      });
      surface.querySelectorAll("canvas").forEach((canvas) => {
        window.Chart?.getChart?.(canvas)?.resize?.();
      });
      window.dispatchEvent(new Event("resize"));
    });
  }

  function restoreOriginFocus(originButton) {
    if (!(originButton instanceof HTMLElement)) return;
    const focusIfWorkspaceStillOwnsFocus = () => {
      if (!originButton.isConnected || originButton.hidden || originButton.matches(":disabled")) return;
      const focused = document.activeElement;
      const workspaceStillOwnsFocus = !focused
        || focused === document.body
        || focused === closeButton
        || overlay.contains(focused);
      if (workspaceStillOwnsFocus) originButton.focus({ preventScroll: true });
    };
    focusIfWorkspaceStillOwnsFocus();
    window.requestAnimationFrame(focusIfWorkspaceStillOwnsFocus);
    window.setTimeout(focusIfWorkspaceStillOwnsFocus, 0);
    window.setTimeout(focusIfWorkspaceStillOwnsFocus, 60);
    window.setTimeout(focusIfWorkspaceStillOwnsFocus, 140);
  }

  function openWorkspace(surface, originButton) {
    if (!(surface instanceof HTMLElement) || !(originButton instanceof HTMLButtonElement)) return;
    const kind = normalizeArtifactWorkspaceKind(surface.className);
    if (!shouldOfferArtifactWorkspace({
      mediaMatches: Boolean(mediaQuery.matches),
      connected: surface.isConnected,
      kind,
    })) return;
    if (active?.surface === surface) return;
    if (active) closeWorkspace({ restoreFocus: false });

    const parent = surface.parentNode;
    if (!(parent instanceof Node)) return;
    const rect = surface.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "sentiq-artifact-workspace-placeholder";
    placeholder.style.blockSize = getArtifactWorkspacePlaceholderHeight(rect.height);
    placeholder.setAttribute("aria-hidden", "true");
    parent.insertBefore(placeholder, surface);

    active = {
      surface,
      parent,
      nextSibling: surface.nextSibling,
      placeholder,
      originButton,
      chatScrollTop: chatMessages.scrollTop,
    };
    title.textContent = getSurfaceTitle(surface);
    originButton.setAttribute("aria-expanded", "true");
    surface.classList.add("sentiq-artifact-workspace-surface");
    surface.dataset.sentiqArtifactWorkspaceOpen = ARTIFACT_WORKSPACE_VERSION;
    content.appendChild(surface);
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("sentiq-artifact-workspace-open");
    setBackgroundInert(true);
    resizeArtifact(surface);
    window.requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
  }

  function closeWorkspace(options = {}) {
    if (!active) return;
    const record = active;
    active = null;
    const { surface, parent, nextSibling, placeholder, originButton, chatScrollTop } = record;

    surface.classList.remove("sentiq-artifact-workspace-surface");
    delete surface.dataset.sentiqArtifactWorkspaceOpen;
    if (parent.isConnected) {
      if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(surface, nextSibling);
      else parent.appendChild(surface);
    } else {
      surface.remove();
    }
    placeholder.remove();
    originButton?.setAttribute("aria-expanded", "false");
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("sentiq-artifact-workspace-open");
    setBackgroundInert(false);
    chatMessages.scrollTop = chatScrollTop;
    if (originButton instanceof HTMLButtonElement) syncButtonAvailability(originButton, surface);
    if (surface.isConnected) resizeArtifact(surface);
    if (options.restoreFocus !== false) restoreOriginFocus(originButton);
  }

  function syncAllButtons() {
    chatMessages.querySelectorAll(ARTIFACT_SELECTOR).forEach((surface) => {
      if (!(surface instanceof HTMLElement)) return;
      const button = surface.querySelector(".sentiq-artifact-expand");
      if (button instanceof HTMLButtonElement) syncButtonAvailability(button, surface);
      else scheduleSurface(surface);
    });
    if (active && !mediaQuery.matches) closeWorkspace({ restoreFocus: false });
  }

  closeButton.addEventListener("click", () => closeWorkspace());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeWorkspace();
  });
  overlay.addEventListener("keydown", (event) => {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeWorkspace();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(shell.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((node) => node instanceof HTMLElement && !node.hidden && node.getClientRects().length > 0);
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

  const observer = new MutationObserver((records) => records.forEach((record) => {
    collect(record.target);
    record.addedNodes.forEach(collect);
    if (active && !active.placeholder.isConnected) closeWorkspace({ restoreFocus: false });
  }));
  observer.observe(chatMessages, { childList: true, subtree: true });
  mediaQuery.addEventListener?.("change", syncAllButtons);
  window.addEventListener("pagehide", () => closeWorkspace({ restoreFocus: false }), { passive: true });
  chatMessages.querySelectorAll(ARTIFACT_SELECTOR).forEach(scheduleSurface);

  window.SentIQArtifactWorkspace = Object.freeze({
    version: ARTIFACT_WORKSPACE_VERSION,
    isOpen: () => Boolean(active),
    close: closeWorkspace,
    sync: syncAllButtons,
  });
}

initializeArtifactWorkspace();
