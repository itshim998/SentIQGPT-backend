import assert from "node:assert/strict";
import {
  canRetryIntuitiveRequestInFast,
  formatCompactQuotaTokens,
  formatRecoveryCountdown,
  normalizeTextAllowance,
  resolveTextQuotaView,
} from "../scripts/features/text-quota-state.mjs";

const now = Date.parse("2026-07-27T14:00:00.000Z");
const fresh = Object.freeze({
  policy_version: "unified-text-tokens-v2",
  plan_code: "free",
  limit_tokens: 50_000,
  window_seconds: 18_000,
  used_tokens: 0,
  reserved_tokens: 0,
  remaining_tokens: 50_000,
  fast_reserve_tokens: 10_000,
  fast_available_tokens: 50_000,
  intuitive_available_tokens: 40_000,
  intuitive_allowed: true,
  required_mode: null,
  exhausted: false,
  next_recovery_at: null,
  full_reset_at: null,
});

assert.equal(normalizeTextAllowance({ policy_version: "other" }), null);
assert.equal(formatCompactQuotaTokens(50_000), "50K");
assert.equal(formatCompactQuotaTokens(11_500), "11.5K");
assert.equal(formatRecoveryCountdown(now + 30_000, now), "under a minute");
assert.equal(formatRecoveryCountdown(now + 61 * 60_000, now), "1 hr 1 min");

const hidden = resolveTextQuotaView({ quotaUiEnabled: false, allowance: fresh, now });
assert.equal(hidden.visible, false);
assert.equal(hidden.blockComposer, false);

const available = resolveTextQuotaView({ quotaUiEnabled: true, allowance: fresh, now });
assert.equal(available.state, "available");
assert.equal(available.visible, false);
assert.equal(available.intuitiveSelectable, true);
assert.equal(available.title, "50K text tokens left");
assert.equal(available.detail, "40K available for Intuitive");

const recoveryAt = "2026-07-27T14:30:00.000Z";
const atReserve = {
  ...fresh,
  used_tokens: 40_000,
  remaining_tokens: 10_000,
  fast_available_tokens: 10_000,
  intuitive_available_tokens: 0,
  intuitive_allowed: false,
  required_mode: "fast",
  next_recovery_at: recoveryAt,
};
const fastOnly = resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: atReserve,
  executionMode: "intuitive",
  now,
});
assert.equal(fastOnly.state, "fast-only");
assert.equal(fastOnly.visible, true);
assert.equal(fastOnly.shouldSwitchToFast, true);
assert.equal(fastOnly.intuitiveSelectable, false);
assert.equal(fastOnly.blockComposer, false);
assert.match(fastOnly.detail, /^Fast only/);

const oneTokenHeadroom = resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: {
    ...atReserve,
    used_tokens: 39_999,
    remaining_tokens: 10_001,
    fast_available_tokens: 10_001,
    intuitive_available_tokens: 1,
    intuitive_allowed: true,
  },
  executionMode: "intuitive",
  now,
});
assert.equal(oneTokenHeadroom.state, "fast-only");

const ordinaryBoundary = {
  ...atReserve,
  used_tokens: 38_500,
  remaining_tokens: 11_500,
  fast_available_tokens: 11_500,
  intuitive_available_tokens: 1_500,
  intuitive_allowed: true,
};
assert.equal(resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: ordinaryBoundary,
  heavyContext: false,
  now,
}).state, "available");
assert.equal(resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: ordinaryBoundary,
  heavyContext: true,
  executionMode: "intuitive",
  now,
}).state, "fast-only");

const exhausted = resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: {
    ...atReserve,
    used_tokens: 50_000,
    remaining_tokens: 0,
    fast_available_tokens: 0,
    exhausted: true,
  },
  executionMode: "intuitive",
  now,
});
assert.equal(exhausted.state, "exhausted");
assert.equal(exhausted.visible, true);
assert.equal(exhausted.blockComposer, true);
assert.equal(exhausted.title, "Text limit reached");

const belowFastMinimum = resolveTextQuotaView({
  quotaUiEnabled: true,
  allowance: {
    ...atReserve,
    remaining_tokens: 255,
    fast_available_tokens: 255,
  },
  now,
});
assert.equal(belowFastMinimum.blockComposer, true);

assert.equal(canRetryIntuitiveRequestInFast({
  error: { code: "intuitive_fast_required", details: atReserve },
  originalMode: "intuitive",
  quotaUiEnabled: true,
  allowance: atReserve,
  alreadyRetried: false,
}), true);
assert.equal(canRetryIntuitiveRequestInFast({
  error: { code: "unified_text_quota_exhausted", details: exhausted.allowance },
  originalMode: "intuitive",
  quotaUiEnabled: true,
  allowance: exhausted.allowance,
  alreadyRetried: false,
}), false);
assert.equal(canRetryIntuitiveRequestInFast({
  error: { code: "intuitive_fast_required", details: atReserve },
  originalMode: "intuitive",
  quotaUiEnabled: true,
  allowance: atReserve,
  alreadyRetried: true,
}), false);

const publicCopy = [available.title, available.detail, fastOnly.title, fastOnly.detail, exhausted.title, exhausted.detail].join(" ");
assert.doesNotMatch(publicCopy, /nvidia|nemotron|groq|gemini|pollinations|provider|model/i);

console.log("Unified text quota frontend-state checks passed.");
