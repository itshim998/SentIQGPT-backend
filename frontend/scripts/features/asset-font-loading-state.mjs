/* SentIQ Chat — Pass 11.6 asset and font loading policy */

export const ASSET_FONT_LOADING_VERSION = "11.6";

export const FONT_LOADING_POLICY = Object.freeze({
  family: "Inter",
  minimumWeight: 300,
  maximumWeight: 700,
  display: "swap",
  preloadRemoteFontFile: false,
});

export const IMAGE_PROFILES = Object.freeze([
  Object.freeze({ selector: ".websurf-v2-favicon", width: 14, height: 14, reserve: "square", fit: "contain" }),
  Object.freeze({ selector: ".websurf-v2-presentation-favicon", width: 16, height: 16, reserve: "square", fit: "contain" }),
  Object.freeze({ selector: ".websurf-v2-source-explorer-favicon", width: 16, height: 16, reserve: "square", fit: "contain" }),
  Object.freeze({ selector: ".websurf-v2-explorer-favicon", width: 16, height: 16, reserve: "square", fit: "contain" }),
  Object.freeze({ selector: ".websurf-v2-thumbnail", width: 78, height: 58, reserve: "thumbnail", fit: "cover" }),
  Object.freeze({ selector: ".websurf-v2-featured-media img", width: 640, height: 280, reserve: "featured", fit: "cover" }),
  Object.freeze({ selector: ".web-search-image-tile img", width: 320, height: 180, reserve: "wide", fit: "cover" }),
  Object.freeze({ selector: ".web-search-image-row img", width: 160, height: 90, reserve: "wide", fit: "cover" }),
  Object.freeze({ selector: ".message-chart-image", width: 0, height: 0, reserve: "chart", fit: "contain" }),
  Object.freeze({ selector: ".message-image", width: 0, height: 0, reserve: "generated", fit: "contain" }),
]);

function number(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : 0;
}

export function normalizeIntrinsicDimensions(input = {}) {
  const explicitWidth = number(input.width);
  const explicitHeight = number(input.height);
  if (explicitWidth && explicitHeight) {
    return Object.freeze({ width: Math.round(explicitWidth), height: Math.round(explicitHeight), source: "explicit" });
  }

  const naturalWidth = number(input.naturalWidth);
  const naturalHeight = number(input.naturalHeight);
  if (naturalWidth && naturalHeight) {
    return Object.freeze({ width: Math.round(naturalWidth), height: Math.round(naturalHeight), source: "natural" });
  }

  const profileWidth = number(input.profileWidth);
  const profileHeight = number(input.profileHeight);
  if (profileWidth && profileHeight) {
    return Object.freeze({ width: Math.round(profileWidth), height: Math.round(profileHeight), source: "profile" });
  }

  return Object.freeze({ width: 0, height: 0, source: "unknown" });
}

export function deriveImageLoadingPolicy(input = {}) {
  const critical = Boolean(input.critical);
  const latest = Boolean(input.latest);
  const visible = Boolean(input.visible);
  const longConversationManaged = Boolean(input.longConversationManaged);
  const eager = critical || latest || visible;
  return Object.freeze({
    loading: eager ? "eager" : "lazy",
    decoding: "async",
    fetchPriority: critical || latest ? "high" : (visible ? "auto" : "low"),
    managedByLongConversation: longConversationManaged,
  });
}

export function deriveImageReservation(input = {}) {
  const dimensions = normalizeIntrinsicDimensions(input);
  const reserve = String(input.reserve || "auto").trim().toLowerCase() || "auto";
  const ratio = dimensions.width && dimensions.height
    ? dimensions.width / dimensions.height
    : 0;
  return Object.freeze({
    ...dimensions,
    reserve,
    ratio,
    cssRatio: ratio > 0 ? `${dimensions.width} / ${dimensions.height}` : "",
  });
}

export function findImageProfile(matches = () => false) {
  const profile = IMAGE_PROFILES.find((candidate) => matches(candidate.selector));
  return profile || Object.freeze({ selector: "", width: 0, height: 0, reserve: "auto", fit: "contain" });
}

export function shouldPreloadAsset(input = {}) {
  const kind = String(input.kind || "").toLowerCase();
  if (kind === "module" || kind === "critical-style") return true;
  if (kind === "remote-font-file") return false;
  return Boolean(input.critical && input.local);
}
