(function initializeSentIqBootstrapGuard() {
  "use strict";

  const PRODUCT_NAME = "SentIQ Chat";
  const ASSET_LOADING_VERSION = "11.6";
  const LOCAL_MARK_HREF = "assets/sentiq-chat-mark.svg";
  const INTER_VARIABLE_STYLESHEET = "https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap";
  const limitedReasons = new Map();
  let isReady = false;
  let didFail = false;
  let readinessTimer = null;

  function ensureLink(attributes) {
    const selector = attributes.selector;
    let link = selector ? document.head?.querySelector(selector) : null;
    if (!link) {
      link = document.createElement("link");
      document.head?.appendChild(link);
    }
    Object.entries(attributes).forEach(([name, value]) => {
      if (name === "selector" || value === undefined || value === null) return;
      if (link.getAttribute(name) !== String(value)) link.setAttribute(name, String(value));
    });
    return link;
  }

  function optimizeHeadAssets() {
    if (!document.head) return;

    const primaryIcon = ensureLink({
      selector: 'link[rel="icon"]',
      rel: "icon",
      type: "image/svg+xml",
      href: LOCAL_MARK_HREF,
    });
    primaryIcon?.setAttribute("data-asset-loading-version", ASSET_LOADING_VERSION);

    document.head.querySelectorAll('link[rel="shortcut icon"]').forEach((link) => link.remove());
    ensureLink({
      selector: 'link[rel="apple-touch-icon"]',
      rel: "apple-touch-icon",
      href: LOCAL_MARK_HREF,
    })?.setAttribute("data-asset-loading-version", ASSET_LOADING_VERSION);

    const fontStylesheet = document.head.querySelector('link[rel="stylesheet"][href*="fonts.googleapis.com/css2?family=Inter"]');
    if (fontStylesheet) {
      fontStylesheet.href = INTER_VARIABLE_STYLESHEET;
      fontStylesheet.setAttribute("fetchpriority", "high");
      fontStylesheet.setAttribute("data-font-request", "variable-300-700");
      fontStylesheet.setAttribute("data-asset-loading-version", ASSET_LOADING_VERSION);
    }

    ensureLink({
      selector: 'link[rel="modulepreload"][href="scripts/main.js"]',
      rel: "modulepreload",
      href: "scripts/main.js",
      fetchpriority: "high",
      "data-asset-loading-version": ASSET_LOADING_VERSION,
    });

    document.documentElement.dataset.headAssetLoadingVersion = ASSET_LOADING_VERSION;
  }

  optimizeHeadAssets();

  function getBanner() {
    return document.getElementById("compatibility-banner");
  }

  function ensureErrorBanner() {
    let banner = getBanner();
    if (banner) return banner;
    banner = document.createElement("div");
    banner.id = "compatibility-banner";
    banner.className = "compatibility-banner";
    banner.setAttribute("role", "alert");
    banner.setAttribute("aria-live", "assertive");
    banner.innerHTML = '<span id="compatibility-banner-message"></span>';
    document.body?.prepend(banner);
    return banner;
  }

  function canUseStorage(storageName) {
    try {
      const storage = window[storageName];
      if (!storage) return false;
      const key = "__sentiq_storage_probe__";
      storage.setItem(key, "1");
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  const capabilities = Object.freeze({
    fetch: typeof window.fetch === "function",
    abortController: typeof window.AbortController === "function",
    readableStream: typeof window.ReadableStream === "function",
    textDecoder: typeof window.TextDecoder === "function",
    indexedDb: typeof window.indexedDB !== "undefined",
    localStorage: canUseStorage("localStorage"),
    sessionStorage: canUseStorage("sessionStorage"),
    randomUuid: typeof window.crypto?.randomUUID === "function",
    randomValues: typeof window.crypto?.getRandomValues === "function",
    clipboard: typeof navigator.clipboard?.writeText === "function",
  });

  function render() {
    const banner = didFail ? ensureErrorBanner() : getBanner();
    if (!banner) return;
    const message = document.getElementById("compatibility-banner-message");
    banner.classList.toggle("is-error", didFail);
    banner.classList.remove("has-message");

    if (didFail) {
      banner.hidden = false;
      banner.classList.add("has-message");
      if (message) message.textContent = `${PRODUCT_NAME} could not finish starting. A browser, network, or storage setting may be blocking required functionality.`;
      return;
    }

    banner.remove();
  }

  function disablePrimaryActions() {
    document.querySelectorAll(".app-container button, .app-container input, .app-container textarea, .app-container select, [data-ui-action]").forEach((element) => {
      element.disabled = true;
      element.setAttribute("aria-disabled", "true");
    });
  }

  function addLimitedReason(code, message) {
    const key = String(code || "limited");
    if (!limitedReasons.has(key)) {
      limitedReasons.set(key, String(message || "Some features are unavailable in this browser session."));
    }
    render();
  }

  function markReady() {
    if (didFail) return;
    isReady = true;
    window.clearTimeout(readinessTimer);
    render();
  }

  function fail() {
    if (isReady || didFail) return;
    didFail = true;
    window.clearTimeout(readinessTimer);
    disablePrimaryActions();
    render();
  }

  window.SentIQBootstrap = {
    addLimitedReason,
    fail,
    getCapabilities: () => capabilities,
    getStatus: () => ({
      ready: isReady,
      failed: didFail,
      limited: Array.from(limitedReasons.keys()),
    }),
    markReady,
  };

  if (!capabilities.fetch) fail();
  if (!capabilities.indexedDb) {
    addLimitedReason("indexed-db", "Browser storage is unavailable. This session will use temporary in-memory storage.");
  }
  if (!capabilities.localStorage) {
    addLimitedReason("local-storage", "Some browser preferences cannot be saved in this session.");
  }
  if (!capabilities.readableStream || !capabilities.textDecoder) {
    addLimitedReason("streaming", "Live response streaming is unavailable. Responses will load after they finish.");
  }

  document.addEventListener("DOMContentLoaded", () => {
    render();
    if (didFail) disablePrimaryActions();
    readinessTimer = window.setTimeout(fail, 6500);
  });

  window.addEventListener("error", () => fail());
  window.addEventListener("unhandledrejection", () => fail());
})();
