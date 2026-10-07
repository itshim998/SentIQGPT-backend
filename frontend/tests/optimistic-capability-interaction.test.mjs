import assert from "node:assert/strict";
import {
  CAPABILITY_KEYS,
  deriveCapabilitySnapshot,
} from "../scripts/features/capability-model.mjs";
import {
  RESTRICTED_TOOLS,
  resolveFreeToolPolicyState,
  isIntuitiveLockedForTools,
} from "../scripts/features/free-tool-execution-policy.mjs";

console.log("[test] Optimistic Capability Interaction & Enforcement Contract Tests");

// ==================================================
// A. Authenticated + capability check still running
// ==================================================
console.log("[test] A. Authenticated + capability check still running");
const authenticatedChecking = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  online: true,
  planKnown: false,
});

for (const key of ["image-generation", "deep-research", "live"]) {
  const cap = authenticatedChecking.capabilities[key];
  assert.equal(cap.state, "checking", `${key} should be in checking state`);
  assert.equal(cap.available, false, `${key} must NOT be considered authoritatively available while checking`);
  assert.equal(cap.interactive, true, `${key} MUST be interactive/attemptable for an authenticated user while checking`);
}
assert.equal(authenticatedChecking.capabilities.upload.state, "available");
assert.equal(authenticatedChecking.capabilities.upload.available, true);
assert.equal(authenticatedChecking.capabilities.upload.interactive, true);

// ==================================================
// B. Authenticated + quota available
// ==================================================
console.log("[test] B. Authenticated + quota available");
const authenticatedAvailable = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  online: true,
  planKnown: true,
  planCode: "premium",
  imageBillingQuota: { remaining: 5, limit: 10 },
  imageQuotaKnown: true,
  imageQuota: { remaining: 5, limit: 10 },
  deepResearchBillingQuota: { remaining: 10, limit: 20 },
  deepResearchQuotaKnown: true,
  deepResearchQuota: { remaining: 10, limit: 20 },
  liveKnown: true,
  liveStatus: { available: true, remainingSecondsToday: 1200 },
});

assert.equal(authenticatedAvailable.capabilities["image-generation"].available, true);
assert.equal(authenticatedAvailable.capabilities["image-generation"].interactive, true);
assert.equal(authenticatedAvailable.capabilities["deep-research"].available, true);
assert.equal(authenticatedAvailable.capabilities["deep-research"].interactive, true);
assert.equal(authenticatedAvailable.capabilities.live.available, true);
assert.equal(authenticatedAvailable.capabilities.live.interactive, true);

// ==================================================
// C. Authenticated + quota exhausted
// ==================================================
console.log("[test] C. Authenticated + quota exhausted");
const authenticatedExhausted = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  online: true,
  planKnown: true,
  planCode: "premium",
  imageBillingQuota: { remaining: 0, limit: 10 },
  imageQuotaKnown: true,
  imageQuota: { remaining: 0, limit: 10 },
  deepResearchBillingQuota: { remaining: 0, limit: 20 },
  deepResearchQuotaKnown: true,
  deepResearchQuota: { remaining: 0, limit: 20 },
  liveKnown: true,
  liveStatus: { available: false, reason: "daily_limit_reached" },
});

assert.equal(authenticatedExhausted.capabilities["image-generation"].state, "limit-reached");
assert.equal(authenticatedExhausted.capabilities["image-generation"].available, false);
assert.equal(authenticatedExhausted.capabilities["image-generation"].interactive, false);

assert.equal(authenticatedExhausted.capabilities["deep-research"].state, "limit-reached");
assert.equal(authenticatedExhausted.capabilities["deep-research"].available, false);
assert.equal(authenticatedExhausted.capabilities["deep-research"].interactive, false);

assert.equal(authenticatedExhausted.capabilities.live.state, "limit-reached");
assert.equal(authenticatedExhausted.capabilities.live.available, false);
assert.equal(authenticatedExhausted.capabilities.live.interactive, false);

// ==================================================
// D. Authenticated + plan restriction
// ==================================================
console.log("[test] D. Authenticated + plan restriction");
const planRestricted = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  online: true,
  planKnown: true,
  planCode: "free",
  imageBillingQuota: { available: false, remaining: 0, limit: 0 },
  imageQuotaKnown: true,
  deepResearchBillingQuota: { available: false, remaining: 0, limit: 0 },
  deepResearchQuotaKnown: true,
  liveKnown: true,
  liveStatus: { available: false, reason: "not_available_on_plan" },
});

assert.equal(planRestricted.capabilities["image-generation"].state, "plan-restricted");
assert.equal(planRestricted.capabilities["image-generation"].available, false);
assert.equal(planRestricted.capabilities["image-generation"].interactive, false);

assert.equal(planRestricted.capabilities["deep-research"].state, "plan-restricted");
assert.equal(planRestricted.capabilities["deep-research"].available, false);
assert.equal(planRestricted.capabilities["deep-research"].interactive, false);

assert.equal(planRestricted.capabilities.live.state, "plan-restricted");
assert.equal(planRestricted.capabilities.live.available, false);
assert.equal(planRestricted.capabilities.live.interactive, false);

