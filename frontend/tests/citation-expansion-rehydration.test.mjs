import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../scripts/features/citation-expansion-rehydration.js", import.meta.url), "utf8");
const domRefsSource = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");

for (const token of [
  'const CITATION_EXPANSION_VERSION = "11.5"',
  ".websurf-v2-source-explorer",
  ".websurf-v2-citation-group",
  "[aria-expanded][aria-controls]",
  "getPanelKey",
  "getMessageSignature",
  "controlled.hidden = !next",
  'panel.classList.toggle("is-expanded", next)',
  "const states = new Map()",
  "while (states.size > 12)",
  'capture("history-intent")',
  'scheduleRestore("message-replacement")',
  "new MutationObserver",
  "requestAnimationFrame",
  "scheduleScrollAnchor",
  "{ userInitiated: true }",
  "window.SentIQCitationExpansion = Object.freeze",
]) assert.ok(source.includes(token), `Controlled citation rehydration missing ${token}`);

for (const forbidden of ["localStorage", "sessionStorage", "fetch(", "setInterval(", "innerHTML"]) {
  assert.equal(source.includes(forbidden), false, `Controlled citation rehydration must not own ${forbidden}`);
}

assert.ok(source.includes("passive: true"));
const optimizerImport = domRefsSource.indexOf('import "../long-conversation-optimizer.js";');
const citationImport = domRefsSource.indexOf('import "../citation-expansion-rehydration.js";');
const mobileNavigationImport = domRefsSource.indexOf('import "../mobile-navigation.js";');
assert.ok(optimizerImport >= 0 && citationImport > optimizerImport && mobileNavigationImport > citationImport,
  "Controlled citation restoration must initialize after the long conversation optimizer and before mobile navigation");

console.log("Pass 11.5 controlled citation expansion gate passed.");
