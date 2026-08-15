import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const css = fs.readFileSync(path.join(root, "styles/modules/91-logo-activity.css"), "utf8");

for (const token of [
  "--sentiq-activity-logo-geometry-filter",
  "--sentiq-activity-logo-breath-color",
  "--sentiq-activity-logo-shimmer-gradient",
  "--sentiq-activity-logo-shimmer-shadow",
]) {
  assert.match(css, new RegExp(token.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `Missing theme token ${token}`);
}

for (const selector of [
  'html[data-theme="light"] .sentiq-activity-logo',
  'html[data-color-scheme="light"] .sentiq-activity-logo',
  'html.theme-light .sentiq-activity-logo',
]) {
  assert.match(css, new RegExp(selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")), `Missing light-theme selector ${selector}`);
}

assert.match(css, /brightness\(0\.2\) contrast\(1\.08\)/, "Light mode should turn the white SVG geometry into dark graphite.");
assert.match(css, /rgba\(12, 14, 18, 0\.96\)/, "Light mode shimmer should use dark graphite/charcoal highlights.");
assert.match(css, /rgba\(10, 12, 16, 0\.96\)/, "Light Infinite Dialog shimmer should use the darker dialogue highlight.");
assert.doesNotMatch(css, /sentiqlogo-neural-dialog\.light|sentiqlogo-neural-orbit\.light|sentiqlogo-infinite-dialog\.light/, "Phase 7 must not introduce separate light logo assets.");
assert.match(css, /-webkit-mask-image:\s*var\(--sentiq-activity-logo-asset\)/, "Theme-aware effects must remain clipped to the same SVG geometry.");
assert.match(css, /mask-image:\s*var\(--sentiq-activity-logo-asset\)/, "Theme-aware effects must remain clipped to the same SVG geometry.");

console.log("Phase 7 logo theme checks passed.");