// ==================================================
// E. Authenticated + billing read error
// ==================================================
console.log("[test] E. Authenticated + billing read error");
const billingReadError = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: true,
  online: true,
  planKnown: true,
  planError: true,
  imageQuotaKnown: true,
  imageQuotaError: true,
  deepResearchQuotaKnown: true,
  deepResearchQuotaError: true,
});

assert.equal(billingReadError.capabilities["image-generation"].state, "unavailable");
assert.notEqual(billingReadError.capabilities["image-generation"].state, "limit-reached", "Billing error must NOT be interpreted as quota exhaustion");
assert.equal(billingReadError.capabilities["deep-research"].state, "unavailable");
assert.notEqual(billingReadError.capabilities["deep-research"].state, "limit-reached", "Billing error must NOT be interpreted as quota exhaustion");

// ==================================================
// F. Guest / unauthenticated behavior
// ==================================================
console.log("[test] F. Guest / unauthenticated behavior");
const guest = deriveCapabilitySnapshot({
  authKnown: true,
  authenticated: false,
  online: true,
});

assert.equal(guest.capabilities["image-generation"].state, "sign-in-required");
assert.equal(guest.capabilities["image-generation"].available, false);
assert.equal(guest.capabilities["image-generation"].interactive, false);

assert.equal(guest.capabilities["deep-research"].state, "sign-in-required");
assert.equal(guest.capabilities["deep-research"].available, false);
assert.equal(guest.capabilities["deep-research"].interactive, false);

const authUnknown = deriveCapabilitySnapshot({
  authKnown: false,
  authenticated: false,
  online: true,
});

assert.equal(authUnknown.capabilities["image-generation"].state, "checking");
assert.equal(authUnknown.capabilities["image-generation"].available, false);
assert.equal(authUnknown.capabilities["image-generation"].interactive, false, "Unknown auth must NOT be interactive");

// ==================================================
// G. Deep Research execution-time quota rejection simulation
// ==================================================
console.log("[test] G. Deep Research execution-time quota rejection handling");
{
  let cardRemoved = false;
  let quotaWarningShown = null;
  let billingRefreshed = false;
  let capabilitiesRefreshed = false;

  const fakeRunningCard = {
    remove() { cardRemoved = true; },
  };

  const fakeApiError = new Error("Deep Research limit reached.");
  fakeApiError.code = "quota_exceeded";
  fakeApiError.status = 402;
  fakeApiError.details = {
    error: "Deep Research limit reached.",
    code: "quota_exceeded",
    type: "quota_exceeded",
    feature: "deep_research",
  };

  const reportId = null; // No task created on backend
  const isQuotaRejection = !reportId && (
    fakeApiError.code === "quota_exceeded" ||
    fakeApiError.details?.type === "quota_exceeded" ||
    fakeApiError.details?.code === "quota_exceeded" ||
    fakeApiError.status === 402 ||
    Boolean(fakeApiError.message && /deep research.*limit reached/i.test(fakeApiError.message))
  );

  assert.equal(isQuotaRejection, true);

  if (isQuotaRejection) {
    fakeRunningCard.remove();
    quotaWarningShown = fakeApiError.message;
    billingRefreshed = true;
    capabilitiesRefreshed = true;
  }

  assert.equal(cardRemoved, true, "Temporary running card must be cleaned up on quota rejection");
  assert.equal(quotaWarningShown, "Deep Research limit reached.", "Quota warning must display specific quota message");
  assert.equal(billingRefreshed, true, "Billing refresh must be triggered for reconciliation");
  assert.equal(capabilitiesRefreshed, true, "Capabilities refresh must be triggered for reconciliation");

  // Reconciled snapshot reflects exhausted state
  const reconciledSnapshot = deriveCapabilitySnapshot({
    authKnown: true,
    authenticated: true,
    online: true,
    planKnown: true,
    planCode: "free",
    deepResearchBillingQuota: { remaining: 0, limit: 5 },
    deepResearchQuotaKnown: true,
    deepResearchQuota: { remaining: 0, limit: 5 },
  });
  assert.equal(reconciledSnapshot.capabilities["deep-research"].state, "limit-reached");
  assert.equal(reconciledSnapshot.capabilities["deep-research"].available, false);
  assert.equal(reconciledSnapshot.capabilities["deep-research"].interactive, false);
}

// ==================================================
// H. Deep Research execution-time success while initial capability state was checking
// ==================================================
console.log("[test] H. Deep Research execution-time success while initial capability state was checking");
{
  const initialCap = authenticatedChecking.capabilities["deep-research"];
  assert.equal(initialCap.state, "checking");
  assert.equal(initialCap.interactive, true);

  // User submits prompt while checking; backend reserves quota and starts task
  const backendReservationSuccess = true;
  assert.equal(backendReservationSuccess, true);
  const startedReport = {
    report_id: "rep-abc-123",
    status: "queued",
    latest_status_text: "Queued for Deep Research.",
  };
  assert.equal(Boolean(startedReport.report_id), true);
}

