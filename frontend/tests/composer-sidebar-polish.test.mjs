import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const styleSource = await readFile(
  new URL("../styles/modules/83-composer-sidebar-polish.css", import.meta.url),
  "utf8",
);
const sidebarRuntimeSource = await readFile(
  new URL("../scripts/features/sidebar-transition-polish.js", import.meta.url),
  "utf8",
);
const styleImportSource = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const domRefsSource = await readFile(
  new URL("../scripts/features/chat/dom-refs.js", import.meta.url),
  "utf8",
);

for (const token of [
  '.input-field-wrapper',
  '> .chat-input-area:has(#chat-input:focus-visible)',
  '#chat-input:focus-visible',
  'box-shadow: none',
  '--sentiq-composer-capsule-radius: 999px',
  'border-radius: 999px',
  '> .chat-input-area.has-attachments',
  'border-radius: 30px',
]) {
  assert.ok(styleSource.includes(token), `Composer polish missing ${token}`);
}

assert.equal(
  styleSource.includes('outline: 2px solid'),
  false,
  'The message textarea must not regain a nested rectangular focus outline',
);
assert.ok(
  styleSource.includes('@media (prefers-reduced-motion: reduce)'),
  'Sidebar motion must include a reduced-motion alternative',
);

for (const token of [
  'const SIDEBAR_TRANSITION_VERSION = "12.7.1"',
  'new MutationObserver',
  'attributeFilter: ["class"]',
  'sidebar.animate(',
  'readPixelToken("--sentiq-sidebar-rail-width", 64)',
  'readPixelToken("--sidebar-width", 280)',
  'motionQuery?.matches',
  'Promise.allSettled',
  'data-sidebar-transitioning',
]) {
  assert.ok(sidebarRuntimeSource.includes(token), `Sidebar transition runtime missing ${token}`);
}

assert.equal(
  sidebarRuntimeSource.includes('classList.toggle("sidebar-collapsed"'),
  false,
  'Transition polish must observe the existing sidebar state rather than replace its behavior',
);
assert.equal(
  sidebarRuntimeSource.includes('localStorage'),
  false,
  'Transition polish must not duplicate sidebar preference persistence',
);
assert.equal(
  sidebarRuntimeSource.includes('setInterval('),
  false,
  'Sidebar transition must not introduce a recurring timer',
);

const previousImport = '@import url("./82-home-composer-composition.css")';
const polishImport = '@import url("./83-composer-sidebar-polish.css")';
assert.ok(styleImportSource.includes(polishImport), 'Composer/sidebar polish stylesheet must be loaded');
assert.ok(
  styleImportSource.indexOf(polishImport) > styleImportSource.indexOf(previousImport),
  'Composer/sidebar polish must load after the home composition and aura layers',
);
assert.ok(
  domRefsSource.includes('import "../sidebar-transition-polish.js";'),
  'Sidebar transition runtime must initialize before chat event binding',
);

console.log('Composer/sidebar polish gate passed: the textarea has no nested focus rectangle, the composer is capsule-shaped, and desktop sidebar state changes animate without replacing existing behavior.');
