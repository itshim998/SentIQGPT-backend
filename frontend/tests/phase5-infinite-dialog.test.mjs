import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const progressSource = fs.readFileSync(path.join(root, "scripts/features/semantic-activity-progress.js"), "utf8");
const logoCss = fs.readFileSync(path.join(root, "styles/modules/91-logo-activity.css"), "utf8");
const logoSource = fs.readFileSync(path.join(root, "scripts/features/logo-activity.js"), "utf8");

assert.match(progressSource, /["']reading-files["']:\s*["']infinite-dialog["']/);
assert.match(progressSource, /["']preparing-document["']:\s*["']infinite-dialog["']/);
assert.match(progressSource, /document\.createElement\(["']sentiq-activity-logo["']\)/);

assert.match(logoSource, /infinite-dialog/);
assert.match(logoSource, /reading-files/);
assert.match(logoCss, /data-variant=["']infinite-dialog["']/);
assert.match(logoCss, /sentiqActivityDialogBreath/);
assert.match(logoCss, /sentiqActivityDialogLoop/);
assert.match(logoCss, /background-position: -62% 0/);
assert.match(logoCss, /background-position: 104% 0/);
assert.match(logoCss, /animation: sentiqActivityDialogLoop 3\.6s/);
assert.match(logoCss, /animation: sentiqActivityDialogBreath 3\.6s/);
assert.doesNotMatch(logoCss, /animation[^;]*rotate/i);
assert.doesNotMatch(logoCss, /sentiqActivityDialogLoop[\s\S]*rotate\(/i);
assert.match(logoCss, /prefers-reduced-motion/);

console.log("Phase 5 Infinite Dialog motion checks passed.");
