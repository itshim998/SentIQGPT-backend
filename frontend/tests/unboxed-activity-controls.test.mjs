import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getAdaptivePanelConfig,
  resolveAdaptivePanelMode,
} from "../scripts/features/adaptive-panel-state.js";

const trust = getAdaptivePanelConfig("trust-modal");
assert.equal(trust.desktopPlacement, "center");
assert.equal(resolveAdaptivePanelMode(trust, 1440), "floating-dialog");
assert.equal(resolveAdaptivePanelMode(trust, 390), "full-height-sheet");

const css = await readFile(
  new URL("../styles/modules/85-unboxed-activity-controls.css", import.meta.url),
  "utf8",
);
const imports = await readFile(
  new URL("../styles/modules/12-reduced-motion.css", import.meta.url),
  "utf8",
);
const identity = await readFile(
  new URL("../scripts/features/identity-metadata.js", import.meta.url),
  "utf8",
);

assert.ok(imports.includes('@import url("./85-unboxed-activity-controls.css");'));

for (const token of [
  ".composer-plus-btn",
  ".execution-mode-toggle",
  "border-color: transparent !important",
  "background: transparent !important",
  "box-shadow: none !important",
  ".execution-mode-toggle-indicator",
  "display: none !important",
  ".response-inline-loader.semantic-activity-progress",
  ".semantic-legacy-progress",
  ".semantic-surface-progress",
  "border-radius: 0",
  "backdrop-filter: none",
  ":has(.response-inline-loader.semantic-activity-progress)",
]) {
  assert.ok(css.includes(token), `Final restraint layer missing ${token}`);
}

assert.ok(identity.includes('mode: "implicit"'));
assert.ok(identity.includes('label: "SentIQ response"'));
assert.ok(identity.includes("inline semantic progress row already communicates"));
assert.equal(identity.includes('kind: "tool-active"'), false);

assert.equal(css.includes("animation: none"), false, "Spinner motion must remain available");
assert.equal(css.includes(".semantic-activity-mark::after"), false, "Final restraint must not replace the spinner implementation");

console.log("UI restraint gate passed: trust is centered, composer controls are unboxed, duplicate activity identity is removed, and semantic spinners remain intact.");
