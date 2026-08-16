import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(
  new URL("../styles/modules/91-slim-composer-refinement.css", import.meta.url),
  "utf8",
);
const styleImports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const stabilitySource = await readFile(
  new URL("../scripts/features/ui-stability.js", import.meta.url),
  "utf8",
);

for (const token of [
  "@media (min-width: 769px)",
  "--sentiq-composer-control-size: 34px",
  "--sentiq-composer-field-min-height: 34px",
  "min-height: 48px",
  "padding: 5px 8px",
  ".composer-plus-btn",
  ".btn-send",
  ".execution-mode-toggle",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
]) {
  assert.ok(css.includes(token), `Slim composer stylesheet missing ${token}`);
}

assert.ok(styleImports.includes('@import url("./91-slim-composer-refinement.css");'));
assert.ok(
  styleImports.indexOf("91-slim-composer-refinement.css")
    > styleImports.indexOf("90-final-composer-brand-polish.css"),
  "Slim composer refinement must layer after final composer brand polish",
);

assert.ok(
  stabilitySource.includes("Math.max(30, parsePixelValue(computed.minHeight, 34))"),
  "UI stability autosizer must accommodate slimmer minHeight",
);

console.log("Slim composer refinement contract passed: message composer is slimmer and sleeker on desktop without sacrificing touch targets or autosizer stability.");
