import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ASSET_FONT_LOADING_VERSION,
  FONT_LOADING_POLICY,
  deriveImageLoadingPolicy,
  deriveImageReservation,
  findImageProfile,
  normalizeIntrinsicDimensions,
  shouldPreloadAsset,
} from "../scripts/features/asset-font-loading-state.mjs";

assert.equal(ASSET_FONT_LOADING_VERSION, "11.6");
assert.deepEqual(FONT_LOADING_POLICY, {
  family: "Inter",
  minimumWeight: 300,
  maximumWeight: 700,
  display: "swap",
  preloadRemoteFontFile: false,
});

assert.deepEqual(normalizeIntrinsicDimensions({ width: 78, height: 58 }), {
  width: 78,
  height: 58,
  source: "explicit",
});
assert.deepEqual(normalizeIntrinsicDimensions({ naturalWidth: 1024, naturalHeight: 768 }), {
  width: 1024,
  height: 768,
  source: "natural",
});
assert.deepEqual(normalizeIntrinsicDimensions({ profileWidth: 16, profileHeight: 16 }), {
  width: 16,
  height: 16,
  source: "profile",
});
assert.deepEqual(normalizeIntrinsicDimensions({}), {
  width: 0,
  height: 0,
  source: "unknown",
});

assert.deepEqual(deriveImageLoadingPolicy({
  critical: false,
  latest: false,
  visible: false,
  longConversationManaged: false,
}), {
  loading: "lazy",
  decoding: "async",
  fetchPriority: "low",
  managedByLongConversation: false,
});
assert.deepEqual(deriveImageLoadingPolicy({ latest: true, longConversationManaged: true }), {
  loading: "eager",
  decoding: "async",
  fetchPriority: "high",
  managedByLongConversation: true,
});
assert.deepEqual(deriveImageLoadingPolicy({ visible: true }), {
  loading: "eager",
  decoding: "async",
  fetchPriority: "auto",
  managedByLongConversation: false,
});

assert.deepEqual(deriveImageReservation({
  profileWidth: 640,
  profileHeight: 280,
  reserve: "featured",
}), {
  width: 640,
  height: 280,
  source: "profile",
  reserve: "featured",
  ratio: 640 / 280,
  cssRatio: "640 / 280",
});
assert.equal(deriveImageReservation({ reserve: "generated" }).cssRatio, "");
assert.equal(findImageProfile((selector) => selector === ".websurf-v2-thumbnail").reserve, "thumbnail");
assert.equal(findImageProfile(() => false).reserve, "auto");

assert.equal(shouldPreloadAsset({ kind: "module" }), true);
assert.equal(shouldPreloadAsset({ kind: "critical-style" }), true);
assert.equal(shouldPreloadAsset({ kind: "remote-font-file", critical: true }), false);
assert.equal(shouldPreloadAsset({ kind: "image", critical: true, local: true }), true);
assert.equal(shouldPreloadAsset({ kind: "image", critical: false, local: true }), false);

const runtimeSource = await readFile(new URL("../scripts/features/asset-font-loading.js", import.meta.url), "utf8");
const bootstrapSource = await readFile(new URL("../scripts/bootstrap-guard.js", import.meta.url), "utf8");
const spriteSource = await readFile(new URL("../scripts/features/ui-icon-sprite.js", import.meta.url), "utf8");
const imagePresentationSource = await readFile(new URL("../scripts/features/image-result-presentation.js", import.meta.url), "utf8");
const chartPresentationSource = await readFile(new URL("../scripts/features/chart-result-presentation.js", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/77-asset-font-loading.css", import.meta.url), "utf8");
const cssImportsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const htaccessSource = await readFile(new URL("../.htaccess", import.meta.url), "utf8");
const markSource = await readFile(new URL("../assets/sentiq-chat-mark.svg", import.meta.url), "utf8");

for (const token of [
  "new MutationObserver",
  "document.fonts.ready",
  "const fontSet = document.fonts",
  "fontSet.check",
  "isInVisualViewport",
  "getBoundingClientRect",
  "window.visualViewport?.width",
  'image.decoding = policy.decoding',
  'image.loading = policy.loading',
  'setAttribute(image, "fetchpriority", policy.fetchPriority)',
  "deriveImageReservation",
  "scheduleScrollAnchor",
  "window.SentIQAssetFontLoading = Object.freeze",
  "return frame instanceof HTMLElement ? frame : null",
]) assert.ok(runtimeSource.includes(token), `Runtime missing ${token}`);

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "innerHTML = image"]) {
  assert.equal(runtimeSource.includes(forbidden), false, `Asset runtime must not own ${forbidden}`);
}

