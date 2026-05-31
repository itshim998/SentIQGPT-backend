(function initializeSentIqBootstrapGuard() {
  "use strict";

  const limitedReasons = new Map();
  let isReady = false;
  let didFail = false;
  let readinessTimer = null;

  function getBanner() {
    return document.getElementById("compatibility-banner");
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
    const banner = getBanner();
    if (!banner) return;
    const message = document.getElementById("compatibility-banner-message");
    banner.classList.toggle("is-error", didFail);
    banner.classList.toggle("is-limited", !didFail && limitedReasons.size > 0);

    if (didFail) {
      banner.hidden = false;
      message.textContent = "SentIQGPT could not finish starting. A browser, network, or storage setting may be blocking required functionality.";
      return;
    }

    if (!isReady) {
      banner.hidden = false;
      message.textContent = "Starting SentIQGPT...";
      return;
    }

    if (limitedReasons.size) {
      banner.hidden = false;
      message.textContent = Array.from(limitedReasons.values()).join(" ");
      return;
    }

    banner.hidden = true;
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
