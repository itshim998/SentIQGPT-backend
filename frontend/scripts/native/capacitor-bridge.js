// ================================================================
// Capacitor Native Bridge
// ================================================================
(function initializeCapacitorBridge() {
  const root = window;
  const capacitor = root.Capacitor;

  function getPlugin(name) {
    return capacitor?.Plugins?.[name] || null;
  }

  function isNativePlatform() {
    try {
      if (typeof capacitor?.isNativePlatform === "function") return capacitor.isNativePlatform();
      const platform = typeof capacitor?.getPlatform === "function" ? capacitor.getPlatform() : "";
      return platform === "android" || platform === "ios";
    } catch {
      return false;
    }
  }

  const native = {
    isNative: isNativePlatform(),
    platform: typeof capacitor?.getPlatform === "function" ? capacitor.getPlatform() : "web",
    async openExternalUrl(url) {
      const safeUrl = typeof url === "string" ? url.trim() : "";
      if (!safeUrl) return false;
      const Browser = getPlugin("Browser");
      if (native.isNative && Browser?.open) {
        await Browser.open({ url: safeUrl });
        return true;
      }
      root.open(safeUrl, "_blank", "noopener");
      return true;
    },
    async closeBrowser() {
      const Browser = getPlugin("Browser");
      if (!native.isNative || !Browser?.close) return false;
      await Browser.close().catch(() => null);
      return true;
    },
  };

  root.SentIQNative = native;

  document.addEventListener("click", (event) => {
    if (!native.isNative) return;
    const link = event.target instanceof Element
      ? event.target.closest("a[href]")
      : null;
    if (!link || link.hasAttribute("download")) return;
    const href = link.getAttribute("href") || "";
    if (!/^https?:\/\//i.test(href)) return;
    const target = link.getAttribute("target") || "";
    if (target !== "_blank" && !link.rel?.includes("external")) return;
    event.preventDefault();
    native.openExternalUrl(href).catch(() => {
      root.location.href = href;
    });
  });

  const App = getPlugin("App");
  if (!native.isNative || !App?.addListener) return;

  App.addListener("backButton", ({ canGoBack } = {}) => {
    const handled = root.SentIQNativeNavigation?.handleBack?.() === true;
    if (handled) return;
    if (canGoBack && root.history.length > 1) {
      root.history.back();
      return;
    }
    App.exitApp?.();
  }).catch?.(() => null);

  App.addListener("appUrlOpen", async ({ url } = {}) => {
    if (!url) return;
    try {
      await root.SentIQAuth?.handleNativeAuthRedirect?.(url);
    } catch (error) {
      const message = root.SentIQErrors?.getSafeErrorMessage?.(error)
        || "Sign-in could not be completed.";
      document.dispatchEvent(new CustomEvent("sentiq-native-auth-error", {
        detail: { message },
      }));
    }
  }).catch?.(() => null);
})();
