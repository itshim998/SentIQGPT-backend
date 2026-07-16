import assert from "node:assert/strict";
import { reduceToolLifecycleState } from "../scripts/features/tool-lifecycle-reducer.mjs";

const idle = { activityMode: "thinking", status: "idle", tool: null, callId: null };
const selected = reduceToolLifecycleState(idle, {
  type: "tool_selected",
  tool: "web_surf",
  call_id: "call_1",
});
assert.deepEqual(selected, {
  activityMode: "web_search",
  status: "selected",
  tool: "web_surf",
  callId: "call_1",
});
const running = reduceToolLifecycleState(selected, {
  type: "tool_started",
  tool: "web_surf",
  call_id: "call_1",
});
assert.equal(running.status, "running");
assert.equal(running.activityMode, "web_search");
const succeeded = reduceToolLifecycleState(running, {
  type: "tool_result",
  tool: "web_surf",
  call_id: "call_1",
});
assert.equal(succeeded.status, "succeeded");
assert.equal(succeeded.activityMode, "thinking");
const failed = reduceToolLifecycleState(running, {
  type: "tool_error",
  tool: "web_surf",
  call_id: "call_1",
  code: "execution_failed",
});
assert.equal(failed.status, "failed");
assert.equal(failed.code, "execution_failed");
assert.equal(reduceToolLifecycleState(idle, { type: "unknown", tool: "web_surf" }), idle);

const cancelled = reduceToolLifecycleState(running, { type: "request_cancelled" });
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.activityMode, "thinking");
assert.deepEqual(reduceToolLifecycleState(cancelled, { type: "request_retry" }), idle);
assert.deepEqual(reduceToolLifecycleState(idle, { type: "hydrate", state: running }), running);
assert.deepEqual(reduceToolLifecycleState(idle, { type: "hydrate", state: succeeded }), succeeded);
assert.deepEqual(reduceToolLifecycleState(idle, { type: "hydrate", state: { status: "running", tool: "unknown" } }), idle);

for (const [tool, activityMode] of [
  ["image_gen", "image_generation"],
  ["chart_gen", "chart_generation"],
  ["file_gen", "file_generation"],
  ["memory_update", "memory_update"],
]) {
  assert.equal(reduceToolLifecycleState(idle, { type: "tool_started", tool }).activityMode, activityMode);
}

console.log("Frontend tool lifecycle reducer checks passed.");
