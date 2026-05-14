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

  if (configError) {
    console.error("[Auth] Supabase auth configuration is missing.");
  }

  function buildEmailRedirectUrl() {
    if (typeof window === "undefined" || !window.location) return undefined;
    const url = new URL(window.location.href);
    url.searchParams.set(AUTH_RETURN_MODE_PARAM, AUTH_RETURN_LOGIN_MODE);
    url.hash = "";
    return url.toString();
  }

  function buildRecoveryRedirectUrl() {
    if (typeof window === "undefined" || !window.location) return undefined;
    const url = new URL(window.location.href);
    url.searchParams.set(AUTH_RETURN_MODE_PARAM, AUTH_RETURN_RECOVERY_MODE);
    url.hash = "";
    return url.toString();
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
    signUp,
    resetPasswordForEmail,
    updatePassword,
    signOut,
    subscribeAuthChanges,
  };
})();
