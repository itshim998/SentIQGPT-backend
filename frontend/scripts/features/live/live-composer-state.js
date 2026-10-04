const SAFE_LIVE_COPY = Object.freeze({
  sign_in_required: "Sign in to use Live voice.",
  not_available: "Live voice is not available right now.",
  not_available_on_plan: "Live voice is not available on your current plan.",
  daily_limit_reached: "You’ve used today’s Live voice time.",
  active_session_limit: "You already have an active Live voice session. Please close it first.",
  browser_unsupported: "Live voice is not supported in this browser.",
  global_capacity: "Live voice is temporarily at capacity. Try again shortly.",
  per_key_capacity: "Live voice is temporarily at capacity. Try again shortly.",
  provider_capacity: "Live voice is temporarily rate limited. Try again shortly.",
  provider_rate_limited: "Live voice is temporarily rate limited. Try again shortly.",
  provider_unavailable: "Live voice provider is currently unavailable. Try again shortly.",
  provider_auth: "Live voice service is temporarily misconfigured.",
  provider_configuration: "Live voice service is temporarily misconfigured.",
  network_error: "Live voice is temporarily unreachable. Check your connection.",
  internal_error: "Live voice is temporarily unavailable due to a server error.",
  busy: "Live voice is busy. Try again soon.",
});

export function getLiveUnavailableCopy(reason) {
  return SAFE_LIVE_COPY[reason] || "Live voice is busy. Try again soon.";
}

export function resolveLiveComposerAction({
  available = false,
  reason = "busy",
  inputValue = "",
  hasAttachments = false,
  hasSelectionContext = false,
  specialModeActive = false,
  responseLocked = false,
  requiresName = false,
} = {}) {
  const pristine = (
    !String(inputValue || "").trim()
    && !hasAttachments
    && !hasSelectionContext
    && !specialModeActive
    && !responseLocked
    && !requiresName
  );
  // The Live affordance owns the empty-composer state. Availability changes
  // its interaction/copy, not whether Send replaces it.
  const showLive = pristine;
  const interactive = Boolean(available || reason === "sign_in_required");
  return {
    showLive,
    showSend: !showLive,
    disabled: showLive && !interactive,
    message: getLiveUnavailableCopy(reason),
  };
}
