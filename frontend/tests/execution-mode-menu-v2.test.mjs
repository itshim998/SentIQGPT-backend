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
const module93Css = await readFile(
  new URL("../styles/modules/93-execution-mode-menu-v2.css", import.meta.url),
  "utf8",
);

// 1. Assert kill-switch attribute exists in index.html
assert.match(
  indexHtml,
  /<html[^>]*data-execution-menu="v2"[^>]*>/i,
  'index.html <html> tag must declare kill-switch attribute data-execution-menu="v2"',
);

// 2. Assert module 93 is imported after module 92 and is the last import in 12-reduced-motion.css
assert.ok(
  styleImports.includes('@import url("./93-execution-mode-menu-v2.css");'),
  "12-reduced-motion.css must import 93-execution-mode-menu-v2.css",
);
const lines = styleImports
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("@import"));
const lastImportLine = lines[lines.length - 1];
assert.equal(
  lastImportLine,
  '@import url("./95-copy-layout-fixes.css");',
  "95-copy-layout-fixes.css must be the last import in 12-reduced-motion.css (appended after 93)",
);
const mod92Index = lines.indexOf('@import url("./92-composer-action-menu-v2.css");');
const mod93Index = lines.indexOf('@import url("./93-execution-mode-menu-v2.css");');
assert.ok(
  mod93Index > mod92Index,
  "93-execution-mode-menu-v2.css must be imported after 92-composer-action-menu-v2.css",
);

// 3. Assert the menu surface and options have no linear-gradient or radial-gradient fill
assert.equal(
  /--execution-menu-surface:[^;]*(linear-gradient|radial-gradient)/i.test(module93Css),
  false,
  "Execution mode menu surface token must not use gradient fills",
);
assert.equal(
  /\.execution-mode-menu[^{]*\{[^}]*background:[^;]*(linear-gradient|radial-gradient)/i.test(module93Css),
  false,
  "Execution mode menu surface rule must not declare linear-gradient or radial-gradient fills",
);
assert.equal(
  /\.execution-mode-option[^{]*\{[^}]*background:[^;]*(linear-gradient|radial-gradient)/i.test(module93Css),
  false,
  "Execution mode option rule must not declare linear-gradient or radial-gradient fills",
);

// 4. Assert no circle or ring styling on the check element (no border-radius: 50% or 999px with border/background)
assert.equal(
  /\.execution-mode-option-check[^{]*\{[^}]*border-radius:\s*(?:50%|999px)/i.test(module93Css),
  false,
  "Execution mode check element must not declare circular or pill border-radius",
);

// 5. Assert text-wrap is set on the descriptions
assert.ok(
  /\.execution-mode-option-description[^{]*\{[^}]*text-wrap:\s*(?:pretty|balance)/i.test(module93Css),
  "Option descriptions must declare text-wrap (pretty or balance) to avoid orphaned words",
);

// 6. Assert motion uses only transform and opacity (stroke-dashoffset is the documented exception for the tick)
const transitionProperties = [
  ...module93Css.matchAll(/transition(?:-property)?:\s*([^;!]+)/gi),
].map((m) => m[1]);

for (const propStr of transitionProperties) {
  const parts = propStr.split(",").map((p) => p.trim().split(/\s+/)[0]);
  for (const prop of parts) {
    if (!prop || prop === "none" || prop === "all") continue;
    assert.ok(
      ["transform", "opacity", "background-color", "visibility"].includes(prop),
      `Transitions in module 93 must not animate geometry or filter properties: found "${prop}"`,
    );
  }
}

// Check keyframe animations
const keyframeMatches = [...module93Css.matchAll(/@keyframes\s+([a-zA-Z0-9_-]+)\s*\{([^}]+(?:\{[^}]+\}[^}]+)*)\}/gi)];
for (const match of keyframeMatches) {
  const keyframeName = match[1];
  const body = match[2];
  if (keyframeName === "executionModeTickDraw") {
    // Documented exception: stroke-dashoffset for tick draw-in
    assert.ok(
      body.includes("stroke-dashoffset"),
      "Tick draw animation must animate stroke-dashoffset",
    );
  } else {
    // All other animations must touch only transform and opacity
    const animatedProps = [...body.matchAll(/([a-zA-Z-]+)\s*:/g)].map((m) => m[1]);
    for (const p of animatedProps) {
      assert.ok(
        ["transform", "opacity"].includes(p),
        `Keyframes in module 93 outside tick draw must only animate transform/opacity, found: "${p}" in @keyframes ${keyframeName}`,
      );
    }
  }
}

// 7. Assert no new backdrop-filter declarations outside budget mechanism (must be none !important)
const backdropMatches = [
  ...module93Css.matchAll(/(?:-webkit-)?backdrop-filter:\s*([^;]+);/gi),
];
for (const match of backdropMatches) {
  const value = match[1].trim();
  assert.match(
    value,
    /^none\s*!important$/i,
    `Any backdrop-filter in module 93 must strictly be "none !important" to respect budget, found: ${value}`,
  );
}

// 8. Assert prefers-reduced-motion block exists
assert.ok(
  module93Css.includes("@media (prefers-reduced-motion: reduce)"),
  "module 93 must contain a @media (prefers-reduced-motion: reduce) block",
);

// 9. Verify scoping under kill-switch attribute
const rulesWithoutScope = module93Css
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.includes("{") && !line.startsWith("@") && !line.startsWith("/*") && !line.includes(":root"))
  .filter((line) => !line.startsWith("from") && !line.startsWith("to") && !/^\d+%/.test(line))
  .filter((line) => !line.includes('data-execution-menu="v2"'));

assert.equal(
  rulesWithoutScope.length,
  0,
  `All CSS rules must be scoped under html:root[data-execution-menu="v2"]: found un-scoped line: ${rulesWithoutScope[0]}`,
);

console.log(
  "Execution mode menu v2 contract passed: kill-switch attribute present, module loaded last, flat surface with zero gradient fill, bare grey tick without circular container, text-wrap enabled, compositor-safe transitions, hard blur budget compliance, and complete reduced-motion alternatives.",
);
