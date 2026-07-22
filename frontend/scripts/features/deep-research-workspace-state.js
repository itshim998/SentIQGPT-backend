/* SentIQ Liquid Glass V4 — Phase 7.2 Deep Research state helpers */

export const DEEP_RESEARCH_WORKSPACE_VERSION = "7.2";
export const DEEP_RESEARCH_STAGES = Object.freeze([
  { id: "scope", label: "Scope" },
  { id: "sources", label: "Sources" },
  { id: "synthesis", label: "Synthesis" },
]);

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function clampDeepResearchPercent(value) {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
}

export function normalizeDeepResearchStage(profile = {}) {
  const status = clean(profile.status).toLowerCase();
  const phase = clean(profile.phase || profile.progressPhase).toLowerCase();
  const text = clean(profile.statusText || profile.latestStatusText).toLowerCase();
  const percent = clampDeepResearchPercent(profile.percent ?? profile.progressPercent);
  if (status === "completed") return "complete";
  if (/synth|writ|report|draft|final/.test(`${phase} ${text}`) || percent >= 70) return "synthesis";
  if (/search|source|retriev|browse|found/.test(`${phase} ${text}`) || percent >= 20) return "sources";
  return "scope";
}

export function getDeepResearchStageStates(stage, status = "running") {
  const terminal = clean(status).toLowerCase();
  const normalized = DEEP_RESEARCH_STAGES.some((item) => item.id === stage)
    ? stage
    : stage === "complete" ? "complete" : "scope";
  const states = {};
  if (terminal === "completed" || normalized === "complete") {
    DEEP_RESEARCH_STAGES.forEach(({ id }) => { states[id] = "complete"; });
    return states;
  }
  const active = Math.max(0, DEEP_RESEARCH_STAGES.findIndex(({ id }) => id === normalized));
  DEEP_RESEARCH_STAGES.forEach(({ id }, index) => {
    states[id] = index < active
      ? "complete"
      : index === active
        ? (["cancelled", "failed"].includes(terminal) ? "paused" : "active")
        : "pending";
  });
  return states;
}

export function estimateDeepResearchReadMinutes(value, wordsPerMinute = 220) {
  const words = clean(value).split(" ").filter(Boolean).length;
  return words ? Math.max(1, Math.ceil(words / Math.max(120, Number(wordsPerMinute) || 220))) : 0;
}

export function buildDeepResearchDisclosureKey(reportId, title = "") {
  const stable = clean(reportId || title || "research")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "research";
  return `sentiq_deep_research_details:${stable}`;
}

export function cleanDeepResearchText(value) {
  return clean(value);
}
