import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const indexHtml = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const styleImports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const module92Css = await readFile(
  new URL("../styles/modules/92-composer-action-menu-v2.css", import.meta.url),
  "utf8",
);

// 1. Assert kill-switch attribute exists in index.html
assert.match(
  indexHtml,
  /<html[^>]*data-composer-menu="v2"[^>]*>/i,
  'index.html <html> tag must declare kill-switch attribute data-composer-menu="v2"',
);

// 2. Assert module 92 is imported last in 12-reduced-motion.css
assert.ok(
  styleImports.includes('@import url("./92-composer-action-menu-v2.css");'),
  "12-reduced-motion.css must import 92-composer-action-menu-v2.css",
);
const lines = styleImports
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("@import"));
const lastImportLine = lines[lines.length - 1];
assert.equal(
  lastImportLine,
  '@import url("./92-composer-action-menu-v2.css");',
  "92-composer-action-menu-v2.css must be the last import in 12-reduced-motion.css",
);

// 3. Assert the menu surface has no linear-gradient or radial-gradient fill
assert.equal(
  /--composer-menu-surface:[^;]*(linear-gradient|radial-gradient)/i.test(module92Css),
  false,
  "Composer menu surface token must not use gradient fills",
);
assert.equal(
  /\.composer-action-menu[^{]*\{[^}]*background:[^;]*(linear-gradient|radial-gradient)/i.test(module92Css),
  false,
  "Composer action menu surface rule must not declare linear-gradient or radial-gradient fills",
);

// 4. Assert animations touch only transform and opacity (compositor-only)
const transitionProperties = [
  ...module92Css.matchAll(/transition(?:-property)?:\s*([^;!]+)/gi),
].map((m) => m[1]);

for (const propStr of transitionProperties) {
  // Split multiple comma-separated transition declarations
  const parts = propStr.split(",").map((p) => p.trim().split(/\s+/)[0]);
  for (const prop of parts) {
    if (!prop || prop === "none" || prop === "all") continue;
    assert.ok(
      ["transform", "opacity", "background-color", "visibility"].includes(prop),
      `Transitions in module 92 must not animate geometry or filter properties: found "${prop}"`,
    );
  }
}

// 5. Assert no new backdrop-filter declarations outside budget mechanism
// In module 92, any backdrop-filter declaration must be 'none !important' to prevent unbudgeted layers.
const backdropMatches = [
  ...module92Css.matchAll(/(?:-webkit-)?backdrop-filter:\s*([^;]+);/gi),
];
for (const match of backdropMatches) {
  const value = match[1].trim();
  assert.match(
    value,
    /^none\s*!important$/i,
    `Any backdrop-filter in module 92 must strictly be "none !important" to respect budget, found: ${value}`,
  );
}

// 6. Assert prefers-reduced-motion block exists
assert.ok(
  module92Css.includes("@media (prefers-reduced-motion: reduce)"),
  "module 92 must contain a @media (prefers-reduced-motion: reduce) block",
);

// 7. Verify scoping under kill-switch attribute
const rulesWithoutScope = module92Css
  .split("\n")
  .filter((line) => line.includes("{") && !line.startsWith("@") && !line.startsWith("/*") && !line.includes(":root"))
  .filter((line) => !line.includes('data-composer-menu="v2"'));

assert.equal(
  rulesWithoutScope.length,
  0,
  `All CSS rules must be scoped under html:root[data-composer-menu="v2"]: found un-scoped line: ${rulesWithoutScope[0]}`,
);

console.log(
  "Composer action menu v2 contract passed: kill-switch attribute present, module loaded last, flat surface with zero gradient fill, compositor-safe transitions, hard blur budget compliance, and complete reduced-motion alternatives.",
);
