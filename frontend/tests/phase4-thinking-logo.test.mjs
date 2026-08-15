import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const progressSource = fs.readFileSync(path.join(root, "scripts/features/semantic-activity-progress.js"), "utf8");
const logoSource = fs.readFileSync(path.join(root, "scripts/features/logo-activity.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles/modules/42-semantic-activity-progress.css"), "utf8");
const logoCss = fs.readFileSync(path.join(root, "styles/modules/91-logo-activity.css"), "utf8");

assert.match(progressSource, /ACTIVITY_LOGO_VARIANTS/);
assert.match(progressSource, /thinking:\s*["']neural-orbit["']/);
assert.match(progressSource, /["']reading-files["']:\s*["']infinite-dialog["']/);
assert.match(progressSource, /["']preparing-document["']:\s*["']infinite-dialog["']/);
assert.match(progressSource, /document\.createElement\(["']sentiq-activity-logo["']\)/);
assert.match(progressSource, /setAttribute\("variant", variant\)/);
assert.match(progressSource, /setAttribute\("state", state\)/);
assert.match(progressSource, /response-inline-spinner["']\)\?\.remove/);
assert.match(progressSource, /restoreFallbackSpinner/);
assert.match(progressSource, /removeActivityLogo/);
assert.doesNotMatch(progressSource, /setInterval|progressPercent|percentage/);

assert.match(logoSource, /neural-orbit/);
assert.match(logoSource, /infinite-dialog/);
assert.match(logoCss, /sentiqActivityLogoBreathe/);
assert.match(logoCss, /sentiqActivityLogoShimmer/);
assert.match(logoCss, /-webkit-mask-image:\s*var\(--sentiq-activity-logo-asset\)/);
assert.match(logoCss, /prefers-reduced-motion/);

assert.match(css, /sentiq-logo-thinking/);
assert.match(css, /sentiq-logo-reading-files/);
assert.match(css, /sentiq-activity-mark/);
assert.match(css, /response-inline-spinner/);
assert.match(css, /display:\s*none\s*!important/);
assert.match(css, /Neural Orbit/);
assert.match(css, /Infinite Dialog/);
assert.match(
  css,
  /data-semantic-activity-state="thinking"[^}]*>\s*sentiq-activity-logo/s,
);
assert.match(
  css,
  /data-semantic-activity-state="reading-files"[^}]*>\s*sentiq-activity-logo/s,
);

console.log("Phase 4 Neural Orbit activity-logo checks passed.");
