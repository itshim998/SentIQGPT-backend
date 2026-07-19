import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleSource = readFileSync(resolve(root, "frontend/scripts/features/message-action-behaviour.js"), "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/33-message-actions.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");

assert.match(domRefs, /import "\.\.\/message-action-behaviour\.js";/);
assert.match(imports, /@import url\("\.\/33-message-actions\.css"\);/);

assert.match(moduleSource, /MOBILE_ACTIONS_QUERY/);
assert.match(moduleSource, /message-actions-trigger/);
assert.match(moduleSource, /aria-expanded/);
assert.match(moduleSource, /aria-controls/);
assert.match(moduleSource, /role", "toolbar"/);
assert.match(moduleSource, /Response actions/);
assert.match(moduleSource, /pointerdown/);
assert.match(moduleSource, /event\.key !== "Escape"/);
assert.match(moduleSource, /ArrowLeft/);
assert.match(moduleSource, /ArrowRight/);
assert.match(moduleSource, /control\.hasAttribute\("aria-label"\)/);
assert.match(moduleSource, /requestAnimationFrame/);
assert.match(moduleSource, /new MutationObserver/);
assert.match(moduleSource, /data-message-action-original-tabindex/);
assert.match(moduleSource, /image-frame-download-btn/);
assert.match(moduleSource, /deep-research-report-actions/);
assert.match(moduleSource, /generated-file-panel/);
assert.doesNotMatch(moduleSource, /fetch\(|XMLHttpRequest|SentIQAPI|persistChatMessage|localStorage|sessionStorage|cloneNode/);

assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) and \(min-width: 769px\)/);
assert.match(css, /:hover > \.message-action-bar/);
assert.match(css, /:focus-within > \.message-action-bar/);
assert.match(css, /@media \(hover: none\), \(pointer: coarse\), \(max-width: 768px\)/);
assert.match(css, /data-message-actions-open="true"/);
assert.match(css, /\.message-actions-trigger\s*\{[\s\S]*width: 44px;[\s\S]*height: 44px;/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /@media \(forced-colors: active\)/);
assert.doesNotMatch(css, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);

console.log("Message action behaviour regression checks passed.");
