import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const guardPath = resolve(root, "frontend/scripts/features/scroll-interaction-guard.js");
const guardSource = readFileSync(guardPath, "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");
const css = readFileSync(resolve(root, "frontend/styles/modules/80-scroll-interaction-hotfix.css"), "utf8");
const {
  MANUAL_SCROLL_HOLD_MS,
  shouldAllowProgrammaticScroll,
} = await import(pathToFileURL(guardPath));

assert.equal(
  shouldAllowProgrammaticScroll({ now: 100, manualUntil: 200, explicitUntil: 0 }),
  false,
  "delayed programmatic corrections must yield during active manual scrolling",
);
assert.equal(
  shouldAllowProgrammaticScroll({ now: 100, manualUntil: 200, explicitUntil: 150 }),
  true,
  "explicit Latest/source navigation remains allowed during the manual hold window",
);
assert.equal(
  shouldAllowProgrammaticScroll({ now: 250, manualUntil: 200, explicitUntil: 0 }),
  true,
  "programmatic anchoring resumes after manual scrolling settles",
);
assert.ok(
  MANUAL_SCROLL_HOLD_MS >= 2400,
  "manual scroll protection must outlast the conversation continuity restore window",
);

const guardImport = domRefs.indexOf('import "../scroll-interaction-guard.js";');
const readingImport = domRefs.indexOf('import "../long-answer-reading.js";');
assert.ok(guardImport >= 0, "scroll interaction guard must be loaded");
assert.ok(readingImport >= 0, "long-answer reading runtime must remain loaded");
assert.ok(guardImport < readingImport, "scroll guard must wrap native APIs before long-answer reading captures them");
assert.match(imports, /@import url\("\.\/80-scroll-interaction-hotfix\.css"\);/);

for (const policy of [
  "scroll-behavior: auto",
  "overscroll-behavior-y: contain",
  "overflow-anchor: none",
  "content-visibility: visible",
  "contain: none",
  "overflow: visible",
]) {
  assert.ok(css.includes(policy), `scroll hotfix is missing ${policy}`);
}
assert.match(css, /> \.message\[data-long-conversation-window\]/);

for (const forbidden of [
  "MutationObserver",
  "ResizeObserver",
  "setInterval(",
  "requestAnimationFrame(",
]) {
  assert.equal(guardSource.includes(forbidden), false, `scroll guard must not introduce ${forbidden}`);
}

assert.match(guardSource, /Object\.defineProperty\(chatMessages, "scrollTo"/);
assert.match(guardSource, /Object\.defineProperty\(chatMessages, "scrollTop"/);
assert.match(guardSource, /addEventListener\("wheel"[\s\S]*capture: true, passive: true/);
assert.match(guardSource, /addEventListener\("touchmove"[\s\S]*capture: true, passive: true/);
assert.match(guardSource, /addEventListener\("pointerdown"[\s\S]*capture: true, passive: true/);
assert.match(guardSource, /blocked-\$\{kind\}-during-manual-scroll/);
assert.match(guardSource, /sentiqScrollTopProtected/);

console.log("Production scroll hotfix gate passed: wheel navigation owns both scroll APIs, delayed restores are bounded, deliberate jumps remain available, and all conversation messages stay fully laid out.");
