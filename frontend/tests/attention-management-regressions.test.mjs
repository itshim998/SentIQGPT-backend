import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyMessageOutcome } from "../scripts/features/attention-management-model.mjs";

const now = Date.parse("2026-07-21T12:00:00.000Z");

assert.equal(classifyMessageOutcome({
  id: "image-placeholder",
  role: "assistant",
  content: "Generating image",
  timestamp: new Date(now - 3_000).toISOString(),
  meta: { type: "image", streaming: true },
}, now), null, "streaming image placeholders must not announce completion");

assert.equal(classifyMessageOutcome({
  id: "image-unsettled",
  role: "assistant",
  content: "Image generation",
  timestamp: new Date(now - 2_000).toISOString(),
  meta: { type: "image" },
}, now), null, "image-shaped text without an artifact or completed status must remain silent");

assert.equal(classifyMessageOutcome({
  id: "text-streaming",
  role: "assistant",
  content: "Partial answer",
  timestamp: new Date(now - 2_000).toISOString(),
  meta: { streaming: true },
}, now), null, "streaming metadata must suppress generic response completion even without a status");

assert.equal(classifyMessageOutcome({
  id: "web-response",
  role: "assistant",
  content: "The web-backed answer is ready.",
  timestamp: new Date(now - 1_000).toISOString(),
  meta: { type: "web-search", responseStatus: "complete" },
}, now)?.kind, "response-complete", "web-backed answers still count as completed responses");

assert.equal(classifyMessageOutcome({
  id: "chart-artifact",
  role: "assistant",
  content: "Chart ready",
  timestamp: new Date(now - 500).toISOString(),
  meta: { type: "chart", status: "complete" },
}, now), null, "unrequested chart artifact notifications must not add noise");

const modelSource = await readFile(new URL("../scripts/features/attention-management-model.mjs", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../styles/modules/61-attention-management.css", import.meta.url), "utf8");
for (const token of [
  "const pending = meta.streaming === true || PENDING_STATUSES.has(status)",
  "function isNonResponseArtifactType(type)",
  "if (!hasImageArtifact(meta, status)) return null",
  "isNonResponseArtifactType(type)",
]) assert.ok(modelSource.includes(token), `Attention outcome regression guard missing ${token}`);
assert.ok(
  cssSource.includes(".chat-list-item.has-attention-signal .conversation-activity-indicator"),
  "A completed attention state must visually replace, not contradict, an older activity state",
);

console.log("Pass 9.5 attention outcome regression gate passed.");
