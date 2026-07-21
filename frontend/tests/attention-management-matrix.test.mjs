import assert from "node:assert/strict";
import {
  classifyMessageOutcome,
  deriveOutcomeSignal,
  coalesceAttentionQueue,
  MAX_ATTENTION_QUEUE,
} from "../scripts/features/attention-management-model.mjs";

const statuses = ["", "complete", "completed", "ready", "running", "pending", "generating", "processing", "failed", "error", "stopped", "cancelled"];
const types = ["", "text", "web-search", "deep-research", "image", "file-analysis", "generated-file", "chart"];
let checked = 0;

for (const type of types) {
  for (const status of statuses) {
    for (const streaming of [false, true]) {
      const meta = { type, status, streaming };
      if (type === "image" && ["complete", "completed", "ready"].includes(status)) {
        meta.image_url = "https://example.test/image.png";
      }
      if (type === "file-analysis" && ["failed", "error"].includes(status)) {
        meta.filename = "notes.pdf";
      }
      const result = classifyMessageOutcome({
        id: `${type}:${status}:${streaming}`,
        role: "assistant",
        content: "Completed content",
        meta,
      }, Date.now());
      const pending = streaming || ["running", "pending", "generating", "processing"].includes(status);
      const terminalFileFailure = type === "file-analysis" && ["failed", "error"].includes(status);
      if (pending && !terminalFileFailure) {
        assert.equal(result, null, `pending ${type}/${status}/${streaming} must stay silent`);
      }
      if (type === "deep-research" && ["complete", "completed", "ready"].includes(status) && !streaming) {
        assert.equal(result?.kind, "research-complete");
      }
      if (type === "image" && ["complete", "completed", "ready"].includes(status) && !streaming) {
        assert.equal(result?.kind, "image-complete");
      }
      if (terminalFileFailure) assert.equal(result?.kind, "file-analysis-failed");
      if (["generated-file", "chart"].includes(type)) assert.equal(result, null);
      if (["", "text", "web-search"].includes(type)
        && !pending
        && !["failed", "error", "stopped", "cancelled"].includes(status)) {
        assert.equal(result?.kind, "response-complete");
      }
      checked += 1;
    }
  }
}

for (const kind of ["response-complete", "research-complete", "file-analysis-failed", "image-complete"]) {
  const outcome = { kind, signature: `${kind}:new`, updatedAt: 2 };
  const activeSignal = deriveOutcomeSignal(
    { kind, signature: `${kind}:old`, updatedAt: 1 },
    outcome,
    { chatId: "active", active: true },
  );
  if (kind === "response-complete") assert.equal(activeSignal, null);
  else assert.equal(activeSignal?.kind, kind);
  assert.equal(deriveOutcomeSignal(
    { kind, signature: `${kind}:old`, updatedAt: 1 },
    outcome,
    { chatId: "inactive", active: false },
  )?.kind, kind);
}

let queue = [];
for (let index = 0; index < 25; index += 1) {
  queue = coalesceAttentionQueue(queue, {
    kind: "response-complete",
    chatId: `chat-${index}`,
    signature: String(index),
  });
}
assert.equal(queue.length, MAX_ATTENTION_QUEUE);
assert.deepEqual(queue.map((item) => item.chatId), ["chat-22", "chat-23", "chat-24"]);

console.log(`Pass 9.5 matrix passed: ${checked} outcome combinations`);
