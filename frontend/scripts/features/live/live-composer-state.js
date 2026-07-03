const SAFE_LIVE_COPY = Object.freeze({
  sign_in_required: "Sign in to use Live voice.",
  not_available_on_plan: "Live voice is not available on your current plan.",
  daily_limit_reached: "You’ve used today’s Live voice time.",
  active_session_limit: "Live voice is busy. Try again soon.",
  busy: "Live voice is busy. Try again soon.",
});

export function getLiveUnavailableCopy(reason) {
  return SAFE_LIVE_COPY[reason] || "Live voice is busy. Try again soon.";
}

export function resolveLiveComposerAction({
  enabled = false,
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
  const showLive = Boolean(enabled && pristine);
  const interactive = Boolean(available || reason === "sign_in_required");
  return {
    showLive,
    showSend: !showLive,
    disabled: showLive && !interactive,
    message: getLiveUnavailableCopy(reason),
  };
}
