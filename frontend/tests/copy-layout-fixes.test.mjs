import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve("frontend/styles/modules/95-copy-layout-fixes.css");
const motionPath = resolve("frontend/styles/modules/12-reduced-motion.css");

assert.ok(existsSync(cssPath), "95-copy-layout-fixes.css must exist");

const motionContent = readFileSync(motionPath, "utf8").trim();
assert.ok(
  motionContent.endsWith('@import url("./95-copy-layout-fixes.css");'),
  "95-copy-layout-fixes.css must be the last import in 12-reduced-motion.css"
);

const cssContent = readFileSync(cssPath, "utf8");

// Must NOT contain any font*, line-height, letter-spacing, text-transform
assert.doesNotMatch(cssContent, /font(-\w+)?\s*:/i, "Must not contain font declarations");
assert.doesNotMatch(cssContent, /line-height\s*:/i, "Must not contain line-height declarations");
assert.doesNotMatch(cssContent, /letter-spacing\s*:/i, "Must not contain letter-spacing declarations");
assert.doesNotMatch(cssContent, /text-transform\s*:/i, "Must not contain text-transform declarations");

// Verify that all CSS property declarations in the file belong only to the permitted set:
// margin, padding, gap, min-height, display, row-gap, column-gap
const allowedProperties = new Set([
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "gap",
  "row-gap",
  "column-gap",
  "min-height",
  "display",
]);

// Strip comments
const stripped = cssContent.replace(/\/\*[\s\S]*?\*\//g, "");
// Extract property names
const declarationMatches = stripped.matchAll(/([a-zA-Z-]+)\s*:[^;]+;/g);
for (const match of declarationMatches) {
  const prop = match[1].toLowerCase().trim();
  assert.ok(
    allowedProperties.has(prop),
    `Property '${prop}' is not permitted in 95-copy-layout-fixes.css`
  );
}

console.log("Pass: 95-copy-layout-fixes.css conforms to all spacing and property constraints.");