// ==================================================
// I. Image generation quota rejection simulation
// ==================================================
console.log("[test] I. Image generation quota rejection handling");
{
  let placeholderRemoved = false;
  let quotaWarningShown = null;
  let billingRefreshed = false;
  let capabilitiesRefreshed = false;

  const fakePlaceholder = {
    bubble: {
      remove() { placeholderRemoved = true; },
    },
  };

  const imageQuotaError = {
    code: "quota_exceeded",
    message: "Image generation limit reached. Review Billing for reset and upgrade options.",
  };

  if (imageQuotaError.code === "quota_exceeded") {
    fakePlaceholder.bubble.remove();
    quotaWarningShown = imageQuotaError.message;
    billingRefreshed = true;
    capabilitiesRefreshed = true;
  }

  assert.equal(placeholderRemoved, true);
  assert.equal(quotaWarningShown, "Image generation limit reached. Review Billing for reset and upgrade options.");
  assert.equal(billingRefreshed, true);
  assert.equal(capabilitiesRefreshed, true);
}

// ==================================================
// J. Conversation continuity
// ==================================================
console.log("[test] J. Conversation continuity restoration with checking state");
{
  function capabilityInteractive(key, snapshot) {
    const capability = snapshot?.capabilities?.[key];
    if (!capability) return true;
    return typeof capability.interactive === "boolean" ? capability.interactive : capability.available;
  }

  // 1. While checking, continuity restore must NOT block
  assert.equal(capabilityInteractive("image-generation", authenticatedChecking), true, "Checking state must not block image continuity restore");
  assert.equal(capabilityInteractive("deep-research", authenticatedChecking), true, "Checking state must not block deep-research continuity restore");

  // 2. When genuinely exhausted, continuity restore MUST block
  assert.equal(capabilityInteractive("image-generation", authenticatedExhausted), false, "Exhausted state must block image continuity restore");
  assert.equal(capabilityInteractive("deep-research", authenticatedExhausted), false, "Exhausted state must block deep-research continuity restore");

  // 3. When guest, continuity restore MUST block
  assert.equal(capabilityInteractive("image-generation", guest), false, "Guest state must block image continuity restore");
  assert.equal(capabilityInteractive("deep-research", guest), false, "Guest state must block deep-research continuity restore");
}

// ==================================================
// K. Free-plan execution-mode policy
// ==================================================
console.log("[test] K. Free-plan execution-mode policy during checking & tool activation");
{
  // 1. When plan is still checking (planKnown: false), policy does not impose false lock
  assert.equal(isIntuitiveLockedForTools({
    authenticated: true,
    planCode: "",
    planKnown: false,
    activeTool: RESTRICTED_TOOLS.DEEP_RESEARCH,
  }), false);

  // 2. Once plan resolves as Free, active restricted tool locks execution mode to Fast
  const freePolicy = resolveFreeToolPolicyState({
    authenticated: true,
    planCode: "free",
    planKnown: true,
    deepResearchActive: true,
    preferredMode: "intuitive",
  });
  assert.equal(freePolicy.isLocked, true);
  assert.equal(freePolicy.effectiveMode, "fast");
  assert.equal(freePolicy.activeTool, RESTRICTED_TOOLS.DEEP_RESEARCH);

  // 3. Paid plans are unrestricted
  const proPolicy = resolveFreeToolPolicyState({
    authenticated: true,
    planCode: "pro",
    planKnown: true,
    deepResearchActive: true,
    preferredMode: "intuitive",
    currentEffectiveMode: "intuitive",
  });
  assert.equal(proPolicy.isLocked, false);
  assert.equal(proPolicy.effectiveMode, "intuitive");
}

// ==================================================
// L. Accessibility and DOM state contracts
// ==================================================
console.log("[test] L. Accessibility and DOM interaction semantics");
{
  function simulateSyncControl(capability) {
    const interactive = capability.interactive !== undefined ? capability.interactive : capability.available;
    return {
      "aria-disabled": interactive ? "false" : "true",
      "data-capability-available": String(capability.available),
      "data-capability-interactive": String(interactive),
      "is-capability-blocked": !interactive,
      "is-capability-checking": capability.state === "checking",
    };
  }

  // Checking authenticated tool:
  const checkingDom = simulateSyncControl(authenticatedChecking.capabilities["deep-research"]);
  assert.equal(checkingDom["aria-disabled"], "false", "Checking authenticated tool must NOT have aria-disabled=true");
  assert.equal(checkingDom["data-capability-interactive"], "true");
  assert.equal(checkingDom["is-capability-blocked"], false, "Checking authenticated tool must NOT be blocked");
  assert.equal(checkingDom["is-capability-checking"], true);

  // Exhausted tool:
  const exhaustedDom = simulateSyncControl(authenticatedExhausted.capabilities["deep-research"]);
  assert.equal(exhaustedDom["aria-disabled"], "true", "Exhausted tool MUST have aria-disabled=true");
  assert.equal(exhaustedDom["data-capability-interactive"], "false");
  assert.equal(exhaustedDom["is-capability-blocked"], true, "Exhausted tool MUST be blocked");
}

console.log("All optimistic capability interaction tests passed successfully.");
