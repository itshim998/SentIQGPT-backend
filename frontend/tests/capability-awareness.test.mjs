import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CAPABILITY_KEYS,
  CAPABILITY_MODEL_VERSION,
  deriveCapabilitySnapshot,
  normalizeQuota,
} from "../scripts/features/capability-model.mjs";

assert.equal(CAPABILITY_MODEL_VERSION, "9.3");
assert.deepEqual(CAPABILITY_KEYS, ["image-generation", "deep-research", "live", "upload"]);

const guest = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: false,
  planKnown: true,
  online: true,
  liveKnown: true,
  liveStatus: { available: false, reason: "sign_in_required" },
});
assert.equal(guest.capabilities["image-generation"].state, "sign-in-required");
assert.equal(guest.capabilities["deep-research"].state, "sign-in-required");
assert.equal(guest.capabilities.live.state, "sign-in-required");
assert.equal(guest.capabilities.upload.state, "available", "guest uploads remain available");
assert.equal(guest.capabilities["image-generation"].cta, "sign-in");

const planRestricted = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  planKnown: true,
  planCode: "free",
  imageBillingQuota: { available: false, remaining: 0, limit: 0 },
  imageQuotaKnown: true,
  imageQuota: { remaining: 30, limit: 30 },
  deepResearchBillingQuota: { available: false, remaining: 0, limit: 0 },
  deepResearchQuotaKnown: true,
  deepResearchQuota: { remaining: 7, limit: 7 },
  liveKnown: true,
  liveStatus: { available: false, reason: "not_available_on_plan" },
});
assert.equal(planRestricted.capabilities["image-generation"].state, "plan-restricted");
assert.equal(planRestricted.capabilities["deep-research"].state, "plan-restricted");
assert.equal(planRestricted.capabilities.live.state, "plan-restricted");
assert.equal(planRestricted.capabilities.live.cta, "upgrade");

const exhausted = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  planKnown: true,
  planCode: "premium",
  imageBillingQuota: { remaining: 0, limit: 8, reset_at: "2026-07-22T00:00:00Z" },
  imageQuotaKnown: true,
  imageQuota: { remaining: 22, limit: 30 },
  deepResearchBillingQuota: { remaining: 0, limit: 30 },
  deepResearchQuotaKnown: true,
  deepResearchQuota: { remaining: 0, limit: 30 },
  liveKnown: true,
  liveStatus: { available: false, reason: "daily_limit_reached" },
});
assert.equal(exhausted.capabilities["image-generation"].state, "limit-reached");
assert.equal(exhausted.capabilities["image-generation"].remaining, 0);
assert.equal(exhausted.capabilities["deep-research"].state, "limit-reached");
assert.equal(exhausted.capabilities.live.state, "limit-reached");
assert.equal(exhausted.capabilities["deep-research"].cta, "upgrade");

const cooling = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  planKnown: true,
  planCode: "pro",
  imageBillingQuota: { remaining: 8, limit: 12 },
  imageQuotaKnown: true,
  imageQuota: { remaining: 25, limit: 30, cooldownActive: true, retryAfterMs: 3000 },
  deepResearchBillingQuota: { remaining: 42, limit: 50 },
  deepResearchQuotaKnown: true,
  deepResearchQuota: { remaining: 42, limit: 50 },
  liveKnown: true,
  liveStatus: { available: true, remainingSecondsToday: 600, remainingSessionsToday: 2 },
});
assert.equal(cooling.capabilities["image-generation"].state, "cooldown");
assert.equal(cooling.capabilities["image-generation"].retryAfterMs, 3000);
assert.equal(cooling.capabilities["deep-research"].state, "available");
assert.equal(cooling.capabilities.live.state, "available");

const uploadOffline = deriveCapabilitySnapshot({ online: false, uploadSupported: true });
assert.equal(uploadOffline.capabilities.upload.state, "offline");
const uploadBusy = deriveCapabilitySnapshot({ online: true, uploadSupported: true, uploadingCount: 1 });
assert.equal(uploadBusy.capabilities.upload.state, "busy");
const uploadUnsupported = deriveCapabilitySnapshot({ online: true, uploadSupported: false });
assert.equal(uploadUnsupported.capabilities.upload.state, "unavailable");

const apiFailure = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  planKnown: true,
  planError: true,
  imageQuotaKnown: true,
  imageQuotaError: true,
  deepResearchQuotaKnown: true,
  deepResearchQuotaError: true,
  liveKnown: true,
  liveError: true,
});
assert.equal(apiFailure.capabilities["image-generation"].state, "unavailable");
assert.equal(apiFailure.capabilities["deep-research"].state, "unavailable");
assert.equal(apiFailure.capabilities.live.state, "unavailable");

