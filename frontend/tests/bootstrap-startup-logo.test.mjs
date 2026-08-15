import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bootstrapSource = await readFile(
  new URL("../scripts/bootstrap-guard.js", import.meta.url),
  "utf8",
);
const stabilityCss = await readFile(
  new URL("../styles/modules/86-ui-stability.css", import.meta.url),
  "utf8",
);
const logoRuntime = await readFile(
  new URL("../scripts/features/logo-activity.js", import.meta.url),
  "utf8",
);

for (const token of [
  'sentiq-startup-content sentiq-startup-logo-mode',
  'sentiq-activity-logo',
  'variant="neural-dialog"',
  'state="loading"',
  'size="88px"',
  'aria-label="Loading SentIQ Chat"',
  'removeStartupScreen({ animate: true })',
  'removeStartupScreen({ animate: false })',
  'screen.classList.add("is-exiting")',
  'window.setTimeout(() => {',
  'UI_STABILITY_STYLESHEET = "styles/modules/86-ui-stability.css"',
  'link[rel="stylesheet"][href="${UI_STABILITY_STYLESHEET}"]',
  'data-ui-stability-version',
]) {
  assert.ok(bootstrapSource.includes(token), `Bootstrap startup contract missing ${token}`);
}

assert.equal(bootstrapSource.includes("sentiq-startup-spinner"), false,
  "Bootstrap startup markup must no longer instantiate the legacy spinner");
assert.equal(bootstrapSource.includes("Opening SentIQ Chat"), false,
  "Bootstrap startup markup must not restore loading text");
assert.equal(bootstrapSource.includes("Still getting your workspace ready"), false,
  "Bootstrap startup must not mutate loading copy after the logo migration");
assert.equal(bootstrapSource.includes("setTimeout(() => {\n      const copy"), false,
  "Bootstrap must not keep the old delayed copy mutation");
assert.ok(bootstrapSource.indexOf('root.dataset.sentiqBootState = "ready";') < bootstrapSource.indexOf('removeStartupScreen({ animate: true });'),
  "Ready state must be published before the cosmetic startup exit");
assert.ok(bootstrapSource.includes('document.dispatchEvent(new CustomEvent("sentiq-ui-ready"))'),
  "Startup readiness event must remain intact");

for (const token of [
  ".sentiq-startup-screen.is-exiting",
  "transition: opacity 240ms ease, transform 280ms",
  ".sentiq-startup-content.sentiq-startup-logo-mode",
  "@media (prefers-reduced-motion: reduce), (update: slow)",
  "transition: none !important",
]) {
  assert.ok(stabilityCss.includes(token), `Startup visual contract missing ${token}`);
}

assert.ok(logoRuntime.includes('customElements.define("sentiq-activity-logo"'),
  "Reusable activity-logo primitive must be registered");
assert.ok(logoRuntime.includes('neural-dialog'),
  "Neural Dialog variant must remain available to bootstrap");
assert.equal(logoRuntime.includes('setBooleanAttribute(this, "aria-busy", true)'), false,
  "Activity-logo primitive must not expose aria-busy on the visual mark itself");

console.log("Neural Dialog startup lifecycle gate passed.");
