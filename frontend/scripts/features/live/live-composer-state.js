const SAFE_LIVE_COPY = Object.freeze({
  sign_in_required: "Sign in to use Live voice.",
  not_available: "Live voice is unavailable.",
  not_available_on_plan: "Not included in your plan.",
  daily_limit_reached: "Daily Live voice time used.",
  active_session_limit: "Live voice is already open in another session. Close it first.",
  browser_unsupported: "Not supported in this browser.",
  global_capacity: "Live voice is busy. Try again soon.",
  per_key_capacity: "Live voice is busy. Try again soon.",
  provider_capacity: "Wait a moment and try again.",
  provider_rate_limited: "Wait a moment and try again.",
  provider_unavailable: "Live voice is unavailable. Try again soon.",
  provider_auth: "Live voice is unavailable.",
  provider_configuration: "Live voice is unavailable.",
  network_error: "Can't reach Live voice. Check your connection.",
  internal_error: "Live voice is unavailable. Try again later.",
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
