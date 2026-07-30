import assert from "node:assert/strict";
import {
  STREAMING_POLISH_VERSION,
  deriveCompletedProcessSummary,
  formatProcessDuration,
  hasSignificantProcessActivity,
  normalizeStreamingActivity,
} from "../scripts/features/streaming-polish-state.mjs";

assert.equal(STREAMING_POLISH_VERSION, "12.8");
assert.equal(normalizeStreamingActivity("Comparing sources"), "comparing-sources");
assert.equal(normalizeStreamingActivity("WebSurf searching"), "searching");
assert.equal(normalizeStreamingActivity("Reading files"), "reading-files");
assert.equal(normalizeStreamingActivity("Preparing document"), "preparing-document");
assert.equal(normalizeStreamingActivity("Creating image"), "creating-image");
assert.equal(normalizeStreamingActivity("Generating chart"), "generating-chart");
assert.equal(normalizeStreamingActivity("Reasoning"), "reasoning");
assert.equal(normalizeStreamingActivity("Thinking"), "thinking");

assert.equal(formatProcessDuration(200), "");
assert.equal(formatProcessDuration(1_100), "1s");
assert.equal(formatProcessDuration(65_000), "1m 5s");

assert.equal(
  deriveCompletedProcessSummary({ elapsedMs: 8_200, activities: ["Searching"], hasThinking: true }),
  "Researched and reasoned · 8s",
);
assert.equal(
  deriveCompletedProcessSummary({ elapsedMs: 4_100, activities: ["Reading files"], hasThinking: false }),
  "Read files · 4s",
);
assert.equal(
  deriveCompletedProcessSummary({ elapsedMs: 2_200, activities: ["Thinking"], hasThinking: true }),
  "Reasoned · 2s",
);
assert.equal(
  deriveCompletedProcessSummary({ elapsedMs: 0, activities: [], hasThinking: true }),
  "Reasoned",
);
assert.equal(
  deriveCompletedProcessSummary({ elapsedMs: 3_000, activities: [], hasThinking: false }),
  "",
);

assert.equal(hasSignificantProcessActivity(["Thinking"]), false);
assert.equal(hasSignificantProcessActivity(["Searching"]), true);
assert.equal(hasSignificantProcessActivity(["Generating chart"]), true);

console.log("Streaming polish state tests passed: summaries are concise, process-aware, and mode-neutral.");
