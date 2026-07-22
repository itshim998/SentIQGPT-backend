import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../scripts/features/ui-state-runtime.js", import.meta.url), "utf8");

assert.ok(source.includes("function dispatchDocumentEvent(name, detail)"));
assert.ok(source.includes('typeof document.dispatchEvent !== "function"'));
assert.ok(source.includes('typeof CustomEvent !== "function"'));
assert.ok(source.includes('dispatchDocumentEvent("sentiq-ui-state-change"'));
assert.ok(source.includes('dispatchDocumentEvent("sentiq-ui-state-ready"'));
assert.equal(source.includes('document.dispatchEvent(new CustomEvent("sentiq-ui-state-change"'), false);
assert.equal(source.includes('document.dispatchEvent(new CustomEvent("sentiq-ui-state-ready"'), false);

console.log("Pass 12.2 UI-state runtime contract passed: state events remain observable in browsers and non-fatal in constrained bootstrap environments.");
