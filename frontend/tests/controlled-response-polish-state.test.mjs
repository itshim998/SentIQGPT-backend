import assert from "node:assert/strict";
import {
  BLOCK_REVEAL_FALLBACK_MS,
  CONTROLLED_RESPONSE_POLISH_VERSION,
  HTML_CODE_BATCH_INTERVAL_MS,
  HTML_PREVIEW_BATCH_INTERVAL_MS,
  buildRevealBlockKey,
  normalizeRevealBlockType,
  resolveArtifactBatchDelay,
  resolveReservedMediaAspect,
} from "../scripts/features/controlled-response-polish-state.mjs";

assert.equal(CONTROLLED_RESPONSE_POLISH_VERSION, "13.1");
assert.equal(HTML_CODE_BATCH_INTERVAL_MS, 96);
assert.equal(HTML_PREVIEW_BATCH_INTERVAL_MS, 280);
assert.ok(HTML_PREVIEW_BATCH_INTERVAL_MS > HTML_CODE_BATCH_INTERVAL_MS);
assert.equal(BLOCK_REVEAL_FALLBACK_MS, 260);

assert.equal(normalizeRevealBlockType({ tagName: "P" }), "p");
assert.equal(normalizeRevealBlockType({ tagName: "DIV", className: "code-block-wrap language-js" }), "code-block-wrap");
assert.equal(buildRevealBlockKey({ index: 2, tagName: "PRE", className: "code-block-wrap" }), "2:code-block-wrap");
assert.equal(buildRevealBlockKey({ index: 2, tagName: "PRE", className: "code-block-wrap changed-content" }), "2:code-block-wrap");
assert.equal(resolveArtifactBatchDelay("code"), HTML_CODE_BATCH_INTERVAL_MS);
assert.equal(resolveArtifactBatchDelay("preview"), HTML_PREVIEW_BATCH_INTERVAL_MS);

assert.deepEqual(resolveReservedMediaAspect(1600, 900), {
  width: 1600,
  height: 900,
  cssValue: "1600 / 900",
  source: "intrinsic",
});
assert.deepEqual(resolveReservedMediaAspect(0, 0), {
  width: 4,
  height: 3,
  cssValue: "4 / 3",
  source: "fallback",
});
const boundedPortrait = resolveReservedMediaAspect(200, 1000);
assert.equal(boundedPortrait.source, "bounded");
assert.equal(boundedPortrait.cssValue, "480 / 1000");

console.log("Controlled response state gate passed: logical block keys are stable, artifact refreshes are bounded, and media ratios reserve safe geometry.");
