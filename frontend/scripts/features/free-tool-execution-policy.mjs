/* ============================================================
   SentIQ Liquid Glass V4 — Free Tool Execution Policy Model
   Centralized execution-mode policy and upsell content for Free-plan accounts
   when tools (Visualize, WebSurf, Attach Files, Deep Research) are active.
   ============================================================ */

export const FREE_TOOL_POLICY_VERSION = "1.0";

export const RESTRICTED_TOOLS = Object.freeze({
  VISUALIZE: "visualize",
  WEBSURF: "websurf",
  ATTACH_FILES: "attach-files",
  DEEP_RESEARCH: "deep-research",
});

export const TOOL_UPSELL_COPY = Object.freeze({
  [RESTRICTED_TOOLS.VISUALIZE]: "Upgrade to Essential to unlock access to more advanced visualization models.",
  [RESTRICTED_TOOLS.WEBSURF]: "Upgrade to Essential to unlock Intuitive mode for deeper web research.",
  [RESTRICTED_TOOLS.DEEP_RESEARCH]: "Upgrade to Essential to unlock Intuitive mode for deeper research.",
  [RESTRICTED_TOOLS.ATTACH_FILES]: "Upgrade to Essential to unlock Intuitive mode for deeper file understanding.",
});

export const PAID_PLAN_CODES = Object.freeze(new Set([
  "student_core",
  "premium",
  "pro",
]));

export function normalizePlanCode(planCode) {
  return String(planCode || "").trim().toLowerCase();
}

export function isPaidPlan(planCode) {
  return PAID_PLAN_CODES.has(normalizePlanCode(planCode));
}

export function isAuthenticatedFreeAccount({ authenticated = false, planCode = "" } = {}) {
  if (!authenticated) return false;
  const normalized = normalizePlanCode(planCode);
  if (normalized === "guest") return false;
  return !isPaidPlan(normalized);
}

export function resolveActiveRestrictedTool({
  imageMode = false,
  webSearchActive = false,
  deepResearchActive = false,
  attachmentCount = 0,
} = {}) {
  if (Boolean(imageMode)) return RESTRICTED_TOOLS.VISUALIZE;
  if (Boolean(webSearchActive)) return RESTRICTED_TOOLS.WEBSURF;
  if (Boolean(deepResearchActive)) return RESTRICTED_TOOLS.DEEP_RESEARCH;
  if (Number(attachmentCount) > 0) return RESTRICTED_TOOLS.ATTACH_FILES;
  return null;
}

export function getToolUpsellCopy(tool) {
  return TOOL_UPSELL_COPY[tool] || "";
}

export function isIntuitiveLockedForTools({
  authenticated = false,
  planCode = "free",
  activeTool = null,
} = {}) {
  if (!isAuthenticatedFreeAccount({ authenticated, planCode })) {
    return false;
  }
  return Boolean(activeTool);
}

export function deriveEffectiveExecutionMode({
  preferredMode = "fast",
  toolLocked = false,
  previousEffectiveMode = "fast",
  toolJustRemoved = false,
} = {}) {
  if (toolLocked) return "fast";
  if (toolJustRemoved) return "fast";
  const normalizedPreferred = preferredMode === "intuitive" ? "intuitive" : "fast";
  // If no tool is active and no transition occurred, return previous or preferred
  return previousEffectiveMode === "fast" && normalizedPreferred !== "intuitive"
    ? "fast"
    : normalizedPreferred;
}

export function resolveFreeToolPolicyState({
  authenticated = false,
  planCode = "free",
  imageMode = false,
  webSearchActive = false,
  deepResearchActive = false,
  attachmentCount = 0,
  preferredMode = "fast",
  currentEffectiveMode = "fast",
} = {}) {
  const isFree = isAuthenticatedFreeAccount({ authenticated, planCode });
  const activeTool = isFree
    ? resolveActiveRestrictedTool({ imageMode, webSearchActive, deepResearchActive, attachmentCount })
    : null;
  const isLocked = Boolean(isFree && activeTool);
  const upsellCopy = isLocked ? getToolUpsellCopy(activeTool) : "";
  const normalizedPreferred = preferredMode === "intuitive" ? "intuitive" : "fast";

  let effectiveMode = "fast";
  if (isLocked) {
    effectiveMode = "fast";
  } else if (currentEffectiveMode === "fast") {
    effectiveMode = "fast";
  } else {
    effectiveMode = normalizedPreferred;
  }

  return Object.freeze({
    isFreeAccount: isFree,
    activeTool,
    isLocked,
    upsellCopy,
    effectiveMode,
    preferredMode: normalizedPreferred,
  });
}
