import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ADAPTIVE_PANEL_CONFIGS,
  ADAPTIVE_PANEL_VERSION,
  getAdaptivePanelConfig,
  isAdaptivePanelModal,
  resolveAdaptivePanelMode,
} from "../scripts/features/adaptive-panel-state.js";

assert.equal(ADAPTIVE_PANEL_VERSION, "8.1");
assert.deepEqual(
  ADAPTIVE_PANEL_CONFIGS.map(({ id }) => id),
  ["auth-modal", "name-modal", "settings-modal", "trust-modal", "live-beta-panel", "account-panel"],
);

const auth = getAdaptivePanelConfig("auth-modal");
const settings = getAdaptivePanelConfig("settings-modal");
const live = getAdaptivePanelConfig("live-beta-panel");
const account = getAdaptivePanelConfig("account-panel");

assert.equal(resolveAdaptivePanelMode(auth, 1440), "floating-dialog");
assert.equal(resolveAdaptivePanelMode(settings, 1440), "contextual-floating");
assert.equal(resolveAdaptivePanelMode(live, 900), "side-sheet");
assert.equal(resolveAdaptivePanelMode(settings, 390), "full-height-sheet");
assert.equal(resolveAdaptivePanelMode(auth, 390), "bottom-sheet");
assert.equal(resolveAdaptivePanelMode(account, 1440), "contextual-floating");
assert.equal(resolveAdaptivePanelMode(account, 900), "side-sheet");
assert.equal(resolveAdaptivePanelMode(account, 390), "bottom-sheet");
assert.equal(isAdaptivePanelModal(account, "contextual-floating"), false);
assert.equal(isAdaptivePanelModal(account, "side-sheet"), true);
assert.equal(isAdaptivePanelModal(auth, "floating-dialog"), true);
assert.equal(getAdaptivePanelConfig("missing"), null);

const framework = await readFile(new URL("../scripts/features/adaptive-panel-framework.js", import.meta.url), "utf8");
const domRefs = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const imports = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const foundation = await readFile(new URL("../styles/modules/45-adaptive-panel-foundation.css", import.meta.url), "utf8");
const responsive = await readFile(new URL("../styles/modules/46-adaptive-panel-responsive.css", import.meta.url), "utf8");

for (const token of [
  "MutationObserver",
  "inertAround",
  'setAttribute("inert", "")',
  'setAttribute("aria-hidden", "true")',
  'event.key === "Escape"',
  'event.key !== "Tab"',
  "stopImmediatePropagation",
  "previousFocus",
  "sentiq-panel-before-close",
  "aria-modal",
  "requestClose",
]) assert.ok(framework.includes(token), `framework missing ${token}`);

for (const forbidden of ["fetch(", "SentIQAPI", "localStorage", "sessionStorage", "WebSocket", "getUserMedia"]) {
  assert.equal(framework.includes(forbidden), false, `framework must not contain ${forbidden}`);
}

assert.ok(domRefs.startsWith('import "../adaptive-panel-framework.js";'));
assert.ok(imports.includes('@import url("./45-adaptive-panel-foundation.css");'));
assert.ok(imports.includes('@import url("./46-adaptive-panel-responsive.css");'));

for (const token of [
  "adaptive-panel-modal-open",
  "adaptive-panel-header",
  "adaptive-panel-close",
  "contextual",
  "env(safe-area-inset-top)",
  "forced-colors: active",
]) assert.ok(foundation.includes(token), `foundation CSS missing ${token}`);

for (const token of [
  "max-width: 1024px",
  "max-width: 640px",
  "side-sheet",
  "bottom-sheet",
  "full-height-sheet",
  "100dvh",
  "prefers-reduced-motion: reduce",
]) assert.ok(responsive.includes(token), `responsive CSS missing ${token}`);

console.log("Adaptive panel framework phase gate passed.");
