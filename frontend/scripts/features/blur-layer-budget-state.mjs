/* SentIQ Chat — Pass 11.3 blur and layer budgeting state */

export const BLUR_LAYER_BUDGET_VERSION = "11.3";
export const BLUR_MOBILE_BREAKPOINT_PX = 768;
export const BLUR_TABLET_BREAKPOINT_PX = 1024;

export const BLUR_HARD_LAYER_LIMITS = Object.freeze({
  desktop: 2,
  tablet: 2,
  mobile: 1,
  static: 0,
});

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function clampBlurLayerLimit(value) {
  return Math.min(BLUR_HARD_LAYER_LIMITS.desktop, Math.max(0, Math.floor(finiteNumber(value, 0))));
}

export function deriveBlurLayerBudget(input = {}) {
  const width = Math.max(0, finiteNumber(input.width, Number.POSITIVE_INFINITY));
  const deviceMemory = Math.max(0, finiteNumber(input.deviceMemory, 0));
  const hardwareConcurrency = Math.max(0, finiteNumber(input.hardwareConcurrency, 0));
  const devicePixelRatio = Math.max(1, finiteNumber(input.devicePixelRatio, 1));
  const mobileGlassProfile = String(input.mobileGlassProfile || "").toLowerCase();
  const mobile = width <= BLUR_MOBILE_BREAKPOINT_PX;
  const tablet = !mobile && width <= BLUR_TABLET_BREAKPOINT_PX;

  const staticFallback = (
    input.backdropSupported === false
    || Boolean(input.saveData)
    || Boolean(input.reducedTransparency)
    || mobileGlassProfile === "opaque"
    || (deviceMemory > 0 && deviceMemory <= 2)
    || (hardwareConcurrency > 0 && hardwareConcurrency <= 2)
  );

  const constrained = !staticFallback && (
    Boolean(input.reducedMotion)
    || mobileGlassProfile === "constrained"
    || (deviceMemory > 0 && deviceMemory <= 4)
    || (hardwareConcurrency > 0 && hardwareConcurrency <= 4)
    || devicePixelRatio >= 3
    || width <= 390
  );

  if (staticFallback) {
    return Object.freeze({
      profile: "static",
      viewport: mobile ? "mobile" : (tablet ? "tablet" : "desktop"),
      maxLayers: BLUR_HARD_LAYER_LIMITS.static,
      blurPx: 0,
      saturationPercent: 100,
      nestedFullStrengthAllowed: false,
      staticFallback: true,
    });
  }

  if (mobile) {
    return Object.freeze({
      profile: constrained ? "constrained" : "balanced",
      viewport: "mobile",
      maxLayers: BLUR_HARD_LAYER_LIMITS.mobile,
      blurPx: constrained ? 4 : 6,
      saturationPercent: constrained ? 102 : 106,
      nestedFullStrengthAllowed: false,
      staticFallback: false,
    });
  }

  if (tablet) {
    return Object.freeze({
      profile: constrained ? "constrained" : "balanced",
      viewport: "tablet",
      maxLayers: constrained ? 1 : BLUR_HARD_LAYER_LIMITS.tablet,
      blurPx: constrained ? 6 : 10,
      saturationPercent: constrained ? 104 : 108,
      nestedFullStrengthAllowed: false,
      staticFallback: false,
    });
  }

  return Object.freeze({
    profile: constrained ? "constrained" : "full",
    viewport: "desktop",
    maxLayers: constrained ? 1 : BLUR_HARD_LAYER_LIMITS.desktop,
    blurPx: constrained ? 8 : 14,
    saturationPercent: constrained ? 106 : 112,
    nestedFullStrengthAllowed: false,
    staticFallback: false,
  });
}

export function selectBlurLayerSlots(candidates = [], maxLayers = 0) {
  const limit = clampBlurLayerLimit(maxLayers);
  return Object.freeze(candidates
    .filter((candidate) => candidate && candidate.visible !== false && !candidate.nested)
    .sort((left, right) => {
      const priorityDelta = finiteNumber(right.priority, 0) - finiteNumber(left.priority, 0);
      if (priorityDelta) return priorityDelta;
      return finiteNumber(left.order, 0) - finiteNumber(right.order, 0);
    })
    .slice(0, limit)
    .map((candidate) => String(candidate.id)));
}

export function serializeBlurLayerBudget(state = {}) {
  return [
    BLUR_LAYER_BUDGET_VERSION,
    state.profile || "static",
    state.viewport || "desktop",
    clampBlurLayerLimit(state.maxLayers),
    Math.max(0, finiteNumber(state.blurPx, 0)),
    Math.max(100, finiteNumber(state.saturationPercent, 100)),
    state.staticFallback ? "static" : "filtered",
  ].join("|");
}
