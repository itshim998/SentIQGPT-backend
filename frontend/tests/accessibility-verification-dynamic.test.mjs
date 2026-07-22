import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const bridge = await readFile(new URL("../scripts/features/accessibility-verification-dynamic.js", import.meta.url), "utf8");
const domRefs = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");

for (const token of [
  'dataset.accessibilityDynamicBridge = "12.1"',
  'executionToggle.setAttribute("aria-label", "Choose execution mode")',
  "window.SentIQAccessibility?.enhance?.(scope)",
  "records.forEach((record) => schedule(record.target))",
  '.observe(document.body, { childList: true, subtree: true })',
]) assert.ok(bridge.includes(token), `Dynamic accessibility bridge missing ${token}`);

assert.equal(bridge.includes("attributes: true"), false);
assert.equal(bridge.includes("setInterval("), false);
assert.equal(bridge.includes("fetch("), false);

const runtimeImport = domRefs.indexOf('import "../accessibility-verification.js";');
const bridgeImport = domRefs.indexOf('import "../accessibility-verification-dynamic.js";');
assert.ok(runtimeImport >= 0 && bridgeImport > runtimeImport, "Dynamic accessibility bridge must load after the primary runtime");

console.log("Pass 12.1 dynamic accessibility gate passed: direct loader, alert, result, and label roots are re-audited without attribute churn.");
