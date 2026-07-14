import assert from "node:assert/strict";
import { buildSentIQToolTransportRequest } from "./ai/PromptBuilders";
import {
  canUseSentIQTools,
  getSentIQToolCapability,
  isGeminiSentIQToolTransportEnabled,
  isGroqSentIQToolTransportEnabled,
  isModelToolRegistryEnabled,
} from "./ai/modelToolCapability";
import { ToolCallStreamAccumulator, normalizeBufferedProviderResult } from "./ai/modelToolTransport";

const guest = { authenticated: false } as const;
const authenticated = { authenticated: true } as const;

assert.equal(isModelToolRegistryEnabled(undefined), false);
assert.equal(isGroqSentIQToolTransportEnabled(undefined), false);
assert.equal(isGeminiSentIQToolTransportEnabled(undefined), false);
assert.equal(isModelToolRegistryEnabled("TRUE"), true);

assert.deepEqual(getSentIQToolCapability("groq"), {
  provider: "groq",
  buffered: true,
  streaming: true,
  reason: "openai_function_transport",
});
assert.equal(canUseSentIQTools("gemini", true), true);
assert.equal(canUseSentIQTools("gemma", false), false);
assert.equal(canUseSentIQTools("pollinations", true), false);

assert.equal(buildSentIQToolTransportRequest({ prompt: "hello", task: "chat" }, false), undefined);
assert.equal(buildSentIQToolTransportRequest({ prompt: "route", task: "route_classify" }, true), undefined);
assert.deepEqual(
  buildSentIQToolTransportRequest({ prompt: "hello", task: "chat", user_id: "guest" }, true)?.allowed_tool_names,
  ["web_surf", "image_gen"],
);
assert.equal(buildSentIQToolTransportRequest({ prompt: "title", task: "general", user_id: "user-1" }, true), undefined);
assert.deepEqual(
  buildSentIQToolTransportRequest({
    prompt: "hello",
    task: "chat",
    user_id: "user-1",
    sentiq_tool_context: authenticated,
  }, true)?.allowed_tool_names,
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
);

assert.deepEqual(normalizeBufferedProviderResult({ kind: "assistant_text", text: "ordinary" }, guest), {
  kind: "assistant_text",
  text: "ordinary",
});
assert.equal(normalizeBufferedProviderResult({
  kind: "tool_calls",
  calls: [{ id: "buffered_1", name: "image_gen", arguments: '{"prompt":"A lighthouse"}' }],
}, guest).kind, "tool_calls");

const stream = new ToolCallStreamAccumulator(authenticated, ["file_gen"]);
assert.deepEqual(stream.push({ kind: "tool_call_start", id: "stream_1", name: "file_gen", index: 0 }), [
  { kind: "tool_call_start", id: "stream_1", name: "file_gen", index: 0 },
]);
assert.deepEqual(stream.push({ kind: "tool_argument_delta", id: "stream_1", text: '{"request":"Build', index: 0 }), [
  { kind: "tool_argument_delta", id: "stream_1", text: '{"request":"Build', index: 0 },
]);
stream.push({ kind: "tool_argument_delta", id: "stream_1", text: ' a report","format":"pdf"}', index: 0 });
const completed = stream.push({ kind: "done", finishReason: "tool_calls" });
assert.equal(completed[0]?.kind, "tool_calls_complete");
assert.deepEqual(completed[0]?.kind === "tool_calls_complete" ? completed[0].calls[0]?.arguments : undefined, {
  request: "Build a report",
  format: "pdf",
});
assert.deepEqual(completed[1], { kind: "done", finishReason: "tool_calls" });

const textStream = new ToolCallStreamAccumulator(guest, ["web_surf", "image_gen"]);
assert.deepEqual(textStream.push({ kind: "text_delta", text: "Hello" }), [{ kind: "text_delta", text: "Hello" }]);
assert.throws(
  () => textStream.push({ kind: "tool_call_start", id: "late_1", name: "web_surf", index: 0 }),
  /after visible text/,
);

const incomplete = new ToolCallStreamAccumulator(guest, ["web_surf"]);
incomplete.push({ kind: "tool_call_start", id: "bad_1", name: "web_surf", index: 0 });
incomplete.push({ kind: "tool_argument_delta", id: "bad_1", text: '{"query":', index: 0 });
assert.throws(() => incomplete.push({ kind: "done" }), /valid JSON/);

const mismatched = new ToolCallStreamAccumulator(guest, ["web_surf"]);
mismatched.push({ kind: "tool_call_start", id: "match_1", name: "web_surf", index: 0 });
assert.throws(
  () => mismatched.push({ kind: "tool_argument_delta", id: "match_1", text: "{}", index: 1 }),
  /do not match/,
);

assert.throws(
  () => new ToolCallStreamAccumulator(guest, ["web_surf"]).push({
    kind: "tool_call_start",
    id: "unknown_1",
    name: "file_gen",
    index: 0,
  }),
  /unavailable/,
);

console.log("Model tool capability and transport checks passed.");
