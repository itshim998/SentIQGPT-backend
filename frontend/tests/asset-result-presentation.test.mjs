import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSET_RESULT_VERSION,
  estimateTextBytes,
  formatAssetBytes,
  getGeneratedFileTypeLabel,
  isAssetFailureMessage,
} from "../scripts/features/asset-result-state.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const orchestrator = read("frontend/scripts/features/asset-result-presentation.js");
const image = read("frontend/scripts/features/image-result-presentation.js");
const chart = read("frontend/scripts/features/chart-result-presentation.js");
const file = read("frontend/scripts/features/generated-file-result-presentation.js");
const domRefs = read("frontend/scripts/features/chat/dom-refs.js");
const foundation = read("frontend/styles/modules/39-asset-result-foundation.css");
const mediaCss = read("frontend/styles/modules/40-image-chart-results.css");
const fileCss = read("frontend/styles/modules/41-generated-file-results.css");
const imports = read("frontend/styles/modules/12-reduced-motion.css");

assert.equal(ASSET_RESULT_VERSION, "7.3");
assert.equal(formatAssetBytes(1024), "1 KB");
assert.equal(formatAssetBytes(1536), "1.5 KB");
assert.equal(formatAssetBytes(0), "Size unavailable");
assert.equal(getGeneratedFileTypeLabel("pptx"), "PowerPoint presentation");
assert.ok(estimateTextBytes("SentIQ") >= 6);
assert.equal(isAssetFailureMessage({ textContent: "Chart failed to render." }), true);
assert.equal(isAssetFailureMessage({ textContent: "Ordinary assistant response." }), false);

assert.match(domRefs, /import "\.\.\/asset-result-presentation\.js";/);
assert.match(imports, /39-asset-result-foundation\.css/);
assert.match(imports, /40-image-chart-results\.css/);
assert.match(imports, /41-generated-file-results\.css/);

assert.match(orchestrator, /MutationObserver/);
assert.match(orchestrator, /pendingSurfaces/);
assert.match(orchestrator, /pendingMessages/);
assert.match(orchestrator, /attributeFilter: \["src", "disabled"\]/);
assert.doesNotMatch(orchestrator, /attributeFilter:[^\n]*"class"/);
assert.match(orchestrator, /enhanceImageResult/);
assert.match(orchestrator, /enhanceChartResult/);
assert.match(orchestrator, /enhanceGeneratedFileResult/);

assert.match(image, /asset-image-overlay/);
assert.match(image, /Open image viewer/);
assert.match(image, /Retry image/);
assert.match(image, /assetImageSource/);
assert.match(chart, /asset-chart-legend/);
assert.match(chart, /Export chart as PNG/);
assert.match(chart, /asset-chart-status/);
assert.match(chart, /assetChartImageSource/);
assert.match(chart, /\[0, 260, 760, 1500\]/);
assert.match(chart, /Retry chart/);
assert.match(file, /asset-file-metadata/);
assert.match(file, /getGeneratedFileTypeLabel/);
assert.match(file, /Size unavailable/);
assert.match(file, /is-primary/);

assert.match(foundation, /asset-request-failure/);
assert.match(foundation, /assetResultSweep/);
assert.match(mediaCss, /image-generation-pending-layer/);
assert.match(mediaCss, /message-chart-container\.is-loading/);
assert.match(mediaCss, /asset-chart-status\.is-error/);
assert.match(fileCss, /asset-file-skeleton/);
assert.match(fileCss, /min-height: 44px/);
assert.match(fileCss, /prefers-reduced-motion/);
assert.match(fileCss, /forced-colors/);

for (const source of [orchestrator, image, chart, file]) {
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bSentIQAPI\b|\bwindow\.SentIQAPI\b/);
  assert.doesNotMatch(source, /persistChatMessage|Storage\.|startImage|startChart|generateFile/);
}
for (const source of [foundation, mediaCss, fileCss]) {
  assert.doesNotMatch(source, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);
}

console.log("Pass 7.3 asset result presentation checks passed.");
