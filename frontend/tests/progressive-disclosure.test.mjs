import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const behaviorSource = await readFile(new URL("../scripts/features/progressive-disclosure.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const importsSource = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/55-progressive-disclosure.css", import.meta.url), "utf8");
const responsiveCssSource = await readFile(new URL("../styles/modules/56-progressive-disclosure-responsive.css", import.meta.url), "utf8");
const combinedCssSource = `${cssSource}\n${responsiveCssSource}`;
const messageActionsSource = await readFile(new URL("../scripts/features/message-action-behaviour.js", import.meta.url), "utf8");
const accountSource = await readFile(new URL("../styles/modules/19-account-surface.css", import.meta.url), "utf8");
const toolSheetSource = await readFile(new URL("../styles/modules/26-tool-action-sheet.css", import.meta.url), "utf8");

for (const token of [
  'PROGRESSIVE_DISCLOSURE_VERSION = "9.2"',
  ".deep-research-card",
  ".image-generation-card",
  ".message-chart-container",
  ".generated-file-panel",
  ".deep-research-report-actions",
  ".asset-result-actions",
  ".message-action-bar",
  ".account-panel-actions",
  "progressive-disclosure-trigger",
  "sentiq-secondary-action-sheet",
  'role="dialog"',
  'aria-modal="true"',
  "openMessageActions",
  "focusTarget.focus()",
  "event.key === \"Escape\"",
  "event.key !== \"Tab\"",
  "window.visualViewport",
  "requestAnimationFrame",
  "MutationObserver",
  "setAttributeIfChanged",
  "sentiq-account-panel-home",
  "document.body.appendChild(accountPanel)",
]) assert.ok(behaviorSource.includes(token), `Behavior missing ${token}`);

for (const forbidden of [
  "fetch(",
  "XMLHttpRequest",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "SentIQAPI",
  "SentIQAuth",
  "signOut(",
  "signInWith",
]) assert.equal(behaviorSource.includes(forbidden), false, `Disclosure layer must not own ${forbidden}`);

assert.ok(domRefsSource.includes('import "../progressive-disclosure.js";'));
assert.ok(
  domRefsSource.indexOf('import "../ui-state-bridge.js";') < domRefsSource.indexOf('import "../progressive-disclosure.js";'),
  "Disclosure must initialize after the central UI state bridge",
);
assert.ok(importsSource.includes('@import url("./55-progressive-disclosure.css");'));
assert.ok(importsSource.includes('@import url("./56-progressive-disclosure-responsive.css");'));

for (const token of [
  'data-progressive-disclosure-version="9.2"',
  'data-progressive-surface="asset"',
  'data-progressive-surface="research"',
  'data-progressive-zone="message"',
  'data-progressive-zone="account"',
  ":hover [data-progressive-zone=",
  ":focus-within [data-progressive-zone=",
  ".sentiq-secondary-action-sheet:not([hidden])",
  ".sentiq-secondary-action-panel",
  ".progressive-account-backdrop:not([hidden])",
  'body > #account-panel[data-progressive-account-sheet="true"]',
  "safe-area-inset-bottom",
  "--sentiq-progressive-viewport-height",
  "prefers-reduced-motion: reduce",
  "forced-colors: active",
]) assert.ok(combinedCssSource.includes(token), `Disclosure CSS missing ${token}`);

assert.ok(messageActionsSource.includes("message-actions-trigger"), "Existing message disclosure remains available");
assert.ok(messageActionsSource.includes("focusin"), "Keyboard interaction must keep actions reachable");
assert.ok(messageActionsSource.includes("Escape"), "Existing message action escape behavior must remain");
assert.ok(accountSource.includes(".account-panel"), "Account controls remain in the account surface");
assert.ok(toolSheetSource.includes(".composer-action-menu"), "Composer secondary controls retain their existing sheet");

const desktopDisclosureRules = (cssSource.match(/@media \(hover: hover\)[\s\S]*?@media \(hover: none\)/) || [""])[0];
assert.ok(desktopDisclosureRules.includes("opacity: 0"), "Desktop secondary controls should start calm");
assert.ok(desktopDisclosureRules.includes("opacity: 1"), "Desktop interaction must reveal controls");
assert.ok(desktopDisclosureRules.includes("focus-within"), "Keyboard focus must reveal controls");

const mobileSheetRules = (cssSource.match(/@media \(hover: none\)[\s\S]*?@media \(max-width: 420px\)/) || [""])[0];
assert.ok(mobileSheetRules.includes("display: inline-grid"), "Relevant mobile surfaces need an explicit action trigger");
assert.ok(mobileSheetRules.includes("position: fixed"), "Mobile actions need a sheet layer");
assert.ok(mobileSheetRules.includes("overscroll-behavior: contain"), "Mobile sheet scrolling must stay contained");

const directAttributeWrites = behaviorSource.match(/\.setAttribute\("(?:aria-hidden|data-progressive-mobile-access)"/g) || [];
assert.equal(directAttributeWrites.length, 0, "Observed disclosure attributes must use guarded writes");

console.log("Pass 9.2 progressive disclosure phase gate passed.");
