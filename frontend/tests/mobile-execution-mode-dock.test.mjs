import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const styleSource = await readFile(
  new URL("../styles/modules/84-mobile-execution-mode-dock.css", import.meta.url),
  "utf8",
);
const styleImportSource = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const composerMarkup = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);

for (const token of [
  '@media (max-width: 768px)',
  '#execution-mode-control[data-execution-mode-version="5.6"]',
  'position: fixed !important',
  'top: max(18px, env(safe-area-inset-top, 0px)) !important',
  'right: max(16px, env(safe-area-inset-right, 0px)) !important',
  'bottom: auto !important',
  'left: auto !important',
  'grid-template-columns:',
  '"plus field action"',
  'top: calc(100% + 9px)',
  'transform-origin: top right',
  '@media (prefers-reduced-motion: reduce) and (max-width: 768px)',
  '@media (forced-colors: active) and (max-width: 768px)',
]) {
  assert.ok(styleSource.includes(token), `Mobile execution control missing ${token}`);
}

assert.equal(
  styleSource.includes('"plus field execution action"'),
  false,
  "The compact mobile composer must not reserve an execution-mode column",
);
assert.equal(
  styleSource.includes("display: none"),
  false,
  "The mobile execution selector must remain available rather than being hidden",
);
assert.equal(
  styleSource.includes("bottom: calc(100% + 12px)"),
  false,
  "The execution selector must not return to the space above the composer",
);
assert.equal(
  styleSource.includes("left: 10px !important"),
  false,
  "The execution selector must remain in the page's top-right corner",
);

const previousImport = '@import url("./83-composer-sidebar-polish.css")';
const dockImport = '@import url("./84-mobile-execution-mode-dock.css")';
assert.ok(styleImportSource.includes(dockImport), "Mobile execution control stylesheet must be loaded");
assert.ok(
  styleImportSource.indexOf(dockImport) > styleImportSource.indexOf(previousImport),
  "Mobile execution control must load after the final composer geometry layer",
);

assert.ok(
  composerMarkup.includes('<div id="execution-mode-control" class="execution-mode-control">'),
  "Execution-mode semantics and existing event bindings must remain intact",
);
assert.ok(
  composerMarkup.includes('aria-controls="execution-mode-menu"'),
  "Execution-mode toggle must retain its accessible menu relationship",
);

console.log(
  "Mobile execution-mode position gate passed: the selector occupies the page's top-right corner, its menu opens downward, the composer row contains only attachment, field, and action controls, and existing semantics remain intact.",
);