/* SentIQ Chat — Pass 10.5 mobile rich-content layout state */

export const MOBILE_RICH_CONTENT_VERSION = "10.5";
export const MOBILE_RICH_BREAKPOINT_PX = 768;
export const MOBILE_RICH_LANDSCAPE_MAX_PX = 960;
export const MOBILE_RICH_LANDSCAPE_MAX_HEIGHT_PX = 520;
export const MOBILE_RICH_NARROW_PX = 390;
export const MOBILE_RICH_SHORT_PX = 560;
export const MOBILE_RICH_TALL_PX = 780;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeInset(value) {
  return Math.max(0, Math.round(finiteNumber(value, 0) * 100) / 100);
}

function normalizeOrientation(value, width, height) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("landscape")) return "landscape";
  if (normalized.includes("portrait")) return "portrait";
  return width > height ? "landscape" : "portrait";
}

export function isMobileRichViewport(width, options = {}) {
  const resolvedWidth = finiteNumber(width, Number.POSITIVE_INFINITY);
  if (resolvedWidth <= MOBILE_RICH_BREAKPOINT_PX) return true;
  const resolvedHeight = Math.max(1, finiteNumber(options.height, Number.POSITIVE_INFINITY));
  const orientation = normalizeOrientation(options.orientation, resolvedWidth, resolvedHeight);
  return Boolean(
    options.coarsePointer
    && orientation === "landscape"
    && resolvedWidth <= MOBILE_RICH_LANDSCAPE_MAX_PX
    && resolvedHeight <= MOBILE_RICH_LANDSCAPE_MAX_HEIGHT_PX
  );
}

export function deriveMobileRichLayout(input = {}) {
  const width = Math.max(1, finiteNumber(input.width, Number.POSITIVE_INFINITY));
  const height = Math.max(1, finiteNumber(input.height, Number.POSITIVE_INFINITY));
  const orientation = normalizeOrientation(input.orientation, width, height);
  const coarsePointer = Boolean(input.coarsePointer);
  const mobile = isMobileRichViewport(width, { height, orientation, coarsePointer });
  const keyboardOpen = mobile && Boolean(input.keyboardOpen);
  const safeAreaTop = normalizeInset(input.safeAreaTop);
  const safeAreaRight = normalizeInset(input.safeAreaRight);
  const safeAreaBottom = normalizeInset(input.safeAreaBottom);
  const safeAreaLeft = normalizeInset(input.safeAreaLeft);
  const notched = mobile && Math.max(safeAreaTop, safeAreaRight, safeAreaBottom, safeAreaLeft) > 0;

  if (!mobile) {
    return Object.freeze({
      mobile: false,
      widthClass: "desktop",
      heightClass: "desktop",
      orientation,
      keyboardOpen: false,
      safeAreaMode: "flat",
      safeAreaTop: 0,
      safeAreaRight: 0,
      safeAreaBottom: 0,
      safeAreaLeft: 0,
      contentInlineSize: width,
      mediaMaxHeight: height,
      chartMinInlineSize: 560,
    });
  }

  const widthClass = width <= MOBILE_RICH_NARROW_PX ? "narrow" : "regular";
  const heightClass = height <= MOBILE_RICH_SHORT_PX
    ? "short"
    : (height >= MOBILE_RICH_TALL_PX ? "tall" : "standard");
  const contentInlineSize = Math.max(240, width - safeAreaLeft - safeAreaRight);
  const mediaRatio = keyboardOpen ? 0.44 : (orientation === "landscape" ? 0.66 : (heightClass === "tall" ? 0.72 : 0.64));
  const mediaMaxHeight = Math.max(180, Math.min(620, Math.round(height * mediaRatio)));
  const chartMinInlineSize = widthClass === "narrow" ? 440 : (orientation === "landscape" ? 600 : 500);

  return Object.freeze({
    mobile: true,
    widthClass,
    heightClass,
    orientation,
    keyboardOpen,
    safeAreaMode: notched ? "notched" : "flat",
    safeAreaTop,
    safeAreaRight,
    safeAreaBottom,
    safeAreaLeft,
    contentInlineSize,
    mediaMaxHeight,
    chartMinInlineSize,
  });
}

export function serializeMobileRichLayout(state) {
  return [
    state?.mobile ? "mobile" : "desktop",
    state?.widthClass || "desktop",
    state?.heightClass || "desktop",
    state?.orientation || "portrait",
    state?.keyboardOpen ? "keyboard-open" : "keyboard-closed",
    state?.safeAreaMode || "flat",
    finiteNumber(state?.safeAreaTop, 0),
    finiteNumber(state?.safeAreaRight, 0),
    finiteNumber(state?.safeAreaBottom, 0),
    finiteNumber(state?.safeAreaLeft, 0),
  ].join("|");
}
