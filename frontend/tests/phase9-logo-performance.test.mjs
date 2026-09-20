import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "..");
const logoCss = fs.readFileSync(path.join(root, "styles/modules/91-logo-activity.css"), "utf8");
const compositorState = fs.readFileSync(path.join(root, "scripts/features/compositor-safety-state.mjs"), "utf8");
const compositorRuntime = fs.readFileSync(path.join(root, "scripts/features/compositor-safety.js"), "utf8");
const motionRuntime = fs.readFileSync(path.join(root, "scripts/features/motion-grammar.js"), "utf8");

assert.match(logoCss, /will-change:\s*opacity, transform/);
assert.match(logoCss, /will-change:\s*transform/);
assert.match(logoCss, /translate3d\(/);
assert.doesNotMatch(logoCss, /@keyframes[^{]+\{[^}]*?background-position\s*:/);
assert.doesNotMatch(logoCss, /@keyframes[^{]+\{[^}]*?background-size\s*:/);
assert.doesNotMatch(logoCss, /@keyframes[^{]+\{[^}]*?\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
assert.doesNotMatch(logoCss, /@keyframes[^{]+\{[^}]*?filter\s*:/);

assert.match(compositorState, /COMPOSITOR_SAFE_PROPERTIES/);
assert.match(compositorState, /"transform"/);
assert.match(compositorState, /"opacity"/);
assert.match(compositorState, /COMPOSITOR_FORBIDDEN_CONTINUOUS_PROPERTIES/);
assert.match(compositorState, /"background-position"/);
assert.match(compositorState, /"background-size"/);
assert.match(compositorRuntime, /dataset\.sentiqCompositorPolicy/);
assert.match(motionRuntime, /dataset\.sentiqMotionPolicy/);

assert.match(logoCss, /data-sentiq-compositor-policy="reduced"/);
assert.match(logoCss, /animation:\s*none\s*!important/);

console.log("Phase 9 logo performance checks passed: continuous activity-logo motion is transform/opacity driven and integrates with compositor policy.");
