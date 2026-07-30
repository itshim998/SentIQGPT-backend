import assert from "node:assert/strict";
import {
  CHAT_LIST_STABILIZE_MAX_MS,
  CHAT_LIST_STABILIZE_QUIET_MS,
  OPTIMISTIC_SEND_TIMEOUT_MS,
  SUCCESSFUL_SEND_GUARD_TIMEOUT_MS,
  UI_STABILITY_VERSION,
  isComposerSendCandidate,
  isPlainTextSendCandidate,
  messageTextMatches,
  nextChatListSettleDelay,
  normalizeComposerText,
  normalizeExecutionMode,
  normalizeUserDisplayText,
  shouldClearRestoredComposer,
  shouldShowOptimisticUserMessage,
} from "../scripts/features/ui-stability-state.mjs";

assert.equal(UI_STABILITY_VERSION, "13.0");
assert.equal(SUCCESSFUL_SEND_GUARD_TIMEOUT_MS, 180_000);
assert.equal(CHAT_LIST_STABILIZE_QUIET_MS, 180);
assert.equal(CHAT_LIST_STABILIZE_MAX_MS, 1_200);

assert.equal(normalizeComposerText("  hello\n  world  "), "hello world");
assert.equal(normalizeUserDisplayText("Generate image: a glass sphere"), "a glass sphere");
assert.equal(normalizeUserDisplayText("ordinary prompt"), "ordinary prompt");
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

assert.equal(shouldClearRestoredComposer({
  composerText: "Have you heard about Montek LC?",
  sentText: "Have you heard about Montek LC?",
  requestSucceeded: true,
}), true);
assert.equal(shouldClearRestoredComposer({
  composerText: "Have you heard about Montek LC?",
  sentText: "Have you heard about Montek LC?",
  requestSucceeded: false,
}), false);
assert.equal(shouldClearRestoredComposer({
  composerText: "A new draft",
  sentText: "Have you heard about Montek LC?",
  requestSucceeded: true,
}), false);
assert.equal(shouldClearRestoredComposer({
  composerText: "Have you heard about Montek LC?",
  sentText: "Have you heard about Montek LC?",
  requestSucceeded: true,
  userEditedAfterSend: true,
}), false);

assert.equal(nextChatListSettleDelay({ elapsedMs: 0 }), CHAT_LIST_STABILIZE_QUIET_MS);
assert.equal(nextChatListSettleDelay({ elapsedMs: 1_100 }), 100);
assert.equal(nextChatListSettleDelay({ elapsedMs: CHAT_LIST_STABILIZE_MAX_MS }), 0);

console.log("UI stability state gate passed: Fast and Intuitive success paths clear only restored sent text, failed requests preserve retry drafts, and new-chat history settles within a bounded quiet window.");
