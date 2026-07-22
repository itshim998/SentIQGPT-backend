/* SentIQ Liquid Glass V4 — Phase 7.3 image results */

import { ASSET_RESULT_VERSION, findMessageRetryControl } from "./asset-result-state.js";
import { createUiIcon } from "./ui-icon-sprite.js";

function ensureOverlay(card, frame, image) {
  let overlay = frame.querySelector(":scope > .asset-image-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "asset-image-overlay";
    overlay.setAttribute("role", "toolbar");
    overlay.setAttribute("aria-label", "Image controls");
    frame.appendChild(overlay);
  }

  let zoom = overlay.querySelector(".asset-image-zoom");
  if (!zoom) {
    zoom = document.createElement("button");
    zoom.type = "button";
    zoom.className = "asset-overlay-action asset-image-zoom";
    zoom.title = "Open image viewer";
    zoom.setAttribute("aria-label", "Open image viewer");
    const icon = createUiIcon("zoom-in", { width: 18, height: 18 });
    if (icon) zoom.appendChild(icon);
    zoom.addEventListener("click", () => image?.click());
    overlay.appendChild(zoom);
  }

  const download = frame.querySelector(":scope > .image-frame-download-btn");
  if (download && download.parentElement !== overlay) overlay.appendChild(download);
  if (download) {
    download.classList.add("asset-overlay-action");
    if (!download.getAttribute("aria-label")) download.setAttribute("aria-label", "Download image");
  }
}

function ensureFailure(card, frame, image) {
  const error = frame.querySelector(".image-load-error");
  let actions = frame.querySelector(":scope > .asset-result-failure-actions");
  if (!error) {
    actions?.remove();
    card.classList.remove("is-failed");
    return;
  }
  card.classList.add("is-failed");
  card.classList.remove("is-loading", "is-ready");
  frame.setAttribute("aria-busy", "false");
  error.setAttribute("role", "alert");
  if (actions) return;

  actions = document.createElement("div");
  actions.className = "asset-result-failure-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "asset-result-retry";
  retry.textContent = "Retry image";
  retry.addEventListener("click", () => {
    const source = card.dataset.assetImageSource || image?.currentSrc || image?.src || "";
    const messageRetry = findMessageRetryControl(card);
    if (!source && messageRetry) {
      messageRetry.click();
      return;
    }
    if (!source || !image) return;
    retry.disabled = true;
    error.remove();
    actions.remove();
    image.style.display = "";
    image.classList.remove("loaded");
    frame.classList.remove("loaded");
    frame.querySelector(".image-generation-pending-layer")?.style.removeProperty("display");
    image.src = "";
    requestAnimationFrame(() => { image.src = source; });
  });
  actions.appendChild(retry);
  frame.appendChild(actions);
}

export function enhanceImageResult(card) {
  if (!(card instanceof HTMLElement)) return;
  const frame = card.querySelector(":scope > .image-generation-frame");
  const image = frame?.querySelector(".message-image");
  if (!frame || !image) return;

  card.dataset.assetResultVersion = ASSET_RESULT_VERSION;
  card.dataset.assetResultKind = "image";
  card.dataset.assetImageSource ||= image.currentSrc || image.src || "";
  card.setAttribute("role", "figure");
  card.setAttribute("aria-label", "Generated image result");
  frame.classList.add("asset-media-frame");
  frame.setAttribute("aria-busy", frame.classList.contains("loaded") ? "false" : "true");
  frame.querySelector(".image-generation-pending-layer")?.setAttribute("aria-hidden", "true");

  ensureOverlay(card, frame, image);
  ensureFailure(card, frame, image);

  const sync = () => {
    const ready = image.complete && image.naturalWidth > 0;
    card.classList.toggle("is-ready", ready);
    card.classList.toggle("is-loading", !ready && !card.classList.contains("is-failed"));
    frame.setAttribute("aria-busy", ready ? "false" : "true");
  };
  if (image.dataset.assetResultBound !== ASSET_RESULT_VERSION) {
    image.dataset.assetResultBound = ASSET_RESULT_VERSION;
    image.addEventListener("load", sync);
    image.addEventListener("error", () => requestAnimationFrame(() => ensureFailure(card, frame, image)));
  }
  sync();
}
