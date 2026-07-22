/* SentIQ Chat — Pass 11.2 compositor-safe transition state */

export const COMPOSITOR_SAFETY_VERSION = "11.2";

export const COMPOSITOR_SAFE_PROPERTIES = Object.freeze([
  "transform",
  "opacity",
]);

export const COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES = Object.freeze([
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin",
  "padding",
  "box-shadow",
  "filter",
  "backdrop-filter",
  "background-position",
  "background-size",
]);

const SAFE_PROPERTY_SET = new Set(COMPOSITOR_SAFE_PROPERTIES);

export function clampUnitInterval(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, numeric));
}

export function toCompositorProgressScale(percent) {
  return clampUnitInterval(Number(percent) / 100);
}

export function normalizeCompositorProperties(properties) {
  const source = Array.isArray(properties)
    ? properties
    : String(properties || "").split(",");
  return Object.freeze(source
    .map((property) => String(property || "").trim().toLowerCase())
    .filter((property, index, list) => SAFE_PROPERTY_SET.has(property) && list.indexOf(property) === index));
}

export function deriveCompositorPolicy(input = {}) {
  return input.prefersReducedMotion || input.slowUpdate || input.saveData
    ? "reduced"
    : "full";
}