for (const token of [
  "assets/sentiq-chat-mark.svg",
  "Inter:wght@300..700&display=swap",
  'rel: "modulepreload"',
  'href: "scripts/main.js"',
  'fetchpriority: "high"',
  'link[rel="shortcut icon"]',
  "data-font-request",
]) assert.ok(bootstrapSource.includes(token), `Head bootstrap missing ${token}`);
assert.equal(bootstrapSource.includes("Inter:wght@300;400;500;600;700"), false);
assert.equal(bootstrapSource.includes("i.ibb.co"), false);

for (const token of [
  "sentiq-ui-icon-sprite",
  'createElementNS(SVG_NS, "symbol")',
  "createElementNS",
  'createUiIcon("zoom-in"',
  'createUiIcon("download"',
]) {
  const aggregate = `${spriteSource}\n${imagePresentationSource}\n${chartPresentationSource}`;
  assert.ok(aggregate.includes(token), `SVG reuse missing ${token}`);
}
assert.equal(imagePresentationSource.includes("const ZOOM_ICON"), false);
assert.equal(chartPresentationSource.includes("const EXPORT_ICON"), false);
assert.ok(chartPresentationSource.includes('image.loading = "lazy"'));
assert.ok(chartPresentationSource.includes('image.decoding = "async"'));

for (const token of [
  "@font-face",
  'font-family: "Inter Fallback"',
  "size-adjust: 107.06%",
  "ascent-override: 90.44%",
  "descent-override: 22.52%",
  'data-asset-reserve="generated"',
  'data-asset-reserve="chart"',
  "contain-intrinsic-size",
  "aspect-ratio: auto",
]) assert.ok(cssSource.includes(token), `Asset CSS missing ${token}`);
assert.equal(cssSource.includes('html[data-font-load-state="loading"]'), false,
  "Font loading must not temporarily change line wrapping");

assert.ok(cssImportsSource.includes('@import url("./77-asset-font-loading.css");'));
const longConversationImport = domRefsSource.indexOf('import "../long-conversation-optimizer.js";');
const assetLoadingImport = domRefsSource.indexOf('import "../asset-font-loading.js";');
const mobileNavigationImport = domRefsSource.indexOf('import "../mobile-navigation.js";');
assert.ok(longConversationImport >= 0 && assetLoadingImport > longConversationImport && mobileNavigationImport > assetLoadingImport,
  "Asset loading must initialize after long-conversation policy and before mobile navigation");

assert.ok(htaccessSource.includes('AddType image/svg+xml .svg'));
assert.ok(htaccessSource.includes('\\.(html|css|m?js)$'));
assert.ok(htaccessSource.includes('max-age=604800'));
assert.ok(htaccessSource.includes('max-age=2592000'));
assert.ok(markSource.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
assert.ok(markSource.includes("sentiq-mark-gradient"));
assert.equal(markSource.includes("http://"), true, "SVG namespace is expected");
assert.equal(markSource.includes("https://"), false, "Local mark must not depend on remote assets");

console.log("Pass 11.6 asset and font loading gate passed: variable font weights, conservative preloads, reusable SVG symbols, local brand assets, intrinsic media reservations, lazy decoding, cache policy, and layout-shift prevention are covered.");
