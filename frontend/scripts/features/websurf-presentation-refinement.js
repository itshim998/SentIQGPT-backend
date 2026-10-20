/* ============================================================
   SentIQ Liquid Glass V4 — Phase 7.1
   WebSurf presentation refinement
   ============================================================ */

export const WEBSURF_PRESENTATION_REFINEMENT_VERSION = "7.1";

const MOBILE_SOURCE_SHEET_QUERY = "(max-width: 720px)";
const PANEL_SELECTOR = ".websurf-v2-presentation";
const EXPLORER_SELECTOR = ".websurf-v2-source-explorer";
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function parseWebSurfSourceCount(value, fallback = 0) {
  const match = String(value || "").match(/\b(\d{1,3})\b/);
  const count = match ? Number.parseInt(match[1], 10) : Number(fallback);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

export function splitWebSurfPublisherMeta(value) {
  const parts = String(value || "")
    .split("·")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    publisher: parts[0] || "Source",
    detail: parts.slice(1).join(" · "),
  };
}

export function shouldShowFeaturedWebSurfSources(profile = {}) {
  const sourceCount = Math.max(0, Number(profile.sourceCount) || 0);
  const cardCount = Math.max(0, Number(profile.cardCount) || 0);
  const visualCardCount = Math.max(0, Number(profile.visualCardCount) || 0);
  return Boolean(
    sourceCount >= 3
    && cardCount >= 2
    && (visualCardCount > 0 || sourceCount >= 5),
  );
}

