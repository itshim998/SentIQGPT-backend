// ================================================================
// 2. Supabase Auth
// ================================================================
(function () {
  let configError = null;
  try {
    if (!window.supabase) {
      throw new Error("Supabase auth is unavailable.");
    }
    if (!window.SENTIQ_SUPABASE_URL || !window.SENTIQ_SUPABASE_ANON_KEY) {
      throw new Error("Supabase auth configuration is missing.");
    }
  } catch (error) {
    configError = error instanceof Error ? error : new Error("Supabase auth configuration is missing.");
  }

  const configured = !configError;
  const client = configured
    ? window.supabase.createClient(window.SENTIQ_SUPABASE_URL, window.SENTIQ_SUPABASE_ANON_KEY)
    : null;

  let currentSession = null;
  let authSubscription = null;
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
    if (isNativePlatform()) return buildAuthReturnUrl(AUTH_RETURN_LOGIN_MODE);
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
    if (!client) throw configError || new Error("Supabase auth is not configured.");
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

    if (session) currentSession = session;
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
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    currentSession = data?.session || null;
    return currentSession;
  }

  async function getAccessToken() {
    const session = await getSession();
    return session?.access_token || "";
  }

  async function signInWithPassword(email, password) {
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentSession = data?.session || null;
    return data;
  }

  async function signInWithGoogle() {
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const redirectTo = buildOAuthRedirectUrl();
    const useNativeBrowser = isNativePlatform();
    const { data, error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo,
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
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const emailRedirectTo = buildEmailRedirectUrl();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: emailRedirectTo ? { emailRedirectTo } : undefined,
    });
    if (error) throw error;
    currentSession = data?.session || null;
    return data;
  }

  async function resetPasswordForEmail(email) {
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const redirectTo = buildRecoveryRedirectUrl();
    const { data, error } = await client.auth.resetPasswordForEmail(
      email,
      redirectTo ? { redirectTo } : undefined,
    );
    if (error) throw error;
    return data;
  }

  async function updatePassword(password) {
    if (!client) throw configError || new Error("Supabase auth is not configured.");
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw error;
    const session = await getSession().catch(() => currentSession);
    currentSession = session || currentSession;
    return data;
  }

  async function signOut() {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw error;
    currentSession = null;
  }

  function subscribeAuthChanges(callback) {
    if (!client || authSubscription) return;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      currentSession = session || null;
      if (typeof callback === "function") callback(currentSession);
      document.dispatchEvent(new CustomEvent("sentiq-auth-changed", { detail: { session: currentSession } }));
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
