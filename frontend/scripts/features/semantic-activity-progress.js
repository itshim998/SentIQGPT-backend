/* SentIQ Liquid Glass V4 — Phase 7.4 restrained semantic progress */

import {
  SEMANTIC_ACTIVITY_VERSION,
  SEMANTIC_SEARCH_COMPARE_DELAY_MS,
  getSemanticActivityLabel,
  getTimedSemanticActivity,
  inferSemanticActivity,
} from "./semantic-activity-state.js";

const INLINE_SELECTOR = ".response-inline-loader";
const LEGACY_SELECTOR = ".sentiq-loader";
const SURFACE_SELECTOR = [
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
].join(", ");

const ACTIVITY_LOGO_VARIANTS = Object.freeze({
  thinking: "neural-orbit",
  "reading-files": "infinite-dialog",
  "preparing-document": "infinite-dialog",
});

function initSemanticActivityProgress() {
  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;

  const pending = new Set();
  const searchTimers = new WeakMap();
  let frame = 0;

  function setText(element, value) {
    if (element && element.textContent !== value) element.textContent = value;
  }

  function setAttribute(element, name, value) {
    if (element && element.getAttribute(name) !== value) element.setAttribute(name, value);
  }

  function hasVisibleAttachmentContext(bubble) {
    const previous = bubble?.previousElementSibling;
    if (!(previous instanceof HTMLElement) || !previous.matches(".message.user")) return false;
    return Boolean(previous.querySelector(
      ".message-attachment-list, .message-attachment-card, .message-file-chip",
    ));
  }

  function clearSearchTimer(loader) {
    const timer = searchTimers.get(loader);
    if (timer) window.clearTimeout(timer);
    searchTimers.delete(loader);
  }

  function ensureActivityLogo(loader, state) {
    if (!(loader instanceof HTMLElement)) return null;
    const variant = ACTIVITY_LOGO_VARIANTS[state];
    if (!variant || !window.customElements?.get("sentiq-activity-logo")) return null;

    let logo = loader.querySelector(":scope > sentiq-activity-logo");
    if (!(logo instanceof HTMLElement)) {
      logo = document.createElement("sentiq-activity-logo");
      logo.className = "sentiq-activity-mark sentiq-logo-activity-mark";
      logo.setAttribute("aria-hidden", "true");
      logo.setAttribute("size", "28px");
      const spinner = loader.querySelector(":scope > .response-inline-spinner");
      spinner?.remove();
      const existingCopy = loader.querySelector(":scope > .semantic-activity-copy, :scope > span:last-child:not(.response-inline-spinner)");
      if (existingCopy) loader.insertBefore(logo, existingCopy);
      else loader.appendChild(logo);
    }

    logo.setAttribute("variant", variant);
    logo.setAttribute("state", state);
    logo.setAttribute("size", "28px");
    logo.classList.toggle("sentiq-logo-thinking", state === "thinking");
    logo.classList.toggle("sentiq-logo-reading-files", state === "reading-files" || state === "preparing-document");
    return logo;
  }

  function applyInlineState(loader, state) {
    if (!(loader instanceof HTMLElement)) return;
    const label = getSemanticActivityLabel(state);
    loader.classList.add("semantic-activity-progress");
    loader.dataset.semanticActivityVersion = SEMANTIC_ACTIVITY_VERSION;
    loader.dataset.semanticActivityState = state;
    setAttribute(loader, "role", "status");
    setAttribute(loader, "aria-live", "polite");
    setAttribute(loader, "aria-atomic", "true");
    setAttribute(loader, "aria-label", label);

    ensureActivityLogo(loader, state);
    loader.querySelector(":scope > .response-inline-spinner")?.remove();

    let copy = loader.querySelector(":scope > .semantic-activity-copy");
    const originalCopy = loader.querySelector(":scope > span:last-child:not(.response-inline-spinner)");
    if (!copy && originalCopy) {
      copy = originalCopy;
      copy.classList.add("semantic-activity-copy");
    }
    setText(copy, label);
  }

  function scheduleSearchComparison(loader) {
    if (searchTimers.has(loader)) return;
    const timer = window.setTimeout(() => {
      searchTimers.delete(loader);
      if (!loader.isConnected || loader.dataset.semanticActivityState !== "searching") return;
      loader.dataset.semanticSearchCompared = "true";
      applyInlineState(loader, getTimedSemanticActivity("searching"));
    }, SEMANTIC_SEARCH_COMPARE_DELAY_MS);
    searchTimers.set(loader, timer);
  }

  function enhanceInline(loader) {
    if (!(loader instanceof HTMLElement)) return;
    const bubble = loader.closest(".message.assistant");
    const copy = loader.querySelector(":scope > span:last-child:not(.response-inline-spinner), :scope > .semantic-activity-copy");
    let state = inferSemanticActivity({
      text: copy?.textContent || loader.textContent,
      loaderKind: bubble?.dataset.loaderKind,
      hasAttachments: hasVisibleAttachmentContext(bubble),
    });
    if (state === "searching" && loader.dataset.semanticSearchCompared === "true") {
      state = "comparing-sources";
    }
    if (state !== "searching" && state !== "comparing-sources") {
      delete loader.dataset.semanticSearchCompared;
    }
    if (loader.dataset.semanticActivityState !== state) clearSearchTimer(loader);
    applyInlineState(loader, state);
    if (state === "searching") scheduleSearchComparison(loader);
  }

  function ensureLegacyProgress(loader) {
    if (!(loader instanceof HTMLElement)) return;
    const state = inferSemanticActivity({
      text: loader.textContent,
      loaderKind: Array.from(loader.classList).find((name) => name.startsWith("loader-")),
      hasAttachments: hasVisibleAttachmentContext(loader.closest(".message.assistant")),
    });
    loader.dataset.semanticActivityVersion = SEMANTIC_ACTIVITY_VERSION;
    loader.dataset.semanticActivityState = state;
    loader.classList.add("semantic-legacy-loader");
    setAttribute(loader, "role", "status");
    setAttribute(loader, "aria-live", "polite");
    setAttribute(loader, "aria-atomic", "true");
    setAttribute(loader, "aria-label", getSemanticActivityLabel(state));
    let row = loader.querySelector(":scope > .semantic-legacy-progress");
    if (!row) {
      row = document.createElement("div");
      row.className = "semantic-legacy-progress";
      row.innerHTML = '<span class="semantic-activity-mark" aria-hidden="true"></span><span class="semantic-activity-copy"></span>';
      loader.appendChild(row);
    }
    setText(row.querySelector(".semantic-activity-copy"), getSemanticActivityLabel(state));
  }

  function surfaceState(surface) {
    if (surface.matches(".image-generation-card")) return "creating-image";
    if (surface.matches(".message-chart-container")) return "generating-chart";
    return "preparing-document";
  }

  function surfaceIsActive(surface) {
    if (surface.classList.contains("is-failed") || surface.classList.contains("is-ready")) return false;
    if (surface.classList.contains("is-loading")) return true;
    if (surface.matches(".image-generation-card")) {
      const image = surface.querySelector(".message-image");
      return Boolean(image && (!image.complete || image.naturalWidth === 0));
    }
    if (surface.matches(".message-chart-container")) {
      return !surface.querySelector("canvas, .js-plotly-plot, .message-chart-image, .message-chart-error");
    }
    return surface.getAttribute("aria-busy") === "true";
  }

  function enhanceSurface(surface) {
    if (!(surface instanceof HTMLElement)) return;
    let progress = surface.querySelector(".semantic-surface-progress");
    if (!surfaceIsActive(surface)) {
      progress?.remove();
      return;
    }
    const state = surfaceState(surface);
    if (!progress) {
      progress = document.createElement("div");
      progress.className = "semantic-surface-progress";
      progress.innerHTML = '<span class="semantic-activity-mark" aria-hidden="true"></span><span class="semantic-activity-copy"></span>';
      if (surface.matches(".image-generation-card")) {
        surface.querySelector(".image-generation-frame")?.appendChild(progress);
      } else {
        const header = surface.querySelector(":scope > .asset-result-header, :scope > .generated-file-header");
        (header || surface.firstElementChild)?.insertAdjacentElement("afterend", progress);
      }
    }
    if (!progress) return;
    progress.dataset.semanticActivityVersion = SEMANTIC_ACTIVITY_VERSION;
    progress.dataset.semanticActivityState = state;
    setAttribute(progress, "role", "status");
    setAttribute(progress, "aria-live", "polite");
    setAttribute(progress, "aria-atomic", "true");
    setAttribute(progress, "aria-label", getSemanticActivityLabel(state));
    setText(progress.querySelector(".semantic-activity-copy"), getSemanticActivityLabel(state));
  }

  function enhance(node) {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(INLINE_SELECTOR)) enhanceInline(node);
    if (node.matches(LEGACY_SELECTOR)) ensureLegacyProgress(node);
    if (node.matches(SURFACE_SELECTOR)) enhanceSurface(node);
    node.querySelectorAll?.(INLINE_SELECTOR).forEach(enhanceInline);
    node.querySelectorAll?.(LEGACY_SELECTOR).forEach(ensureLegacyProgress);
    node.querySelectorAll?.(SURFACE_SELECTOR).forEach(enhanceSurface);
  }

  function flush() {
    frame = 0;
    const nodes = Array.from(pending);
    pending.clear();
    nodes.forEach(enhance);
  }

  function schedule(node) {
    const element = node instanceof HTMLElement ? node : node?.parentElement;
    if (!(element instanceof HTMLElement)) return;
    pending.add(element.closest(".message") || element);
    if (!frame) frame = window.requestAnimationFrame(flush);
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      schedule(record.target);
      record.addedNodes.forEach(schedule);
      record.removedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.matches(INLINE_SELECTOR)) clearSearchTimer(node);
        node.querySelectorAll?.(INLINE_SELECTOR).forEach(clearSearchTimer);
      });
    });
  });

  observer.observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-loader-kind", "class", "aria-busy", "src"],
  });

  enhance(chatMessages);
}

initSemanticActivityProgress();