function initWebSurfPresentationRefinement() {
  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const mobileSourceSheet = window.matchMedia?.(MOBILE_SOURCE_SHEET_QUERY) || { matches: false };
  const pendingPanels = new Set();
  let frameId = 0;
  let activeExplorer = null;
  let statusId = 0;

  function setAttributeIfChanged(element, name, value) {
    if (!element || element.getAttribute(name) === value) return;
    element.setAttribute(name, value);
  }

  function getDirectText(element) {
    if (!(element instanceof HTMLElement)) return "";
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function sourceCountForPanel(panel) {
    const explorer = panel.querySelector(EXPLORER_SELECTOR);
    const stored = parseWebSurfSourceCount(explorer?.dataset.sourceCount, 0);
    if (stored) return stored;
    const label = explorer?.querySelector(".websurf-v2-source-explorer-label");
    const parsed = parseWebSurfSourceCount(label?.textContent, 0);
    if (parsed) return parsed;
    return panel.querySelectorAll(".websurf-v2-explorer-source").length;
  }

  function createStatus(panel, sourceCount) {
    let status = panel.querySelector(":scope > .websurf-v2-search-status");
    if (!status) {
      statusId += 1;
      status = document.createElement("header");
      status.className = "websurf-v2-search-status";
      status.id = `websurf-search-status-${statusId}`;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "off");
      status.innerHTML = [
        '<span class="websurf-v2-search-status-icon" aria-hidden="true">',
        '<svg viewBox="0 0 24 24" focusable="false">',
        '<circle cx="11" cy="11" r="6.5"></circle>',
        '<path d="m16 16 4 4"></path>',
        "</svg>",
        "</span>",
        '<span class="websurf-v2-search-status-copy">',
        '<span class="websurf-v2-search-status-title">Web search</span>',
        '<span class="websurf-v2-search-status-meta"></span>',
        "</span>",
        '<span class="websurf-v2-search-status-state"><span aria-hidden="true">✓</span> Ready</span>',
      ].join("");
      panel.insertBefore(status, panel.firstChild);
    }

    const meta = status.querySelector(".websurf-v2-search-status-meta");
    const sourceLabel = `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`;
    if (meta && meta.textContent !== sourceLabel) meta.textContent = sourceLabel;
    status.setAttribute("aria-label", `Search complete: ${sourceLabel}`);
    panel.setAttribute("aria-describedby", status.id);
  }

  function enhancePublisherMeta(meta) {
    if (!(meta instanceof HTMLElement) || meta.dataset.publisherIdentity === "7.1") return;
    const directText = getDirectText(meta) || meta.textContent || "";
    const { publisher, detail } = splitWebSurfPublisherMeta(directText);
    Array.from(meta.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });

    const publisherName = document.createElement("span");
    publisherName.className = "websurf-v2-publisher-name";
    publisherName.textContent = publisher;
    meta.appendChild(publisherName);

    if (detail) {
      const publisherDetail = document.createElement("span");
      publisherDetail.className = "websurf-v2-publisher-detail";
      publisherDetail.textContent = detail;
      meta.appendChild(publisherDetail);
    }

    meta.dataset.publisherIdentity = "7.1";
    meta.dataset.publisher = publisher;
  }

  function enhanceCitationMenu(menu) {
    if (!(menu instanceof HTMLElement) || menu.dataset.websurfMenuVersion === "7.1") return;
    const heading = document.createElement("span");
    heading.className = "websurf-v2-citation-menu-heading";
    heading.textContent = "Sources";
    heading.setAttribute("role", "heading");
    heading.setAttribute("aria-level", "4");
    menu.insertBefore(heading, menu.firstChild);

    menu.querySelectorAll(".websurf-v2-citation-menu-link").forEach((link) => {
      const raw = String(link.textContent || "").trim();
      const divider = raw.indexOf(" — ");
      if (divider <= 0) return;
      const publisher = raw.slice(0, divider).trim();
      const title = raw.slice(divider + 3).trim();
      link.replaceChildren();
      const publisherNode = document.createElement("span");
      publisherNode.className = "websurf-v2-citation-menu-publisher";
      publisherNode.textContent = publisher;
      const titleNode = document.createElement("span");
      titleNode.className = "websurf-v2-citation-menu-title";
      titleNode.textContent = title;
      link.append(publisherNode, titleNode);
    });

    menu.dataset.websurfMenuVersion = "7.1";
  }

  function enhanceCitationChip(chip) {
    if (!(chip instanceof HTMLElement) || chip.dataset.websurfCitationVersion === "7.1") return;
    const raw = String(chip.textContent || "").trim();
    const label = raw.replace(/^\[/, "").replace(/\]$/, "").trim() || "Source";
    const primaryPublisher = label.split("·")[0].trim() || "Source";
    chip.replaceChildren();

    const mark = document.createElement("span");
    mark.className = "websurf-v2-citation-chip-mark";
    mark.textContent = primaryPublisher.charAt(0).toUpperCase() || "S";
    mark.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "websurf-v2-citation-chip-label";
    text.textContent = label;
    chip.append(mark, text);
    chip.dataset.websurfCitationVersion = "7.1";
    chip.dataset.publisher = primaryPublisher;

    const group = chip.closest(".websurf-v2-citation-group");
    const menu = group?.querySelector(".websurf-v2-citation-menu");
    if (menu) enhanceCitationMenu(menu);
  }

  function enhanceFeaturedSources(panel, sourceCount) {
    const shelf = panel.querySelector(":scope > .websurf-v2-featured-sources");
    if (!(shelf instanceof HTMLElement)) return;
    const cards = Array.from(shelf.querySelectorAll(":scope > .websurf-v2-featured-card"));
    const visualCardCount = cards.filter((card) => (
      card.querySelector(".websurf-v2-featured-media:not(.is-image-fallback) img")
    )).length;
    const useful = shouldShowFeaturedWebSurfSources({
      sourceCount,
      cardCount: cards.length,
      visualCardCount,
    });

    shelf.hidden = !useful;
    shelf.dataset.featuredUseful = useful ? "true" : "false";
    if (!useful) return;

    shelf.setAttribute("aria-label", "Top sources");
    cards.forEach((card, index) => {
      card.hidden = index >= 2;
      const media = card.querySelector(".websurf-v2-featured-media");
      const hasImage = Boolean(media?.querySelector("img") && !media.classList.contains("is-image-fallback"));
      card.classList.toggle("is-text-only", !hasImage);
      card.classList.toggle("has-source-image", hasImage);
    });
  }

  function ensureExplorerHeader(explorer, detail, sourceCount) {
    let header = detail.querySelector(":scope > .websurf-v2-source-sheet-header");
    if (!header) {
      header = document.createElement("header");
      header.className = "websurf-v2-source-sheet-header";
      header.innerHTML = [
        '<span class="websurf-v2-source-sheet-handle" aria-hidden="true"></span>',
        '<span class="websurf-v2-source-sheet-heading">',
        '<span class="websurf-v2-source-sheet-title">Sources</span>',
        '<span class="websurf-v2-source-sheet-count"></span>',
        "</span>",
        '<button class="websurf-v2-source-sheet-close" type="button" aria-label="Close sources">',
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m7 7 10 10"></path><path d="m17 7-10 10"></path></svg>',
        "</button>",
      ].join("");
      detail.insertBefore(header, detail.firstChild);
      header.querySelector(".websurf-v2-source-sheet-close")?.addEventListener("click", () => {
        closeExplorer(explorer, true);
      });
    }
    const count = header.querySelector(".websurf-v2-source-sheet-count");
    if (count) count.textContent = `${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`;
  }

  function getExplorerParts(explorer) {
    return {
      toggle: explorer.querySelector(":scope > .websurf-v2-source-explorer-toggle"),
      detail: explorer.querySelector(":scope > .websurf-v2-source-explorer-detail"),
    };
  }

  function updateExplorerLabel(explorer, sourceCount) {
    const label = explorer.querySelector(".websurf-v2-source-explorer-label");
    if (!(label instanceof HTMLElement) || label.dataset.websurfLabelVersion === "7.1") return;
    label.replaceChildren();
    const title = document.createElement("span");
    title.className = "websurf-v2-source-explorer-title";
    title.textContent = "All sources";
    const count = document.createElement("span");
    count.className = "websurf-v2-source-explorer-count";
    count.textContent = String(sourceCount);
    label.append(title, count);
    label.dataset.websurfLabelVersion = "7.1";
  }

  function releaseMobileSheet(explorer, restoreFocus = false) {
    if (!(explorer instanceof HTMLElement)) return;
    const { toggle, detail } = getExplorerParts(explorer);
    explorer.classList.remove("is-mobile-source-sheet");
    detail?.removeAttribute("aria-modal");
    if (detail) {
      detail.setAttribute("role", "region");
      detail.setAttribute("aria-label", "Sources");
    }
    if (activeExplorer === explorer) activeExplorer = null;
    if (!activeExplorer) document.body.classList.remove("has-websurf-source-sheet");
    if (restoreFocus) toggle?.focus({ preventScroll: true });
  }

  function closeExplorer(explorer, restoreFocus = false) {
    if (!(explorer instanceof HTMLElement)) return;
    const { toggle } = getExplorerParts(explorer);
    if (toggle?.getAttribute("aria-expanded") === "true") {
      toggle.click();
      requestAnimationFrame(() => releaseMobileSheet(explorer, restoreFocus));
      return;
    }
    releaseMobileSheet(explorer, restoreFocus);
  }

  function openMobileSheet(explorer) {
    if (!(explorer instanceof HTMLElement) || !mobileSourceSheet.matches) return;
    if (activeExplorer && activeExplorer !== explorer) closeExplorer(activeExplorer, false);
    const wasOpen = activeExplorer === explorer && explorer.classList.contains("is-mobile-source-sheet");
    activeExplorer = explorer;
    document.body.classList.add("has-websurf-source-sheet");
    explorer.classList.add("is-mobile-source-sheet");
    const { detail } = getExplorerParts(explorer);
    if (detail) {
      detail.setAttribute("role", "dialog");
      detail.setAttribute("aria-modal", "true");
      detail.setAttribute("aria-label", "Web sources");
    }
    if (!wasOpen) {
      requestAnimationFrame(() => {
        detail?.querySelector(".websurf-v2-source-sheet-close")?.focus({ preventScroll: true });
      });
    }
  }

  function syncExplorerState(explorer) {
    if (!(explorer instanceof HTMLElement)) return;
    const { toggle, detail } = getExplorerParts(explorer);
    if (!(toggle instanceof HTMLButtonElement) || !(detail instanceof HTMLElement)) return;
    const sourceCount = parseWebSurfSourceCount(explorer.dataset.sourceCount, detail.querySelectorAll(".websurf-v2-explorer-source").length);
    const expanded = toggle.getAttribute("aria-expanded") === "true" && !detail.hidden;
    toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${sourceCount} web ${sourceCount === 1 ? "source" : "sources"}`);
    explorer.classList.toggle("is-expanded", expanded);
    if (expanded && mobileSourceSheet.matches) openMobileSheet(explorer);
    else releaseMobileSheet(explorer, false);
  }

  function enhanceExplorer(panel, sourceCount) {
    const explorer = panel.querySelector(EXPLORER_SELECTOR);
    if (!(explorer instanceof HTMLElement)) return;
    explorer.dataset.sourceCount = String(sourceCount);
    explorer.dataset.websurfExplorerVersion = "7.1";
    const { toggle, detail } = getExplorerParts(explorer);
    if (!(toggle instanceof HTMLButtonElement) || !(detail instanceof HTMLElement)) return;

    updateExplorerLabel(explorer, sourceCount);
    ensureExplorerHeader(explorer, detail, sourceCount);
    detail.querySelectorAll(".websurf-v2-explorer-meta").forEach(enhancePublisherMeta);
    detail.querySelectorAll(".websurf-v2-explorer-source").forEach((source) => {
      if (source.dataset.websurfSourceInteractionVersion === "7.1") return;
      source.addEventListener("click", () => {
        if (mobileSourceSheet.matches) requestAnimationFrame(() => closeExplorer(explorer, false));
      });
      source.dataset.websurfSourceInteractionVersion = "7.1";
    });

    if (explorer.dataset.websurfInteractionVersion !== "7.1") {
      toggle.addEventListener("click", () => requestAnimationFrame(() => syncExplorerState(explorer)));
      explorer.dataset.websurfInteractionVersion = "7.1";
    }
    syncExplorerState(explorer);
  }

  function syncPanel(panel) {
    if (!(panel instanceof HTMLElement) || !panel.matches(PANEL_SELECTOR)) return;
    panel.dataset.websurfRefinementVersion = WEBSURF_PRESENTATION_REFINEMENT_VERSION;
    const sourceCount = sourceCountForPanel(panel);
    createStatus(panel, sourceCount);
    panel.querySelectorAll(".websurf-v2-featured-meta, .websurf-v2-explorer-meta").forEach(enhancePublisherMeta);
    panel.querySelectorAll(".websurf-v2-publisher-chip").forEach(enhanceCitationChip);
    enhanceFeaturedSources(panel, sourceCount);
    enhanceExplorer(panel, sourceCount);
  }

  function flushPanels() {
    frameId = 0;
    const panels = Array.from(pendingPanels);
    pendingPanels.clear();
    panels.forEach(syncPanel);
    if (activeExplorer && !activeExplorer.isConnected) releaseMobileSheet(activeExplorer, false);
  }

  function schedulePanel(panel) {
    if (!(panel instanceof HTMLElement) || !panel.matches(PANEL_SELECTOR)) return;
    pendingPanels.add(panel);
    if (!frameId) frameId = requestAnimationFrame(flushPanels);
  }

  function collectPanels(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    const panel = element.matches(PANEL_SELECTOR) ? element : element.closest(PANEL_SELECTOR);
    if (panel) schedulePanel(panel);
    element.querySelectorAll?.(PANEL_SELECTOR).forEach(schedulePanel);
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      collectPanels(record.target);
      record.addedNodes.forEach(collectPanels);
    });
  });
  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "hidden", "aria-expanded"],
  });

  document.addEventListener("keydown", (event) => {
    if (!activeExplorer || !mobileSourceSheet.matches) return;
    const { toggle, detail } = getExplorerParts(activeExplorer);
    if (event.key === "Escape") {
      event.preventDefault();
      closeExplorer(activeExplorer, true);
      return;
    }
    if (event.key !== "Tab" || !(detail instanceof HTMLElement)) return;
    const focusable = Array.from(detail.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((element) => element instanceof HTMLElement && !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!detail.contains(document.activeElement)) {
      event.preventDefault();
      (toggle || first).focus();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!activeExplorer || !mobileSourceSheet.matches || !(event.target instanceof Node)) return;
    const { toggle, detail } = getExplorerParts(activeExplorer);
    if (detail?.contains(event.target) || toggle?.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    closeExplorer(activeExplorer, true);
  }, true);

  const handleViewportChange = () => {
    chatMessages.querySelectorAll(PANEL_SELECTOR).forEach(schedulePanel);
    if (!mobileSourceSheet.matches && activeExplorer) releaseMobileSheet(activeExplorer, false);
  };
  if (typeof mobileSourceSheet.addEventListener === "function") {
    mobileSourceSheet.addEventListener("change", handleViewportChange);
  } else if (typeof mobileSourceSheet.addListener === "function") {
    mobileSourceSheet.addListener(handleViewportChange);
  }

  chatMessages.querySelectorAll(PANEL_SELECTOR).forEach(schedulePanel);
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initWebSurfPresentationRefinement();
}
