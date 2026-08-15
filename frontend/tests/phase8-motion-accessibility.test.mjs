import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const logoCss = fs.readFileSync(path.join(root, "styles/modules/91-logo-activity.css"), "utf8");
const semanticCss = fs.readFileSync(path.join(root, "styles/modules/42-semantic-activity-progress.css"), "utf8");

assert.match(logoCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(logoCss, /\.sentiq-activity-logo__breath[\s\S]*animation:\s*none\s*!important/);
assert.match(logoCss, /\.sentiq-activity-logo__shimmer[\s\S]*animation:\s*none\s*!important/);
assert.match(logoCss, /\.sentiq-activity-logo__shimmer[\s\S]*opacity:\s*0/);
assert.match(logoCss, /sentiq-activity-logo\[data-variant="infinite-dialog"\][\s\S]*animation:\s*none\s*!important/);
assert.match(logoCss, /sentiq-activity-logo\[data-variant="infinite-dialog"\][\s\S]*opacity:\s*0/);
assert.match(logoCss, /transform:\s*none/);
assert.doesNotMatch(logoCss, /prefers-reduced-motion: reduce[\s\S]*animation:\s*[^;\n]*infinite/);
assert.match(semanticCss, /@media \(prefers-reduced-motion: reduce\)/);

console.log("Phase 8 motion accessibility checks passed: activity logos become static under reduced motion.");
