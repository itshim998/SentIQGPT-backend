/* SentIQ Chat — Phase 12.1 accessibility verification state */

export const ACCESSIBILITY_VERIFICATION_VERSION = "12.1";
export const ACCESSIBILITY_MIN_TOUCH_TARGET = 44;
export const ACCESSIBILITY_MIN_TEXT_CONTRAST = 4.5;
export const ACCESSIBILITY_MIN_LARGE_TEXT_CONTRAST = 3;

const ROVING_KEYS = Object.freeze([
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

export function isRovingNavigationKey(key) {
  return ROVING_KEYS.includes(String(key || ""));
}

export function nextRovingIndex({ currentIndex = 0, itemCount = 0, key = "", orientation = "both" } = {}) {
  const count = Math.max(0, Number(itemCount) || 0);
  if (!count) return -1;
  const current = Math.min(count - 1, Math.max(0, Number(currentIndex) || 0));
  const normalizedOrientation = ["horizontal", "vertical", "both"].includes(orientation)
    ? orientation
    : "both";
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const forward = key === "ArrowDown" || key === "ArrowRight";
  const backward = key === "ArrowUp" || key === "ArrowLeft";
  if (!forward && !backward) return current;
  if (normalizedOrientation === "horizontal" && ["ArrowDown", "ArrowUp"].includes(key)) return current;
  if (normalizedOrientation === "vertical" && ["ArrowLeft", "ArrowRight"].includes(key)) return current;
  return forward ? (current + 1) % count : (current - 1 + count) % count;
}

export function normalizeHexColor(value) {
  const source = String(value || "").trim();
  const short = /^#([0-9a-f]{3})$/i.exec(source);
  if (short) return `#${short[1].split("").map((part) => `${part}${part}`).join("")}`.toLowerCase();
  const full = /^#([0-9a-f]{6})$/i.exec(source);
  return full ? `#${full[1].toLowerCase()}` : "";
}

export function relativeLuminance(color) {
  const hex = normalizeHexColor(color);
  if (!hex) return Number.NaN;
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return Number.NaN;
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsContrast(foreground, background, minimum = ACCESSIBILITY_MIN_TEXT_CONTRAST) {
  const ratio = contrastRatio(foreground, background);
  return Number.isFinite(ratio) && ratio >= Math.max(1, Number(minimum) || ACCESSIBILITY_MIN_TEXT_CONTRAST);
}