assert.deepEqual(normalizeQuota({ limit: 10, used: 3, reserved: 2 }), {
  available: null,
  remaining: 5,
  limit: 10,
  used: 3,
  reserved: 2,
  cooldownActive: false,
  retryAfterMs: null,
  resetAt: "",
  reason: "",
  planCode: "",
  upgradeCta: false,
});

const allowedStates = new Set([
  "available",
  "checking",
  "offline",
  "sign-in-required",
  "plan-restricted",
  "limit-reached",
  "cooldown",
  "busy",
  "unavailable",
]);
for (const authenticated of [false, true]) {
  for (const online of [false, true]) {
    for (const remaining of [0, 1, 7]) {
      const result = deriveCapabilitySnapshot({
        authKnown: true,
        authenticated,
        online,
        planKnown: true,
        planCode: "free",
        imageBillingQuota: { remaining, limit: 7 },
        imageQuotaKnown: true,
        imageQuota: { remaining, limit: 7 },
        deepResearchBillingQuota: { remaining, limit: 7 },
        deepResearchQuotaKnown: true,
        deepResearchQuota: { remaining, limit: 7 },
        liveKnown: true,
        liveStatus: { available: remaining > 0, reason: remaining > 0 ? "" : "daily_limit_reached" },
      });
      for (const key of CAPABILITY_KEYS) {
        const capability = result.capabilities[key];
        assert(allowedStates.has(capability.state), `${key} returned an unknown state`);
        assert.equal(capability.available, capability.state === "available");
        if (!capability.available) assert(capability.reason.length > 0, `${key} must explain its blocked state`);
      }
    }
  }
}

const modelSource = await readFile(new URL("../scripts/features/capability-model.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("../scripts/features/capability-awareness.js", import.meta.url), "utf8");
const explanationSource = await readFile(new URL("../scripts/features/capability-explanation.js", import.meta.url), "utf8");
const combinedRuntimeSource = `${runtimeSource}\n${explanationSource}`;
const disclosureSource = await readFile(new URL("../scripts/features/progressive-disclosure.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/57-capability-awareness.css", import.meta.url), "utf8");
const responsiveCssSource = await readFile(new URL("../styles/modules/58-capability-awareness-responsive.css", import.meta.url), "utf8");
const combinedCss = `${cssSource}\n${responsiveCssSource}`;

for (const forbidden of ["document.", "window.SentIQ", "window.addEventListener", "fetch(", "localStorage", "sessionStorage", "indexedDB"]) {
  assert.equal(modelSource.includes(forbidden), false, `Pure capability model must not own ${forbidden}`);
}

for (const token of [
  'CAPABILITY_AWARENESS_VERSION = "9.3"',
  "#file-attach-btn",
  "[data-starter-action='file']",
  "#image-gen-btn",
  "#deep-research-btn",
  "#live-beta-btn",
  "API?.getBillingMe",
  "API?.getImageQuota",
  "API?.getDeepResearchQuota",
  "API?.getLiveStatus",
  'document.addEventListener("sentiq-auth-changed"',
  'document.addEventListener("sentiq-live-status"',
  'document.addEventListener("sentiq-ui-state-change"',
  'window.addEventListener("sentiq-billing-refresh"',
  'window.addEventListener("online"',
  'window.addEventListener("offline"',
  'setAttributeIfChanged(control, "aria-disabled"',
  "control.dataset.capabilityReason",
  "event.stopImmediatePropagation()",
  "sentiq-capability-explanation",
  'root.setAttribute("role", "dialog")',
  'cta === "sign-in"',
  'cta === "upgrade"',
  "window.SentIQCapabilities = Object.freeze",
]) assert.ok(combinedRuntimeSource.includes(token), `Capability runtime missing ${token}`);

for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "XMLHttpRequest"]) {
  assert.equal(combinedRuntimeSource.includes(forbidden), false, `Capability runtime must not own ${forbidden}`);
}

assert.ok(domRefsSource.includes('import "../capability-awareness.js";'));
assert.ok(
  domRefsSource.indexOf('import "../progressive-disclosure.js";') < domRefsSource.indexOf('import "../capability-awareness.js";'),
  "Capability awareness should enhance controls after progressive disclosure initializes",
);
assert.ok(importsSource.includes('@import url("./57-capability-awareness.css");'));
assert.ok(importsSource.includes('@import url("./58-capability-awareness-responsive.css");'));
assert.ok(disclosureSource.includes("progressive-sheet-action"), "Existing mobile action sheet remains intact");

for (const token of [
  'data-capability-awareness-version="9.3"',
  '[data-capability-available="false"]',
  ".sentiq-capability-explanation",
  ".sentiq-capability-explanation-action",
  "safe-area-inset-bottom",
  "overscroll-behavior: contain",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(combinedCss.includes(token), `Capability CSS missing ${token}`);

console.log("Pass 9.3 capability-aware actions phase gate passed.");
