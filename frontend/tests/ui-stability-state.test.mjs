import assert from "node:assert/strict";
import {
  OPTIMISTIC_SEND_TIMEOUT_MS,
  isComposerSendCandidate,
  isPlainTextSendCandidate,
  messageTextMatches,
  normalizeComposerText,
  normalizeExecutionMode,
  shouldShowOptimisticUserMessage,
} from "../scripts/features/ui-stability-state.mjs";

assert.equal(normalizeComposerText("  hello\n  world  "), "hello world");
assert.equal(normalizeExecutionMode("intuitive"), "intuitive");
assert.equal(normalizeExecutionMode("unknown"), "fast");

assert.equal(isComposerSendCandidate({ text: "Explain this" }), true);
assert.equal(isComposerSendCandidate({ text: "", toolMode: "none" }), false);
assert.equal(isComposerSendCandidate({ text: "Explain this", stopMode: true }), false);
assert.equal(isComposerSendCandidate({ text: "Explain this", composing: true }), false);
assert.equal(isComposerSendCandidate({ text: "Explain this", toolMode: "image" }), true);

assert.equal(isPlainTextSendCandidate({ text: "Explain this", toolMode: "none" }), true);
assert.equal(isPlainTextSendCandidate({ text: "Explain this", toolMode: "image" }), false);

assert.equal(shouldShowOptimisticUserMessage({
  executionMode: "intuitive",
  composerCleared: true,
  matchingRealMessagePresent: false,
  elapsedMs: 20,
}), true);
assert.equal(shouldShowOptimisticUserMessage({
  executionMode: "fast",
  composerCleared: true,
  matchingRealMessagePresent: false,
  elapsedMs: 20,
}), false);
assert.equal(shouldShowOptimisticUserMessage({
  executionMode: "intuitive",
  composerCleared: false,
  matchingRealMessagePresent: false,
  elapsedMs: 20,
}), false);
assert.equal(shouldShowOptimisticUserMessage({
  executionMode: "intuitive",
  composerCleared: true,
  matchingRealMessagePresent: true,
  elapsedMs: 20,
}), false);
assert.equal(shouldShowOptimisticUserMessage({
  executionMode: "intuitive",
  composerCleared: true,
  matchingRealMessagePresent: false,
  elapsedMs: OPTIMISTIC_SEND_TIMEOUT_MS,
}), false);

assert.equal(messageTextMatches("What is\nIntuitive mode?", " What is Intuitive mode? "), true);
assert.equal(messageTextMatches("first", "second"), false);
assert.equal(messageTextMatches("", ""), false);

console.log("UI stability state gate passed: all successful composer sends clear drafts, while only plain Intuitive sends receive an optimistic user bubble.");
