import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleSource = readFileSync(resolve(root, "frontend/scripts/features/compact-user-messages.js"), "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/31-compact-user-messages.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");

assert.match(domRefs, /import "\.\.\/compact-user-messages\.js";/);
assert.match(imports, /@import url\("\.\/31-compact-user-messages\.css"\);/);

assert.match(moduleSource, /sendButton\?\.addEventListener\("click", capturePendingSelectedContext, true\)/);
assert.match(moduleSource, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing/);
assert.match(moduleSource, /new MutationObserver/);
assert.match(moduleSource, /data\.compactUserMessageVersion|dataset\.compactUserMessageVersion/);
assert.match(moduleSource, /user-selected-context-indicator/);
assert.match(moduleSource, /clearSelectedContext\?\.addEventListener/);
assert.doesNotMatch(moduleSource, /fetch\(|XMLHttpRequest|SentIQAPI|persistChatMessage|localStorage|sessionStorage/);

assert.match(css, /\.message\.user\s*\{[\s\S]*width: fit-content;[\s\S]*max-width:/);
assert.match(css, /\.message\.user > \.message-header\s*\{[\s\S]*clip-path: inset\(50%\);/);
assert.match(css, /margin:[\s\S]*auto;/);
assert.match(css, /\.message\.user \.message-attachment-list/);
assert.match(css, /\.user-selected-context-indicator/);
assert.match(css, /@media \(max-width: 480px\)/);
assert.match(css, /@media \(forced-colors: active\)/);
assert.doesNotMatch(css, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);

console.log("Compact user-message regression checks passed.");
