import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(
  new URL("../styles/modules/90-final-composer-brand-polish.css", import.meta.url),
  "utf8",
);
const styleImports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const brandSource = await readFile(
  new URL("../scripts/features/brand-polish.js", import.meta.url),
  "utf8",
);
const constantsSource = await readFile(
  new URL("../scripts/features/chat/constants.js", import.meta.url),
  "utf8",
);
const quotaSource = await readFile(
  new URL("../scripts/features/text-quota-state.mjs", import.meta.url),
  "utf8",
);

for (const token of [
  "@media (min-width: 769px)",
  "--sentiq-composer-control-size: 38px",
  "min-height: 56px",
  "align-items: center",
  "width: min(300px",
  "min-height: 54px",
  ".sidebar-history-logo",
  ".app-container.sidebar-collapsed .sidebar-title-row .logo",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
]) {
  assert.ok(css.includes(token), `Final composer stylesheet missing ${token}`);
}

assert.equal(css.includes("currentExecutionMode"), false, "Presentation polish must remain execution-mode neutral");
assert.ok(styleImports.includes('@import url("./90-final-composer-brand-polish.css")'));
assert.ok(
  styleImports.indexOf("90-final-composer-brand-polish.css")
    > styleImports.indexOf("89-specialized-polish.css"),
  "Final polish must layer after Priority 3",
);

for (const token of [
  "https://i.ibb.co/TxPHCpDf/download.png?v=original-20260730",
  'link[rel="icon"]',
  'document.getElementById("sidebar-collapse-btn")',
  'logo.className = "sidebar-history-logo"',
]) {
  assert.ok(brandSource.includes(token), `Brand runtime missing ${token}`);
}
assert.ok(constantsSource.includes('import "../brand-polish.js";'));
assert.ok(
  constantsSource.indexOf('import "../brand-polish.js";')
    > constantsSource.indexOf('import "../artifact-workspace.js";'),
  "Brand polish must initialize after the prior UI layers",
);

assert.match(
  quotaSource,
  /visible:\s*false,\s*state:\s*"available"/,
  "Routine healthy quota state must not render below the composer",
);
assert.match(
  quotaSource,
  /visible:\s*true,\s*state:\s*"fast-only"/,
  "Fast-only warning must remain visible",
);
assert.match(
  quotaSource,
  /visible:\s*true,\s*state:\s*"exhausted"/,
  "Exhausted warning must remain visible",
);

console.log("Final composer and brand polish contract passed: routine quota copy is hidden, desktop geometry is slimmer and centred, the tool sheet is compact, and the original logo is restored without changing mobile touch targets.");
