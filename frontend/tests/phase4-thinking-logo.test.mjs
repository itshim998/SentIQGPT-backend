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
assert.match(progressSource, /variant["'],\s*variant/);
assert.match(progressSource, /state["'],\s*state/);
assert.match(progressSource, /response-inline-spinner["']\)\?\.remove/);
assert.doesNotMatch(progressSource, /responseInlineSpin|animation\s*:\s*.*spin/);

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
assert.match(css, /neural orbit/);
assert.match(css, /infinite dialog/);
assert.doesNotMatch(css, /rotate\(/i);

console.log("Phase 4 Neural Orbit activity-logo checks passed.");
