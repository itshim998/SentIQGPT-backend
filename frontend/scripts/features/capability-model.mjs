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
  const available = state === "available";
  const interactive = typeof options.interactive === "boolean"
    ? options.interactive
    : available;
  return Object.freeze({
    key,
    label: options.label || key,
    state,
    available,
    interactive,
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
  if (!facts.online) return record(key, "offline", "Connect to the internet to generate images.", { label, interactive: false });
  if (!facts.authKnown) return record(key, "checking", "Checking…", { label, interactive: false });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to generate images.", { label, cta: "sign-in", interactive: false });
  if (!facts.planKnown) return record(key, "checking", "Checking…", { label, ...planOptions(facts), interactive: true });
  // The process-level image quota does not prove plan entitlement. If billing
  // cannot be resolved, keep the control blocked rather than claiming that an
  // IP-level slot means image generation is actually available.
  if (facts.planError || !hasQuotaSignal(facts.imageBillingQuota)) {
    return record(key, "unavailable", "Couldn't check availability. Refresh and try again.", { label, interactive: false });
  }

  const quota = strictQuota(facts.imageBillingQuota, facts.imageQuotaKnown ? facts.imageQuota : null);
  const options = { label, ...planOptions(facts, quota) };
  if (quota?.available === false || quota?.limit === 0) {
    return record(key, "plan-restricted", "Not included in your plan.", {
      ...options,
      cta: "upgrade",
      remaining: quota.remaining,
      limit: quota.limit,
      resetAt: quota.resetAt,
      interactive: false,
    });
  }
  if (quota?.remaining === 0 && (quota.limit || 0) > 0) {
    return record(key, "limit-reached", "No image credits left.", {
      ...options,
      cta: upgradeCtaFor(facts, quota),
      remaining: 0,
      limit: quota.limit,
      resetAt: quota.resetAt,
      interactive: false,
    });
  }
  if (quota?.cooldownActive) {
    return record(key, "cooldown", "Wait a few seconds and try again.", {
      ...options,
      remaining: quota.remaining,
      limit: quota.limit,
      retryAfterMs: quota.retryAfterMs,
      interactive: false,
    });
  }
  return record(key, "available", quota?.remaining !== null && quota?.limit !== null
    ? `${quota.remaining} of ${quota.limit} image credits left.`
    : "Generate an image.", {
    ...options,
    remaining: quota?.remaining ?? null,
    limit: quota?.limit ?? null,
    resetAt: quota?.resetAt || "",
    degraded: facts.imageQuotaKnown && !facts.imageQuota,
    interactive: true,
  });
}

function deriveDeepResearchCapability(facts) {
  const key = "deep-research";
  const label = "Deep Research";
  if (!facts.online) return record(key, "offline", "Connect to the internet to use Deep Research.", { label, interactive: false });
  if (!facts.authKnown) return record(key, "checking", "Checking…", { label, interactive: false });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to use Deep Research.", { label, cta: "sign-in", interactive: false });
  if (!facts.planKnown) return record(key, "checking", "Checking…", { label, ...planOptions(facts), interactive: true });
  const researchQuotaAvailable = hasQuotaSignal(facts.deepResearchBillingQuota)
    || (facts.deepResearchQuotaKnown && hasQuotaSignal(facts.deepResearchQuota));
  if (!researchQuotaAvailable || (facts.planError && (!facts.deepResearchQuotaKnown || facts.deepResearchQuotaError))) {
    return record(key, "unavailable", "Couldn't check availability. Refresh and try again.", { label, interactive: false });
  }

  const quota = strictQuota(facts.deepResearchBillingQuota, facts.deepResearchQuotaKnown ? facts.deepResearchQuota : null);
  const options = { label, ...planOptions(facts, quota) };
  if (quota?.available === false || quota?.limit === 0) {
    return record(key, "plan-restricted", "Not included in your plan.", {
      ...options,
      cta: "upgrade",
      remaining: quota.remaining,
      limit: quota.limit,
      resetAt: quota.resetAt,
      interactive: false,
    });
  }
  if (quota?.remaining === 0 && (quota.limit || 0) > 0) {
    return record(key, "limit-reached", "No Deep Research runs left.", {
      ...options,
      cta: upgradeCtaFor(facts, quota),
      remaining: 0,
      limit: quota.limit,
      resetAt: quota.resetAt,
      interactive: false,
    });
  }
  return record(key, "available", quota?.remaining !== null && quota?.limit !== null
    ? `${quota.remaining} of ${quota.limit} runs left.`
    : "Start a Deep Research report.", {
    ...options,
    remaining: quota?.remaining ?? null,
    limit: quota?.limit ?? null,
    resetAt: quota?.resetAt || "",
    degraded: facts.deepResearchQuotaKnown && !facts.deepResearchQuota,
    interactive: true,
  });
}

function deriveLiveCapability(facts) {
  const key = "live";
  const label = "SentIQ Live";
  if (!facts.online) return record(key, "offline", "Connect to the internet to use Live voice.", { label, interactive: false });
  if (!facts.authKnown) return record(key, "checking", "Checking…", { label, interactive: false });
  if (!facts.authenticated) return record(key, "sign-in-required", "Sign in to use Live voice.", { label, cta: "sign-in", interactive: false });
  if (!facts.liveKnown) return record(key, "checking", "Checking…", { label, ...planOptions(facts), interactive: true });
  if (facts.liveError) return record(key, "unavailable", "Couldn't check availability. Refresh and try again.", { label });
  const status = facts.liveStatus;
  if (!status) return record(key, "unavailable", "Couldn't check availability. Refresh and try again.", { label });
  if (status.activeSession) return record(key, "busy", "A session is already open.", { label });
  if (status.available) {
    const reason = status.remainingSecondsToday > 0
      ? `${Math.ceil(status.remainingSecondsToday / 60)} minutes left today.`
      : "Start Live voice.";
    return record(key, "available", reason, {
      label,
      remaining: status.remainingSessionsToday,
      limit: null,
      ...planOptions(facts),
    });
  }
  if (status.reason === "sign_in_required") {
    return record(key, "sign-in-required", "Sign in to use Live voice.", { label, cta: "sign-in" });
  }
  if (status.reason === "not_available_on_plan") {
    return record(key, "plan-restricted", "Not included in your plan.", { label, cta: "upgrade", ...planOptions(facts) });
  }
  if (status.reason === "daily_limit_reached") {
    return record(key, "limit-reached", "Daily Live voice time used.", {
      label,
      cta: facts.planCode && facts.planCode !== "pro" ? "upgrade" : null,
      remaining: 0,
      ...planOptions(facts),
    });
  }
  if (status.reason === "browser_unsupported") {
    return record(key, "unavailable", "Not supported in this browser. Use a browser with microphone access.", { label });
  }
  if (["busy", "capacity", "global_capacity", "project_capacity", "per_key_capacity"].includes(status.reason)) {
    return record(key, "busy", "Live voice is busy. Try again soon.", { label });
  }
  return record(key, "unavailable", "Live voice is unavailable.", { label });
}

function deriveUploadCapability(facts) {
  const key = "upload";
  const label = "File upload";
  if (!facts.online) return record(key, "offline", "Connect to the internet to attach files.", { label });
  if (!facts.uploadSupported || !facts.uploadApiReady || !facts.uploadInputReady) {
    return record(key, "unavailable", "File uploads aren't supported in this browser.", { label });
  }
  if (facts.uploadingCount > 0) {
    return record(key, "busy", "Wait for the current upload to finish.", { label });
  }
  return record(key, "available", "Attach files.", { label });
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
