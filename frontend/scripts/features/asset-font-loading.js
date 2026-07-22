/* SentIQ Chat — Pass 11.6 asset and font loading runtime */

import {
  ASSET_FONT_LOADING_VERSION,
  deriveImageLoadingPolicy,
  deriveImageReservation,
  findImageProfile,
} from "./asset-font-loading-state.mjs";

const IMAGE_SELECTOR = "img";
const FRAME_SELECTOR = [
  ".image-generation-frame",
  ".message-image-container",
  ".message-chart-frame",
  ".websurf-v2-featured-media",
  ".websurf-v2-source-body",
  ".web-search-image-tile",
  ".web-search-image-row",
].join(",");
const REMOTE_SOURCE_SELECTOR = [
  ".websurf-v2-favicon",
  ".websurf-v2-presentation-favicon",
  ".websurf-v2-source-explorer-favicon",
  ".websurf-v2-explorer-favicon",
  ".websurf-v2-thumbnail",
  ".websurf-v2-featured-media img",
  ".web-search-image-tile img",
  ".web-search-image-row img",
].join(",");

function initializeAssetFontLoading() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.SentIQAssetFontLoading?.version === ASSET_FONT_LOADING_VERSION) return;

  const root = document.documentElement;
  const chatMessages = document.getElementById("chat-messages");
  const processedImages = new WeakSet();
  const subscribers = new Set();
  const cleanup = [];
  const observers = [];
  let mutationFrame = 0;
  let pendingImages = new Set();
  let destroyed = false;

  function setData(element, name, value) {
    if (!(element instanceof HTMLElement) && element !== root) return;
    const next = String(value);
    if (element.dataset[name] !== next) element.dataset[name] = next;
  }

  function setAttribute(element, name, value) {
    const next = String(value);
    if (element.getAttribute(name) !== next) element.setAttribute(name, next);
  }

  function notify(domain, reason, detail = {}) {
    const payload = Object.freeze({
      version: ASSET_FONT_LOADING_VERSION,
      domain,
      reason,
      ...detail,
    });
    subscribers.forEach((listener) => {
      try { listener(payload); } catch { /* subscriber isolation */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-asset-font-loading-change", { detail: payload }));
  }

  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    cleanup.push(() => target.removeEventListener(type, handler, options));
  }

  function isLatestPrimaryAsset(image) {
    const message = image.closest(".message");
    if (!(message instanceof HTMLElement) || !(chatMessages instanceof HTMLElement)) return false;
    const messages = Array.from(chatMessages.querySelectorAll(":scope > .message"));
    const latest = messages.at(-1);
    if (message !== latest) return false;
    return image.matches(".message-image, .message-chart-image");
  }

  function isInVisualViewport(image) {
    if (image.closest("[hidden], details:not([open])")) return false;
    const rect = image.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight;
    return rect.width > 0
      && rect.height > 0
      && rect.bottom > 0
      && rect.right > 0
      && rect.top < viewportHeight
      && rect.left < viewportWidth;
  }

  function resolveProfile(image) {
    return findImageProfile((selector) => {
      try { return image.matches(selector); } catch { return false; }
    });
  }

  function resolveFrame(image) {
    const frame = image.closest(FRAME_SELECTOR);
    return frame instanceof HTMLElement ? frame : image.parentElement;
  }

  function setReservedGeometry(image, profile, reason) {
    const existingWidth = Number(image.getAttribute("width"));
    const existingHeight = Number(image.getAttribute("height"));
    const reservation = deriveImageReservation({
      width: existingWidth,
      height: existingHeight,
      naturalWidth: image.complete ? image.naturalWidth : 0,
      naturalHeight: image.complete ? image.naturalHeight : 0,
      profileWidth: profile.width,
      profileHeight: profile.height,
      reserve: profile.reserve,
    });

    if (!existingWidth && !existingHeight && reservation.width && reservation.height) {
      setAttribute(image, "width", reservation.width);
      setAttribute(image, "height", reservation.height);
    }
    setData(image, "assetReserve", reservation.reserve);
    if (reservation.cssRatio) image.style.setProperty("--sentiq-asset-aspect-ratio", reservation.cssRatio);
    if (profile.fit) image.style.setProperty("--sentiq-asset-object-fit", profile.fit);

    const frame = resolveFrame(image);
    if (frame instanceof HTMLElement) {
      setData(frame, "assetFrameVersion", ASSET_FONT_LOADING_VERSION);
      setData(frame, "assetReserve", reservation.reserve);
      if (reservation.cssRatio) frame.style.setProperty("--sentiq-asset-aspect-ratio", reservation.cssRatio);
    }
    notify("image", reason, {
      reserve: reservation.reserve,
      width: reservation.width,
      height: reservation.height,
      source: reservation.source,
    });
  }

  function syncLoadedImage(image, profile, reason = "load") {
    if (!(image instanceof HTMLImageElement)) return;
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      if (!image.hasAttribute("width") || !image.hasAttribute("height")) {
        setAttribute(image, "width", image.naturalWidth);
        setAttribute(image, "height", image.naturalHeight);
      }
      setData(image, "assetDecodeState", "decoded");
      setReservedGeometry(image, profile, reason);
      window.SentIQFrameDiscipline?.scheduleScrollAnchor?.(`asset-loading:${reason}`);
    }
  }

  function applyImagePolicy(image, reason = "scan") {
    if (!(image instanceof HTMLImageElement)) return;
    const profile = resolveProfile(image);
    const longConversationManaged = Boolean(
      image.closest("#chat-messages")
      && window.SentIQLongConversation?.version,
    );
    const critical = image.dataset.assetPriority === "high" || image.hasAttribute("data-eager-asset");
    const latest = isLatestPrimaryAsset(image);
    const visible = isInVisualViewport(image);
    const policy = deriveImageLoadingPolicy({
      critical,
      latest,
      visible,
      longConversationManaged,
    });

    image.decoding = policy.decoding;
    if (!policy.managedByLongConversation || !image.getAttribute("loading")) image.loading = policy.loading;
    setAttribute(image, "fetchpriority", policy.fetchPriority);
    if (image.matches(REMOTE_SOURCE_SELECTOR)) image.referrerPolicy = "no-referrer";
    setData(image, "assetLoadingVersion", ASSET_FONT_LOADING_VERSION);
    setData(image, "assetLoadingState", image.complete && image.naturalWidth > 0 ? "loaded" : policy.loading);
    setReservedGeometry(image, profile, reason);

    if (!processedImages.has(image)) {
      processedImages.add(image);
      listen(image, "load", () => syncLoadedImage(image, profile, "load"), { once: true, passive: true });
      listen(image, "error", () => {
        setData(image, "assetLoadingState", "error");
        notify("image", "error", { reserve: profile.reserve });
      }, { once: true, passive: true });
    }
    syncLoadedImage(image, profile, "complete");
  }

  function collectImages(node, reason = "mutation") {
    if (!(node instanceof Node)) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!(element instanceof Element)) return;
    if (element.matches(IMAGE_SELECTOR)) pendingImages.add(element);
    element.querySelectorAll?.(IMAGE_SELECTOR).forEach((image) => pendingImages.add(image));
    window.cancelAnimationFrame(mutationFrame);
    mutationFrame = window.requestAnimationFrame(() => {
      mutationFrame = 0;
      const images = Array.from(pendingImages);
      pendingImages = new Set();
      images.forEach((image) => applyImagePolicy(image, reason));
    });
  }

  function syncFontState(reason = "font-check") {
    const fontSet = document.fonts;
    if (!fontSet?.check) {
      setData(root, "fontLoadState", "unsupported");
      return;
    }
    const ready = fontSet.check('400 1em "Inter"');
    setData(root, "fontLoadState", ready ? "ready" : "loading");
    setData(root, "assetFontLoadingVersion", ASSET_FONT_LOADING_VERSION);
    notify("font", reason, { ready, status: fontSet.status || "unknown" });
  }

  if (document.fonts) {
    syncFontState("initial");
    document.fonts.ready.then(() => {
      if (!destroyed) syncFontState("ready");
    }).catch(() => {
      setData(root, "fontLoadState", "error");
      notify("font", "error", { ready: false });
    });
    listen(document.fonts, "loadingdone", () => syncFontState("loadingdone"));
    listen(document.fonts, "loadingerror", () => {
      setData(root, "fontLoadState", "error");
      notify("font", "loadingerror", { ready: false });
    });
  } else {
    setData(root, "fontLoadState", "unsupported");
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      if (record.type === "attributes") collectImages(record.target, "attribute");
      record.addedNodes.forEach((node) => collectImages(node, "mutation"));
    });
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "width", "height", "class", "data-asset-priority"],
  });
  observers.push(observer);

  root.dataset.assetFontLoadingVersion = ASSET_FONT_LOADING_VERSION;
  document.querySelectorAll(IMAGE_SELECTOR).forEach((image) => applyImagePolicy(image, "initial"));

  window.SentIQAssetFontLoading = Object.freeze({
    version: ASSET_FONT_LOADING_VERSION,
    refresh(scope = document) {
      scope.querySelectorAll?.(IMAGE_SELECTOR).forEach((image) => applyImagePolicy(image, "refresh"));
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    getState() {
      return Object.freeze({
        fontState: root.dataset.fontLoadState || "unknown",
        processedImages: document.querySelectorAll(`img[data-asset-loading-version="${ASSET_FONT_LOADING_VERSION}"]`).length,
      });
    },
    destroy() {
      destroyed = true;
      window.cancelAnimationFrame(mutationFrame);
      observers.forEach((item) => item.disconnect());
      cleanup.splice(0).forEach((dispose) => dispose());
      subscribers.clear();
      pendingImages.clear();
    },
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeAssetFontLoading, { once: true });
} else {
  initializeAssetFontLoading();
}
