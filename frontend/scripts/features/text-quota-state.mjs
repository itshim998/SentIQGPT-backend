export const UNIFIED_TEXT_POLICY_VERSION = "unified-text-tokens-v2";
export const FAST_MINIMUM_REQUEST_TOKENS = 256;
export const INTUITIVE_ORDINARY_MINIMUM_TOKENS = 1_500;
export const INTUITIVE_HEAVY_MINIMUM_TOKENS = 2_000;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function timestampOrNull(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function normalizeTextAllowance(value) {
  if (!value || value.policy_version !== UNIFIED_TEXT_POLICY_VERSION) return null;
  const limitTokens = finiteNonNegative(value.limit_tokens, 50_000);
  const remainingTokens = Math.min(limitTokens, finiteNonNegative(value.remaining_tokens));
  const fastReserveTokens = finiteNonNegative(value.fast_reserve_tokens, 10_000);
  const fastAvailableTokens = Math.min(
    remainingTokens,
    finiteNonNegative(value.fast_available_tokens, remainingTokens),
  );
  const intuitiveAvailableTokens = Math.min(
    Math.max(0, remainingTokens - fastReserveTokens),
    finiteNonNegative(value.intuitive_available_tokens),
  );
  return Object.freeze({
    policyVersion: UNIFIED_TEXT_POLICY_VERSION,
    planCode: typeof value.plan_code === "string" ? value.plan_code : "free",
    limitTokens,
    windowSeconds: finiteNonNegative(value.window_seconds, 18_000),
    usedTokens: finiteNonNegative(value.used_tokens),
    reservedTokens: finiteNonNegative(value.reserved_tokens),
    remainingTokens,
    fastReserveTokens,
    fastAvailableTokens,
    intuitiveAvailableTokens,
    intuitiveAllowed: value.intuitive_allowed === true,
    requiredMode: value.required_mode === "fast" ? "fast" : null,
    exhausted: value.exhausted === true || remainingTokens <= 0,
    nextRecoveryAt: timestampOrNull(value.next_recovery_at),
    fullResetAt: timestampOrNull(value.full_reset_at),
  });
}

export function formatCompactQuotaTokens(value) {
  const amount = finiteNonNegative(value);
  if (amount < 1_000) return Math.round(amount).toLocaleString("en-IN");
  const unit = amount >= 1_000_000
    ? { threshold: 1_000_000, suffix: "M" }
    : { threshold: 1_000, suffix: "K" };
  const compact = amount / unit.threshold;
  const digits = compact < 100 && compact % 1 !== 0 ? 1 : 0;
  return `${compact.toFixed(digits).replace(/\.0$/, "")}${unit.suffix}`;
}

export function formatRecoveryCountdown(timestamp, now = Date.now()) {
  const target = typeof timestamp === "number" ? timestamp : Date.parse(timestamp || "");
  if (!Number.isFinite(target)) return "soon";
  const remainingMs = Math.max(0, target - now);
  if (remainingMs < 60_000) return "under a minute";
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

export function resolveTextQuotaView({
  quotaUiEnabled,
  allowance,
  executionMode = "fast",
  heavyContext = false,
  now = Date.now(),
} = {}) {
  const normalized = normalizeTextAllowance(allowance);
  if (!quotaUiEnabled || !normalized) {
    return Object.freeze({
      visible: false,
      state: "hidden",
      blockComposer: false,
      shouldSwitchToFast: false,
      intuitiveSelectable: true,
      title: "",
      detail: "",
      countdown: "",
      allowance: null,
    });
  }

  const intuitiveMinimum = heavyContext
    ? INTUITIVE_HEAVY_MINIMUM_TOKENS
    : INTUITIVE_ORDINARY_MINIMUM_TOKENS;
  const fastCanServe = normalized.fastAvailableTokens >= FAST_MINIMUM_REQUEST_TOKENS;
  const intuitiveCanServe = normalized.intuitiveAllowed
    && normalized.intuitiveAvailableTokens >= intuitiveMinimum;
  const recoveryAt = normalized.nextRecoveryAt || normalized.fullResetAt;
  const countdown = recoveryAt ? formatRecoveryCountdown(recoveryAt, now) : "soon";

  if (normalized.exhausted || !fastCanServe) {
    return Object.freeze({
      visible: true,
      state: "exhausted",
      blockComposer: true,
      shouldSwitchToFast: executionMode === "intuitive",
      intuitiveSelectable: false,
      title: "Text limit reached",
      detail: `More tokens in ${countdown}`,
      countdown,
      allowance: normalized,
    });
  }

  if (!intuitiveCanServe) {
    return Object.freeze({
      visible: true,
      state: "fast-only",
      blockComposer: false,
      shouldSwitchToFast: executionMode === "intuitive",
      intuitiveSelectable: false,
      title: `${formatCompactQuotaTokens(normalized.remainingTokens)} text tokens left`,
      detail: `Fast only · more tokens in ${countdown}`,
      countdown,
      allowance: normalized,
    });
  }

  return Object.freeze({
    visible: true,
    state: "available",
    blockComposer: false,
    shouldSwitchToFast: false,
    intuitiveSelectable: true,
    title: `${formatCompactQuotaTokens(normalized.remainingTokens)} text tokens left`,
    detail: `${formatCompactQuotaTokens(normalized.intuitiveAvailableTokens)} available for Intuitive`,
    countdown,
    allowance: normalized,
  });
}

export function isRetryableIntuitiveQuotaError(error) {
  const code = typeof error?.code === "string"
    ? error.code
    : typeof error?.details?.code === "string"
      ? error.details.code
      : "";
  return code === "intuitive_fast_required"
    || code === "unified_text_insufficient_for_request";
}

export function canRetryIntuitiveRequestInFast({ error, originalMode, quotaUiEnabled, allowance, alreadyRetried }) {
  if (alreadyRetried || originalMode !== "intuitive" || !quotaUiEnabled) return false;
  if (!isRetryableIntuitiveQuotaError(error)) return false;
  const normalized = normalizeTextAllowance(allowance || error?.details);
  return Boolean(normalized && normalized.fastAvailableTokens >= FAST_MINIMUM_REQUEST_TOKENS && !normalized.exhausted);
}
