export const UNIFIED_TEXT_POLICY_VERSION = "unified-text-tokens-v2";
export const UNIFIED_TEXT_LIMIT_TOKENS = 50_000;
export const FAST_RESERVE_TOKENS = 10_000;

const FORBIDDEN_PUBLIC_PATTERN = /\bnvidia\b|\bnemotron\b|integrate\.api\.nvidia\.com|reasoning_content|<think>|<\/think>/i;

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectCanaryUsage(payload) {
  const allowance = payload?.summary?.text_allowance ?? null;
  return Object.freeze({
    httpStatus: finiteOrNull(payload?.__http_status),
    quotaUiEnabled: payload?.quota_ui_enabled === true,
    policyVersion: typeof allowance?.policy_version === "string" ? allowance.policy_version : null,
    limitTokens: finiteOrNull(allowance?.limit_tokens),
    usedTokens: finiteOrNull(allowance?.used_tokens),
    reservedTokens: finiteOrNull(allowance?.reserved_tokens),
    remainingTokens: finiteOrNull(allowance?.remaining_tokens),
    fastReserveTokens: finiteOrNull(allowance?.fast_reserve_tokens),
    fastAvailableTokens: finiteOrNull(allowance?.fast_available_tokens),
    intuitiveAvailableTokens: finiteOrNull(allowance?.intuitive_available_tokens),
    intuitiveAllowed: allowance?.intuitive_allowed === true,
    exhausted: allowance?.exhausted === true,
    nextRecoveryAt: typeof allowance?.next_recovery_at === "string" ? allowance.next_recovery_at : null,
  });
}

export function validateCanaryUsage(payload) {
  const usage = projectCanaryUsage(payload);
  const issues = [];
  if (usage.httpStatus !== 200) issues.push("billing_usage_http_status");
  if (!usage.quotaUiEnabled) issues.push("quota_ui_not_enabled");
  if (usage.policyVersion !== UNIFIED_TEXT_POLICY_VERSION) issues.push("unified_policy_missing");
  if (usage.limitTokens !== UNIFIED_TEXT_LIMIT_TOKENS) issues.push("unexpected_text_limit");
  if (usage.fastReserveTokens !== FAST_RESERVE_TOKENS) issues.push("unexpected_fast_reserve");
  if (usage.remainingTokens === null || usage.remainingTokens < 0 || usage.remainingTokens > UNIFIED_TEXT_LIMIT_TOKENS) {
    issues.push("invalid_remaining_tokens");
  }
  if (usage.reservedTokens === null || usage.reservedTokens < 0) issues.push("invalid_reserved_tokens");
  return Object.freeze({ valid: issues.length === 0, usage, issues: Object.freeze(issues) });
}

export function summarizeCanarySse(raw, httpStatus) {
  const dataLines = String(raw ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const events = dataLines
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const tokenEvents = events.filter((event) => event.type === "token" && typeof event.text === "string");
  const errorEvents = events.filter((event) => event.type === "error");
  return Object.freeze({
    httpStatus: finiteOrNull(httpStatus),
    done: dataLines.includes("[DONE]"),
    tokenEvents: tokenEvents.length,
    visibleCharacters: tokenEvents.reduce((total, event) => total + event.text.length, 0),
    errorEvents: errorEvents.length,
    errorCodes: Object.freeze(errorEvents
      .map((event) => typeof event.code === "string" ? event.code : "unknown")
      .slice(0, 5)),
    routeEvents: events.filter((event) => event.type === "route").length,
    webSurfSources: events.some((event) => event.type === "websurf_sources"),
    structuredResponse: events.some((event) => event.type === "structured_response"),
    forbiddenPublicMarker: FORBIDDEN_PUBLIC_PATTERN.test(String(raw ?? "")),
  });
}

export function validateCanarySse(summary, options = {}) {
  const issues = [];
  if (summary.httpStatus !== 200) issues.push("chat_http_status");
  if (summary.tokenEvents < 1 || summary.visibleCharacters < 1) issues.push("no_visible_answer");
  if (summary.errorEvents > 0) issues.push("stream_error_event");
  if (!summary.done) issues.push("stream_not_completed");
  if (summary.forbiddenPublicMarker) issues.push("internal_marker_visible");
  if (options.requireRouteEvent && summary.routeEvents < 1) issues.push("route_event_missing");
  if (options.requireWebSurfSources && !summary.webSurfSources) issues.push("websurf_sources_missing");
  return Object.freeze({ valid: issues.length === 0, issues: Object.freeze(issues) });
}

export function validateCanaryUsageDelta(beforePayload, afterPayload) {
  const before = projectCanaryUsage(beforePayload);
  const after = projectCanaryUsage(afterPayload);
  const issues = [];
  if (before.usedTokens === null || after.usedTokens === null || after.usedTokens <= before.usedTokens) {
    issues.push("usage_did_not_increase");
  }
  if (
    before.remainingTokens === null
    || after.remainingTokens === null
    || after.remainingTokens >= before.remainingTokens
  ) {
    issues.push("remaining_tokens_did_not_decrease");
  }
  if (after.reservedTokens !== 0) issues.push("reservations_not_settled");
  return Object.freeze({ valid: issues.length === 0, before, after, issues: Object.freeze(issues) });
}
