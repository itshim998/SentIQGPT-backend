export const CONTROLLED_RESPONSE_POLISH_VERSION = "13.1";
export const HTML_CODE_BATCH_INTERVAL_MS = 96;
export const HTML_PREVIEW_BATCH_INTERVAL_MS = 280;
export const BLOCK_REVEAL_FALLBACK_MS = 260;

const BLOCK_CLASS_HINTS = [
  "code-block-wrap",
  "katex-display",
  "math-block",
  "table-wrap",
  "websurf",
  "deep-research",
  "generated-file",
  "message-chart",
  "image-generation",
];

export function normalizeRevealBlockType(input = {}) {
  const tagName = String(input.tagName || "div").toLowerCase();
  const className = String(input.className || "").toLowerCase();
  const hintedClass = BLOCK_CLASS_HINTS.find((hint) => className.includes(hint));
  return hintedClass || tagName;
}

export function buildRevealBlockKey(input = {}) {
  const index = Math.max(0, Math.floor(Number(input.index) || 0));
  return `${index}:${normalizeRevealBlockType(input)}`;
}

export function resolveReservedMediaAspect(width, height, fallback = { width: 4, height: 3 }) {
  const sourceWidth = Number(width);
  const sourceHeight = Number(height);
  const fallbackWidth = Math.max(1, Number(fallback?.width) || 4);
  const fallbackHeight = Math.max(1, Number(fallback?.height) || 3);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return {
      width: fallbackWidth,
      height: fallbackHeight,
      cssValue: `${fallbackWidth} / ${fallbackHeight}`,
      source: "fallback",
    };
  }

  const ratio = sourceWidth / sourceHeight;
  if (ratio < 0.48 || ratio > 2.8) {
    const boundedWidth = Math.round(Math.min(2.8, Math.max(0.48, ratio)) * 1000);
    return {
      width: boundedWidth,
      height: 1000,
      cssValue: `${boundedWidth} / 1000`,
      source: "bounded",
    };
  }

  return {
    width: Math.round(sourceWidth),
    height: Math.round(sourceHeight),
    cssValue: `${Math.round(sourceWidth)} / ${Math.round(sourceHeight)}`,
    source: "intrinsic",
  };
}

export function resolveArtifactBatchDelay(kind) {
  return String(kind || "").toLowerCase() === "preview"
    ? HTML_PREVIEW_BATCH_INTERVAL_MS
    : HTML_CODE_BATCH_INTERVAL_MS;
}
