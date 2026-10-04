/* ============================================================
   SentIQ Liquid Glass V4 — Free Tool Execution Policy Runtime
   Central coordinator for Free-plan tool execution locks and upgrade affordance.
   ============================================================ */

import {
  FREE_TOOL_POLICY_VERSION,
  RESTRICTED_TOOLS,
  TOOL_UPSELL_COPY,
  PAID_PLAN_CODES,
  isPaidPlan,
  isAuthenticatedFreeAccount,
  resolveActiveRestrictedTool,
  getToolUpsellCopy,
  isIntuitiveLockedForTools,
  deriveEffectiveExecutionMode,
  resolveFreeToolPolicyState,
} from "./free-tool-execution-policy.mjs";

function getControlElement() {
  return document.getElementById("execution-mode-control");
}

function getIntuitiveOption() {
  return document.querySelector('[data-execution-mode="intuitive"]');
}

export function isFreeToolLocked() {
  const control = getControlElement();
  const intuitive = getIntuitiveOption();
  return Boolean(
    control?.classList.contains("tool-fast-locked")
    || intuitive?.classList.contains("is-tool-locked")
    || control?.dataset?.toolLocked === "true"
  );
}

function handleUpgradeClick(event) {
  const btn = event.target instanceof Element
    ? event.target.closest("#execution-mode-upgrade-btn")
    : null;
  if (!btn) return;
  event.preventDefault();
  if (typeof window.SentIQBilling?.open === "function") {
    window.SentIQBilling.open();
  }
  const control = getControlElement();
  if (control?.classList.contains("open")) {
    document.getElementById("execution-mode-toggle")?.click();
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", handleUpgradeClick, true);
}

export const SentIQFreeToolPolicy = Object.freeze({
  version: FREE_TOOL_POLICY_VERSION,
  RESTRICTED_TOOLS,
  TOOL_UPSELL_COPY,
  PAID_PLAN_CODES,
  isPaidPlan,
  isAuthenticatedFreeAccount,
  resolveActiveRestrictedTool,
  getToolUpsellCopy,
  isIntuitiveLockedForTools,
  deriveEffectiveExecutionMode,
  resolveFreeToolPolicyState,
  isLocked: isFreeToolLocked,
});

if (typeof window !== "undefined") {
  window.SentIQFreeToolPolicy = SentIQFreeToolPolicy;
}
