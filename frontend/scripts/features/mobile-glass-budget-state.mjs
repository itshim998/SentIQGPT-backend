/* SentIQ Chat — Pass 10.4 mobile density and glass budget state */

export const MOBILE_GLASS_BUDGET_VERSION = "10.4";
export const MOBILE_GLASS_BREAKPOINT_PX = 768;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function isMobileGlassViewport(width) {
  return finiteNumber(width, Number.POSITIVE_INFINITY) <= MOBILE_GLASS_BREAKPOINT_PX;
}

export function deriveMobileGlassBudget(input = {}) {
  const width = finiteNumber(input.width, Number.POSITIVE_INFINITY);
  const mobile = isMobileGlassViewport(width);
  const deviceMemory = Math.max(0, finiteNumber(input.deviceMemory, 0));
  const hardwareConcurrency = Math.max(0, finiteNumber(input.hardwareConcurrency, 0));
  const devicePixelRatio = Math.max(1, finiteNumber(input.devicePixelRatio, 1));
  const saveData = Boolean(input.saveData);
  const reducedMotion = Boolean(input.reducedMotion);
  const backdropSupported = input.backdropSupported !== false;

  if (!mobile) {
    return Object.freeze({
      mobile: false,
      profile: "desktop",
      atmosphere: "full",
      blurPx: 18,
      saturationPercent: 112,
      simultaneousGlassLayers: 3,
      overlayBackdropFiltering: true,
      opaqueFallback: false,
    });
  }

  const criticallyWeak = (
    !backdropSupported
    || saveData
    || (deviceMemory > 0 && deviceMemory <= 2)
    || (hardwareConcurrency > 0 && hardwareConcurrency <= 2)
  );
  const constrained = (
    reducedMotion
    || (deviceMemory > 0 && deviceMemory <= 4)
    || (hardwareConcurrency > 0 && hardwareConcurrency <= 4)
    || devicePixelRatio >= 3
    || width <= 390
  );

  const profile = criticallyWeak ? "opaque" : (constrained ? "constrained" : "balanced");
  const profileConfig = {
    balanced: { blurPx: 8, saturationPercent: 106, atmosphere: "frozen" },
    constrained: { blurPx: 4, saturationPercent: 102, atmosphere: "simplified" },
    opaque: { blurPx: 0, saturationPercent: 100, atmosphere: "static" },
  }[profile];

  return Object.freeze({
    mobile: true,
    profile,
    atmosphere: profileConfig.atmosphere,
    blurPx: profileConfig.blurPx,
    saturationPercent: profileConfig.saturationPercent,
    simultaneousGlassLayers: profile === "balanced" ? 2 : 1,
    overlayBackdropFiltering: false,
    opaqueFallback: profile === "opaque",
  });
}

export function serializeMobileGlassBudget(state) {
  return [
    state?.mobile ? "mobile" : "desktop",
    state?.profile || "desktop",
    state?.atmosphere || "full",
    finiteNumber(state?.blurPx, 0),
    finiteNumber(state?.saturationPercent, 100),
    finiteNumber(state?.simultaneousGlassLayers, 1),
    state?.overlayBackdropFiltering ? "overlay-filter" : "overlay-solid",
    state?.opaqueFallback ? "opaque" : "translucent",
  ].join("|");
}
