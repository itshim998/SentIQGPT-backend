import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const moduleSource = readFileSync(resolve(root, "frontend/scripts/features/identity-metadata.js"), "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/32-identity-metadata.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");

assert.match(domRefs, /import "\.\.\/identity-metadata\.js";/);
assert.match(imports, /@import url\("\.\/32-identity-metadata\.css"\);/);

assert.match(moduleSource, /mode: "implicit"/);
assert.match(moduleSource, /mode: "compact"/);
assert.match(moduleSource, /System notice/);
assert.match(moduleSource, /Deep research/);
assert.match(moduleSource, /Generated file/);
assert.match(moduleSource, /Generated image/);
assert.match(moduleSource, /Web research/);
assert.match(moduleSource, /response-inline-loader/);
assert.match(moduleSource, /new MutationObserver/);
assert.match(moduleSource, /requestAnimationFrame/);
assert.match(moduleSource, /aria-label/);
assert.doesNotMatch(moduleSource, /fetch\(|XMLHttpRequest|SentIQAPI|persistChatMessage|localStorage|sessionStorage/);

assert.match(css, /\.message\.assistant > \.message-header\s*\{[\s\S]*clip-path: inset\(50%\);/);
assert.match(css, /data-identity-mode="compact"/);
assert.match(css, /\.message-avatar\s*\{[\s\S]*display: none;/);
assert.match(css, /\.image-provider-tag\s*\{[\s\S]*display: none;/);
assert.match(css, /@media \(forced-colors: active\)/);
assert.doesNotMatch(css, /100vw|position:\s*fixed|margin-(?:left|right):\s*-/);

console.log("Identity and metadata regression checks passed.");
