/* SentIQ Liquid Glass V4 — Phase 7.3 asset result presentation */

import { enhanceChartResult } from "./chart-result-presentation.js";
import { enhanceGeneratedFileResult } from "./generated-file-result-presentation.js";
import { enhanceImageResult } from "./image-result-presentation.js";
import { ASSET_RESULT_SELECTOR, ASSET_RESULT_VERSION, isAssetFailureMessage, findMessageRetryControl } from "./asset-result-state.js";

function initAssetResultPresentation() {
  const chatMessages = document.getElementById("chat-messages");
  if (!(chatMessages instanceof HTMLElement)) return;
  const pendingSurfaces = new Set();
  const pendingMessages = new Set();
  let frame = 0;

  function enhanceFailureMessage(message) {
    if (!(message instanceof HTMLElement) || message.querySelector(ASSET_RESULT_SELECTOR)) return;
    const content = message.querySelector(":scope > .message-content");
    if (!content || !isAssetFailureMessage(message)) return;
    message.dataset.assetFailureVersion = ASSET_RESULT_VERSION;
    content.classList.add("asset-request-failure");
    if (content.getAttribute("role") !== "alert") content.setAttribute("role", "alert");
    if (content.querySelector(":scope > .asset-result-failure-actions")) return;
    const retryControl = findMessageRetryControl(content);
    if (!retryControl) return;
    const actions = document.createElement("div");
    actions.className = "asset-result-failure-actions";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "asset-result-retry";
    retry.textContent = "Retry generation";
    retry.addEventListener("click", () => retryControl.click());
    actions.appendChild(retry);
    content.appendChild(actions);
  }

  function enhanceSurface(surface) {
    if (!(surface instanceof HTMLElement) || !surface.isConnected) return;
    if (surface.matches(".image-generation-card")) enhanceImageResult(surface);
    else if (surface.matches(".message-chart-container")) enhanceChartResult(surface);
    else if (surface.matches(".generated-file-panel")) enhanceGeneratedFileResult(surface);
    const message = surface.closest(".message");
    if (message) pendingMessages.add(message);
  }

  function flush() {
    frame = 0;
    const surfaces = Array.from(pendingSurfaces);
    const messages = Array.from(pendingMessages);
    pendingSurfaces.clear();
    pendingMessages.clear();
    surfaces.forEach(enhanceSurface);
    messages.forEach(enhanceFailureMessage);
  }

  function requestFlush() {
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function scheduleSurface(surface) {
    if (!(surface instanceof HTMLElement)) return;
    pendingSurfaces.add(surface);
    requestFlush();
  }

  function scheduleMessage(message) {
    if (!(message instanceof HTMLElement)) return;
    pendingMessages.add(message);
    requestFlush();
  }

  function collect(node) {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    if (element.matches(ASSET_RESULT_SELECTOR)) scheduleSurface(element);
    scheduleSurface(element.closest(ASSET_RESULT_SELECTOR));
    element.querySelectorAll?.(ASSET_RESULT_SELECTOR).forEach(scheduleSurface);
    scheduleMessage(element.matches(".message") ? element : element.closest(".message"));
  }

  new MutationObserver((records) => records.forEach((record) => {
    if (
      record.type === "attributes"
      && record.target instanceof Element
      && record.target.closest(".asset-result-actions, .asset-image-overlay, .asset-result-failure-actions")
    ) return;
    collect(record.target);
    record.addedNodes.forEach(collect);
  })).observe(chatMessages, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "disabled"],
  });

  chatMessages.querySelectorAll(ASSET_RESULT_SELECTOR).forEach(scheduleSurface);
  chatMessages.querySelectorAll(".message").forEach(scheduleMessage);
}

if (typeof document !== "undefined") initAssetResultPresentation();
