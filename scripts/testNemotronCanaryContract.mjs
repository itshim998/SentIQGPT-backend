import assert from "node:assert/strict";
import {
  summarizeCanarySse,
  validateCanarySse,
  validateCanaryUsage,
  validateCanaryUsageDelta,
} from "./nemotronCanaryContract.mjs";

function usagePayload(overrides = {}) {
  return {
    __http_status: 200,
    quota_ui_enabled: true,
    summary: {
      text_allowance: {
        policy_version: "unified-text-tokens-v2",
        limit_tokens: 50_000,
        used_tokens: 1_000,
        reserved_tokens: 0,
        remaining_tokens: 49_000,
        fast_reserve_tokens: 10_000,
        fast_available_tokens: 49_000,
        intuitive_available_tokens: 39_000,
        intuitive_allowed: true,
        exhausted: false,
        next_recovery_at: "2026-07-27T20:00:00.000Z",
        ...overrides,
      },
    },
  };
}

const validUsage = validateCanaryUsage(usagePayload());
assert.equal(validUsage.valid, true);

assert.equal(validateCanaryUsage(usagePayload({ policy_version: "legacy" })).valid, false);
assert.equal(validateCanaryUsage(usagePayload({ limit_tokens: 49_999 })).valid, false);
assert.equal(validateCanaryUsage(usagePayload({ fast_reserve_tokens: 9_999 })).valid, false);

const rawSuccess = [
  'data: {"type":"route","route":"chat"}',
  'data: {"type":"token","text":"OK"}',
  'data: [DONE]',
  "",
].join("\n");
const successSummary = summarizeCanarySse(rawSuccess, 200);
assert.equal(successSummary.visibleCharacters, 2);
assert.equal(validateCanarySse(successSummary, { requireRouteEvent: true }).valid, true);

const leaked = summarizeCanarySse([
  'data: {"type":"token","text":"reasoning_content"}',
  'data: [DONE]',
].join("\n"), 200);
assert.equal(leaked.forbiddenPublicMarker, true);
assert.equal(validateCanarySse(leaked).valid, false);

const webSummary = summarizeCanarySse([
  'data: {"type":"route","route":"web_search"}',
  'data: {"type":"websurf_sources","web_search":{"sources":[]}}',
  'data: {"type":"token","text":"Current answer"}',
  'data: [DONE]',
].join("\n"), 200);
assert.equal(validateCanarySse(webSummary, {
  requireRouteEvent: true,
  requireWebSurfSources: true,
}).valid, true);

const validDelta = validateCanaryUsageDelta(
  usagePayload(),
  usagePayload({ used_tokens: 1_300, remaining_tokens: 48_700, reserved_tokens: 0 }),
);
assert.equal(validDelta.valid, true);

const unsettledDelta = validateCanaryUsageDelta(
  usagePayload(),
  usagePayload({ used_tokens: 1_300, remaining_tokens: 48_700, reserved_tokens: 200 }),
);
assert.equal(unsettledDelta.valid, false);
assert.ok(unsettledDelta.issues.includes("reservations_not_settled"));

console.log("Nemotron canary verification contract checks passed.");
