/* ============================================================
   SentIQ Liquid Glass V4 — Free Tool Execution Policy Runtime
   Central coordinator for Free-plan tool execution locks and upgrade affordance.
   ============================================================ */

import {
  FREE_TOOL_POLICY_VERSION,
  RESTRICTED_TOOLS,
  TOOL_UPSELL_COPY,
  PAID_PLAN_CODES,
  PLAN_DISPLAY_NAMES,
  getPlanDisplayName,
  isExplicitFreePlan,
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

export function triggerUpgradeCTA(reason = "execution_mode_upsell") {
  if (typeof window.SentIQBilling?.open === "function") {
    window.SentIQBilling.open();
  } else {
    window.dispatchEvent(new CustomEvent("sentiq:open-billing", { detail: { reason } }));
  }
  const control = getControlElement();
  if (control?.classList.contains("open")) {
    document.getElementById("execution-mode-toggle")?.click();
  }
}

function handleUpgradeClick(event) {
  const btn = event.target instanceof Element
    ? event.target.closest("#execution-mode-upgrade-btn")
    : null;
  if (!btn) return;
  event.preventDefault();
  triggerUpgradeCTA("execution_mode_upgrade_btn");
}

if (typeof document !== "undefined") {
  document.addEventListener("click", handleUpgradeClick, true);
}

export const SentIQFreeToolPolicy = Object.freeze({
  version: FREE_TOOL_POLICY_VERSION,
  RESTRICTED_TOOLS,
  TOOL_UPSELL_COPY,
  PAID_PLAN_CODES,
  PLAN_DISPLAY_NAMES,
  getPlanDisplayName,
  isExplicitFreePlan,
  isPaidPlan,
  isAuthenticatedFreeAccount,
  resolveActiveRestrictedTool,
  getToolUpsellCopy,
  isIntuitiveLockedForTools,
  deriveEffectiveExecutionMode,
  resolveFreeToolPolicyState,
  isLocked: isFreeToolLocked,
  triggerUpgradeCTA,
});

if (typeof window !== "undefined") {
  window.SentIQFreeToolPolicy = SentIQFreeToolPolicy;
}
