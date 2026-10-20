import "./conversation-ordering-policy.js";
import "./conversation-ordering-hydration-hardening.js";
import "./conversation-special-mode-activity.js";

// ================================================================
// 2. Supabase Auth
// ================================================================
(function () {
  function createMemoryAuthStorage() {
    const store = new Map();
    return {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    };
  }

  function resolveAuthStorage() {
    try {
      const storage = window.localStorage;
      const probeKey = "__sentiq_auth_storage_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return storage;
    } catch {
      return createMemoryAuthStorage();
    }
  }

  let configError = null;
  try {
    if (!window.supabase) {
      throw new Error("Sign-in isn't available. Try again later.");
    }
    if (!window.SENTIQ_SUPABASE_URL || !window.SENTIQ_SUPABASE_ANON_KEY) {
      throw new Error("Sign-in isn't available. Try again later.");
    }
  } catch (error) {
    configError = error instanceof Error ? error : new Error("Sign-in isn't available. Try again later.");
  }

  const configured = !configError;
  const client = configured
    ? window.supabase.createClient(window.SENTIQ_SUPABASE_URL, window.SENTIQ_SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storage: resolveAuthStorage(),
      },
    })
    : null;

  let currentSession = null;
  let authSubscription = null;
  const authChangeCallbacks = new Set();
  const AUTH_RETURN_MODE_PARAM = "auth_mode";
  const AUTH_RETURN_LOGIN_MODE = "signin";
  const AUTH_RETURN_RECOVERY_MODE = "recovery";
  const NATIVE_AUTH_CALLBACK_URL = "com.sentiqlabs.sentiqchat://auth-callback";

  if (configError) {
    console.error("[Auth] Supabase auth configuration is missing.");
  }

  function isNativePlatform() {
    try {
      if (window.SentIQNative?.isNative) return true;
      return typeof window.Capacitor?.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
    } catch {
      return false;
    }
  }

  function isNativeAndroidPlatform() {
    try {
      const platform = window.SentIQNative?.platform
        || (typeof window.Capacitor?.getPlatform === "function" ? window.Capacitor.getPlatform() : "");
      return isNativePlatform() && platform === "android";
    } catch {
      return false;
    }
  }

  function assignCurrentSession(session) {
    currentSession = session || null;
    return currentSession;
  }

  function notifyAuthChanged(source) {
    authChangeCallbacks.forEach((callback) => {
      try {
        const result = callback(currentSession);
        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
      } catch { /* auth refresh callback failures should not block session commit */ }
    });
    document.dispatchEvent(new CustomEvent("sentiq-auth-changed", {
      detail: { session: currentSession, source },
    }));
  }

  function commitAuthSession(session, source) {
    assignCurrentSession(session);
    notifyAuthChanged(source);
    return currentSession;
  }

  async function getSessionFromAuthResult(data) {
    if (data?.session) return data.session;
    return getSession().catch(() => null);
  }

  function buildAuthReturnUrl(mode) {
    if (typeof window === "undefined" || !window.location) return undefined;
    const url = new URL(isNativePlatform() ? NATIVE_AUTH_CALLBACK_URL : window.location.href);
    url.searchParams.set(AUTH_RETURN_MODE_PARAM, mode);
    url.hash = "";
    return url.toString();
  }

  function buildEmailRedirectUrl() {
    return buildAuthReturnUrl(AUTH_RETURN_LOGIN_MODE);
  }

  function buildRecoveryRedirectUrl() {
    return buildAuthReturnUrl(AUTH_RETURN_RECOVERY_MODE);
  }

  function buildOAuthRedirectUrl() {
    if (isNativeAndroidPlatform()) return NATIVE_AUTH_CALLBACK_URL;
    return window.location.origin;
  }

  async function openNativeAuthBrowser(url) {
    if (!url || !isNativePlatform()) return false;
    if (window.SentIQNative?.openExternalUrl) {
      await window.SentIQNative.openExternalUrl(url);
      return true;
    }
    window.location.href = url;
    return true;
  }

  function readAuthCallbackParams(callbackUrl) {
    const url = new URL(callbackUrl);
    const hashParams = new URLSearchParams((url.hash || "").replace(/^#/, ""));
    const getParam = (key) => hashParams.get(key) || url.searchParams.get(key) || "";
    return {
      mode: getParam(AUTH_RETURN_MODE_PARAM),
      type: getParam("type").toLowerCase(),
      code: getParam("code"),
      accessToken: getParam("access_token"),
      refreshToken: getParam("refresh_token"),
      error: getParam("error") || getParam("error_code"),
      errorDescription: getParam("error_description"),
    };
  }

  async function handleNativeAuthRedirect(callbackUrl) {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const params = readAuthCallbackParams(callbackUrl);
    if (params.error) {
      throw new Error(params.errorDescription || params.error);
    }

    let session = null;
    if (params.code && typeof client.auth.exchangeCodeForSession === "function") {
      const { data, error } = await client.auth.exchangeCodeForSession(params.code);
      if (error) throw error;
      session = data?.session || null;
    } else if (params.accessToken && params.refreshToken) {
      const { data, error } = await client.auth.setSession({
        access_token: params.accessToken,
        refresh_token: params.refreshToken,
      });
      if (error) throw error;
      session = data?.session || null;
    } else {
      session = await getSession().catch(() => null);
    }

    if (session) commitAuthSession(session, "native-auth-return");
    await window.SentIQNative?.closeBrowser?.();
    document.dispatchEvent(new CustomEvent("sentiq-native-auth-return", {
      detail: {
        session: currentSession,
        mode: params.mode || AUTH_RETURN_LOGIN_MODE,
        type: params.type,
      },
    }));
    return { session: currentSession, mode: params.mode, type: params.type };
  }

  async function getSession() {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    assignCurrentSession(data?.session || null);
    return currentSession;
  }

  async function getAccessToken() {
    const session = await getSession();
    return session?.access_token || "";
  }

  async function signInWithPassword(email, password) {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const session = await getSessionFromAuthResult(data);
    if (!session) throw new Error("Couldn't complete sign-in. Try again.");
    commitAuthSession(session, "password");
    return { ...data, session };
  }

  async function signInWithGoogle() {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const redirectTo = buildOAuthRedirectUrl();
    const useNativeBrowser = isNativeAndroidPlatform();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
        ...(useNativeBrowser ? { queryParams: { prompt: "select_account" } } : {}),
        ...(useNativeBrowser ? { skipBrowserRedirect: true } : {}),
      },
    });
    if (error) throw error;
    if (useNativeBrowser && data?.url) {
      await openNativeAuthBrowser(data.url);
    }
    return data;
  }

  async function signUp(email, password) {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const emailRedirectTo = buildEmailRedirectUrl();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    });
    if (error) throw error;
    if (data?.session) commitAuthSession(data.session, "signup");
    else assignCurrentSession(null);
    return data;
  }

  async function resetPasswordForEmail(email) {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const redirectTo = buildRecoveryRedirectUrl();
    const { data, error } = await client.auth.resetPasswordForEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    );
    if (error) throw error;
    return data;
  }

  async function updatePassword(password) {
    if (!client) throw configError || new Error("Sign-in isn't available. Try again later.");
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw error;
    const session = await getSession().catch(() => currentSession);
    if (session) commitAuthSession(session, "password-update");
    return data;
  }

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw error;
    commitAuthSession(null, "signout");
  }

  function subscribeAuthChanges(callback) {
    if (typeof callback === "function") authChangeCallbacks.add(callback);
    if (!client || authSubscription) return;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      assignCurrentSession(session || null);
      notifyAuthChanged("supabase");
    });
    authSubscription = data?.subscription || null;
  }

  window.SentIQAuth = {
    configured,
    client,
    AUTH_RETURN_MODE_PARAM,
    AUTH_RETURN_LOGIN_MODE,
    AUTH_RETURN_RECOVERY_MODE,
    getSession,
    getAccessToken,
    signInWithPassword,
    signInWithGoogle,
    signUp,
    resetPasswordForEmail,
    updatePassword,
    signOut,
    subscribeAuthChanges,
    handleNativeAuthRedirect,
  };
})();
