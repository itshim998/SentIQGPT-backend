/* SentIQ Liquid Glass V4 — Phase 9.3 capability-aware actions model */

export const CAPABILITY_MODEL_VERSION = "9.3";

export const CAPABILITY_KEYS = Object.freeze([
  "image-generation",
  "deep-research",
  "live",
  "upload",
]);

export const DEFAULT_CAPABILITY_FACTS = Object.freeze({
  authKnown: false,
  authenticated: false,
  online: true,
  planKnown: false,
  planError: false,
  planCode: "",
  planName: "",
  imageBillingQuota: null,
  imageQuotaKnown: false,
  imageQuotaError: false,
  imageQuota: null,
  deepResearchBillingQuota: null,
  deepResearchQuotaKnown: false,
  deepResearchQuotaError: false,
  deepResearchQuota: null,
  liveKnown: false,
  liveError: false,
  liveStatus: null,
  uploadSupported: true,
  uploadInputReady: true,
  uploadApiReady: true,
  uploadingCount: 0,
});

const STATE_PRIORITY = Object.freeze([
  "offline",
  "checking",
  "sign-in-required",
  "plan-restricted",
  "limit-reached",
  "cooldown",
  "busy",
  "unavailable",
  "available",
]);

function asFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asCount(value, fallback = null) {
  const number = asFiniteNumber(value, fallback);
  return number === null ? null : Math.max(0, Math.floor(number));
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value, fallback = null) {
  return typeof value === "boolean" ? value : fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function normalizeQuota(input = null) {
  if (!input || typeof input !== "object") return null;
  const source = input.quota && typeof input.quota === "object" ? input.quota : input;
  const remaining = asCount(firstDefined(source.remaining, source.remaining_count, source.left));
  const limit = asCount(firstDefined(source.limit, source.max, source.total));
  const used = asCount(firstDefined(source.used, source.consumed));
  const reserved = asCount(firstDefined(source.reserved, source.pending), 0);
  const available = asBoolean(firstDefined(source.available, source.enabled));
  const cooldownActive = Boolean(firstDefined(source.cooldownActive, source.cooldown_active, source.type === "cooldown"));
  const retryAfterMs = asCount(firstDefined(source.retryAfterMs, source.retry_after_ms, source.resetMs));
  const resetAt = asText(firstDefined(source.reset_at, source.resetAt));
  const reason = asText(firstDefined(source.reason, source.code, source.type));
  const upgradeCta = firstDefined(source.upgrade_cta, source.upgradeCta);
  const planCode = asText(firstDefined(source.plan_code, source.planCode));
  const inferredRemaining = remaining !== null
    ? remaining
    : (limit !== null && used !== null ? Math.max(0, limit - used - (reserved || 0)) : null);
  return Object.freeze({
    available,
    remaining: inferredRemaining,
    limit,
    used,
    reserved,
    cooldownActive,
    retryAfterMs,
    resetAt,
    reason,
    planCode,
    upgradeCta: typeof upgradeCta === "boolean" ? upgradeCta : Boolean(upgradeCta),
  });
}

function normalizeLiveStatus(input = null) {
  if (!input || typeof input !== "object") return null;
  return Object.freeze({
    enabled: asBoolean(input.enabled),
    available: asBoolean(input.available),
    reason: asText(input.reason),
    remainingSecondsToday: asCount(input.remainingSecondsToday, 0),
    remainingSessionsToday: asCount(input.remainingSessionsToday, 0),
    maxSessionSeconds: asCount(input.maxSessionSeconds, 0),
    activeSession: Boolean(input.activeSession),
  });
}

export function normalizeCapabilityFacts(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return Object.freeze({
    authKnown: Boolean(source.authKnown),
    authenticated: Boolean(source.authenticated),
    online: source.online !== false,
    planKnown: Boolean(source.planKnown),
    planError: Boolean(source.planError),
    planCode: asText(source.planCode).toLowerCase(),
    planName: asText(source.planName),
    imageBillingQuota: normalizeQuota(source.imageBillingQuota),
    imageQuotaKnown: Boolean(source.imageQuotaKnown),
    imageQuotaError: Boolean(source.imageQuotaError),
    imageQuota: normalizeQuota(source.imageQuota),
    deepResearchBillingQuota: normalizeQuota(source.deepResearchBillingQuota),
    deepResearchQuotaKnown: Boolean(source.deepResearchQuotaKnown),
    deepResearchQuotaError: Boolean(source.deepResearchQuotaError),
    deepResearchQuota: normalizeQuota(source.deepResearchQuota),
    liveKnown: Boolean(source.liveKnown),
    liveError: Boolean(source.liveError),
    liveStatus: normalizeLiveStatus(source.liveStatus),
    uploadSupported: source.uploadSupported !== false,
    uploadInputReady: source.uploadInputReady !== false,
    uploadApiReady: source.uploadApiReady !== false,
    uploadingCount: asCount(source.uploadingCount, 0),
  });
}

function record(key, state, reason, options = {}) {
  return Object.freeze({
    key,
    label: options.label || key,
    state,
    available: state === "available",
    reason: String(reason || "").trim(),
    cta: options.cta || null,
    remaining: options.remaining ?? null,
    limit: options.limit ?? null,
    resetAt: options.resetAt || "",
    retryAfterMs: options.retryAfterMs ?? null,
    planCode: options.planCode || "",
    planName: options.planName || "",
    degraded: Boolean(options.degraded),
  });
}

function planOptions(facts, quota = null) {
  return {
    planCode: quota?.planCode || facts.planCode,
    planName: facts.planName,
  };
}

function upgradeCtaFor(facts, quota = null) {
  if (quota?.upgradeCta) return "upgrade";
  return facts.planCode && facts.planCode !== "pro" ? "upgrade" : null;
}

function hasQuotaSignal(quota) {
  return Boolean(quota && (
    quota.available !== null
    || quota.remaining !== null
    || quota.limit !== null
    || quota.reason
  ));
}

function strictQuota(...candidates) {
  const quotas = candidates.filter(hasQuotaSignal);
  if (!quotas.length) return null;
  const unavailable = quotas.find((quota) => quota.available === false || quota.limit === 0);
  if (unavailable) return unavailable;
  const exhausted = quotas.find((quota) => quota.limit !== null && quota.limit > 0 && quota.remaining === 0);
  if (exhausted) return exhausted;
  const cooling = quotas.find((quota) => quota.cooldownActive);
  if (cooling) return cooling;
  return quotas.find((quota) => quota.remaining !== null || quota.limit !== null || quota.available !== null) || quotas[0];
}

function deriveImageCapability(facts) {
  const key = "image-generation";
  const label = "Image generation";
  if (!facts.online) return record(key, "offline", "Reconnect to the internet to generate images.", { label });
  if (!facts.authKnown) return record(key, "checking", "Checking sign-in status…", { label });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to generate and save images.", { label, cta: "sign-in" });
  if (!facts.planKnown) return record(key, "checking", "Checking image availability for your plan…", { label });
  // The process-level image quota does not prove plan entitlement. If billing
  // cannot be resolved, keep the control blocked rather than claiming that an
  // IP-level slot means image generation is actually available.
  if (facts.planError || !hasQuotaSignal(facts.imageBillingQuota)) {
    return record(key, "unavailable", "Image availability could not be checked right now. Try refreshing in a moment.", { label });
  }

  const quota = strictQuota(facts.imageBillingQuota, facts.imageQuotaKnown ? facts.imageQuota : null);
  const options = { label, ...planOptions(facts, quota) };
  if (quota?.available === false || quota?.limit === 0) {
    return record(key, "plan-restricted", "Image generation is not available on your current plan.", {
      ...options,
      cta: "upgrade",
      remaining: quota.remaining,
      limit: quota.limit,
      resetAt: quota.resetAt,
    });
  }
  if (quota?.remaining === 0 && (quota.limit || 0) > 0) {
    return record(key, "limit-reached", "You have used all available image credits for this allowance window.", {
      ...options,
      cta: upgradeCtaFor(facts, quota),
      remaining: 0,
      limit: quota.limit,
      resetAt: quota.resetAt,
    });
  }
  if (quota?.cooldownActive) {
    return record(key, "cooldown", "Image generation is cooling down briefly. Try again in a few seconds.", {
      ...options,
      remaining: quota.remaining,
      limit: quota.limit,
      retryAfterMs: quota.retryAfterMs,
    });
  }
  return record(key, "available", quota?.remaining !== null && quota?.limit !== null
    ? `${quota.remaining} of ${quota.limit} image credits remain.`
    : "Image generation is available.", {
    ...options,
    remaining: quota?.remaining ?? null,
    limit: quota?.limit ?? null,
    resetAt: quota?.resetAt || "",
    degraded: facts.imageQuotaKnown && !facts.imageQuota,
  });
}

function deriveDeepResearchCapability(facts) {
  const key = "deep-research";
  const label = "Deep Research";
  if (!facts.online) return record(key, "offline", "Reconnect to the internet to start Deep Research.", { label });
  if (!facts.authKnown) return record(key, "checking", "Checking sign-in status…", { label });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to start Deep Research and keep its report.", { label, cta: "sign-in" });
  if (!facts.planKnown) return record(key, "checking", "Checking Deep Research availability for your plan…", { label });
  const researchQuotaAvailable = hasQuotaSignal(facts.deepResearchBillingQuota)
    || (facts.deepResearchQuotaKnown && hasQuotaSignal(facts.deepResearchQuota));
  if (!researchQuotaAvailable || (facts.planError && (!facts.deepResearchQuotaKnown || facts.deepResearchQuotaError))) {
    return record(key, "unavailable", "Deep Research availability could not be checked right now. Try refreshing in a moment.", { label });
  }

  const quota = strictQuota(facts.deepResearchBillingQuota, facts.deepResearchQuotaKnown ? facts.deepResearchQuota : null);
  const options = { label, ...planOptions(facts, quota) };
  if (quota?.available === false || quota?.limit === 0) {
    return record(key, "plan-restricted", "Deep Research is not available on your current plan.", {
      ...options,
      cta: "upgrade",
      remaining: quota.remaining,
      limit: quota.limit,
      resetAt: quota.resetAt,
    });
  }
  if (quota?.remaining === 0 && (quota.limit || 0) > 0) {
    return record(key, "limit-reached", "You have used all available Deep Research runs for this allowance window.", {
      ...options,
      cta: upgradeCtaFor(facts, quota),
      remaining: 0,
      limit: quota.limit,
      resetAt: quota.resetAt,
    });
  }
  return record(key, "available", quota?.remaining !== null && quota?.limit !== null
    ? `${quota.remaining} of ${quota.limit} Deep Research runs remain.`
    : "Deep Research is available.", {
    ...options,
    remaining: quota?.remaining ?? null,
    limit: quota?.limit ?? null,
    resetAt: quota?.resetAt || "",
    degraded: facts.deepResearchQuotaKnown && !facts.deepResearchQuota,
  });
}

function deriveLiveCapability(facts) {
  const key = "live";
  const label = "SentIQ Live";
  if (!facts.online) return record(key, "offline", "Reconnect to the internet to use Live voice.", { label });
  if (!facts.authKnown) return record(key, "checking", "Checking sign-in status…", { label });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to start a Live voice conversation.", { label, cta: "sign-in" });
  if (!facts.liveKnown) return record(key, "checking", "Checking Live voice availability…", { label });
  if (facts.liveError) return record(key, "unavailable", "Live voice availability could not be checked right now.", { label });
  const status = facts.liveStatus;
  if (!status) return record(key, "unavailable", "Live voice availability could not be checked right now.", { label });
  if (status.activeSession) return record(key, "busy", "A Live voice session is already active.", { label });
  if (status.available) {
    const reason = status.remainingSecondsToday > 0
      ? `${Math.ceil(status.remainingSecondsToday / 60)} minutes of Live voice remain today.`
      : "Live voice is available.";
    return record(key, "available", reason, {
      label,
      remaining: status.remainingSessionsToday,
      limit: null,
      ...planOptions(facts),
    });
  }
  if (status.reason === "sign_in_required") {
    return record(key, "sign-in-required", "Sign in to start a Live voice conversation.", { label, cta: "sign-in" });
  }
  if (status.reason === "not_available_on_plan") {
    return record(key, "plan-restricted", "Live voice is not available on your current plan.", { label, cta: "upgrade", ...planOptions(facts) });
  }
  if (status.reason === "daily_limit_reached") {
    return record(key, "limit-reached", "Your Live voice allowance for today has been used.", {
      label,
      cta: facts.planCode && facts.planCode !== "pro" ? "upgrade" : null,
      remaining: 0,
      ...planOptions(facts),
    });
  }
  if (status.reason === "browser_unsupported") {
    return record(key, "unavailable", "This browser cannot start Live voice. Use a supported browser with microphone access.", { label });
  }
  if (["busy", "capacity", "global_capacity", "project_capacity", "per_key_capacity"].includes(status.reason)) {
    return record(key, "busy", "Live voice is temporarily busy. Try again shortly.", { label });
  }
  return record(key, "unavailable", "Live voice is unavailable right now. Text chat remains available.", { label });
}

function deriveUploadCapability(facts) {
  const key = "upload";
  const label = "File upload";
  if (!facts.online) return record(key, "offline", "Reconnect to the internet before attaching a file.", { label });
  if (!facts.uploadSupported || !facts.uploadApiReady || !facts.uploadInputReady) {
    return record(key, "unavailable", "File uploads are not supported in this browser session.", { label });
  }
  if (facts.uploadingCount > 0) {
    return record(key, "busy", "Wait for the current upload to finish before adding another file.", { label });
  }
  return record(key, "available", "Files are ready to attach.", { label });
}

export function deriveCapabilitySnapshot(input = {}) {
  const facts = normalizeCapabilityFacts({ ...DEFAULT_CAPABILITY_FACTS, ...(input || {}) });
  const capabilities = Object.freeze({
    "image-generation": deriveImageCapability(facts),
    "deep-research": deriveDeepResearchCapability(facts),
    live: deriveLiveCapability(facts),
    upload: deriveUploadCapability(facts),
  });
  const blocked = Object.freeze(CAPABILITY_KEYS.filter((key) => !capabilities[key].available));
  return Object.freeze({
    version: CAPABILITY_MODEL_VERSION,
    statePriority: STATE_PRIORITY,
    facts,
    capabilities,
    blocked,
    ready: facts.authKnown,
  });
}
