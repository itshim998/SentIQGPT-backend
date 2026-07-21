/* SentIQ Chat — Pass 11.1 motion grammar state */

export const MOTION_GRAMMAR_VERSION = "11.1";

export const MOTION_FAMILIES = Object.freeze([
  "surface",
  "layout",
  "focus",
  "progress",
  "completion",
  "interrupt",
]);

const FAMILY_SET = new Set(MOTION_FAMILIES);
const SURFACE_PHASES = new Set(["enter", "exit"]);

export function isMotionFamily(value) {
  return FAMILY_SET.has(String(value || "").trim().toLowerCase());
}

export function normalizeMotionFamily(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return FAMILY_SET.has(normalized) ? normalized : "";
}

export function normalizeMotionPhase(family, value) {
  const normalizedFamily = normalizeMotionFamily(family);
  if (normalizedFamily !== "surface") return "";
  const normalizedPhase = String(value || "").trim().toLowerCase();
  return SURFACE_PHASES.has(normalizedPhase) ? normalizedPhase : "enter";
}

export function deriveMotionPolicy(input = {}) {
  return input.prefersReducedMotion || input.slowUpdate ? "reduced" : "full";
}

export function createMotionDescriptor(family, options = {}) {
  const normalizedFamily = normalizeMotionFamily(family);
  if (!normalizedFamily) return null;
  return Object.freeze({
    family: normalizedFamily,
    phase: normalizeMotionPhase(normalizedFamily, options.phase),
    policy: deriveMotionPolicy(options),
  });
}
