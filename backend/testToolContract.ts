import assert from "node:assert/strict";
import {
  SENTIQ_TOOL_REGISTRY,
  SENTIQ_TOOL_CHOICE_POLICY,
  SENTIQ_TOOL_REGISTRY_VERSION,
  getAllowedToolFingerprint,
  getAvailableToolDefinitions,
  getProviderToolDefinitions,
  normalizeAssistantTurn,
  validateModelToolCalls,
} from "./orchestrator/toolContract";

const guest = { authenticated: false } as const;
const authenticated = { authenticated: true } as const;

assert.match(SENTIQ_TOOL_REGISTRY_VERSION, /^2026-07-pass5-v\d+$/);
assert.deepEqual(
  SENTIQ_TOOL_REGISTRY.map((tool) => tool.name),
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
  "registry exposes only canonical product tools",
);
assert.doesNotMatch(SENTIQ_TOOL_CHOICE_POLICY, /route\s+by\s+(keyword|regex)/i, "policy must not instruct heuristic routing");
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /Do not call a tool merely because a keyword appears/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /ask a concise conversational clarification/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /real executable capabilities/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /downloadable file must call file_gen/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /remember durable.*must call memory_update/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /generate a new image must call image_gen/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /ordinary questions that merely discuss files, memory, images, charts, web search/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /Never claim that you searched, generated, created, or saved/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /only a successful tool result confirms completion/i);

assert.deepEqual(
  getAvailableToolDefinitions(guest).map((tool) => tool.name),
  ["web_surf", "image_gen"],
  "guest availability matches existing executable capabilities",
);
assert.deepEqual(
  getAvailableToolDefinitions(authenticated).map((tool) => tool.name),
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
);
assert.deepEqual(
  getAvailableToolDefinitions({ authenticated: true, executionMode: "fast" }).map((tool) => tool.name),
  getAvailableToolDefinitions({ authenticated: true, executionMode: "intuitive" }).map((tool) => tool.name),
);

const guestProviderTools = getProviderToolDefinitions(guest);
const authProviderTools = getProviderToolDefinitions(authenticated);
assert.notEqual(getAllowedToolFingerprint(guestProviderTools), getAllowedToolFingerprint(authProviderTools));
for (const tool of authProviderTools) {
  assert.equal(tool.input_schema.additionalProperties, false, `${tool.name} rejects privileged/unexpected fields`);
}

const calls = validateModelToolCalls([
  { id: "call_1", name: "web_surf", arguments: '{"query":"latest verified update"}' },
], guest);
assert.deepEqual(calls[0], {
  id: "call_1",
  name: "web_surf",
  arguments: { query: "latest verified update" },
  index: 0,
});

const nativeFileArguments = { request: "Create the requested month plan", format: "pdf" };
for (const [id, argumentsValue] of [
  ["native_file_args", nativeFileArguments],
  ["string_file_args", JSON.stringify(nativeFileArguments)],
  ["double_file_args", JSON.stringify(JSON.stringify(nativeFileArguments))],
  ["wrapped_file_args", { arguments: JSON.stringify(nativeFileArguments) }],
  ["function_file_args", { function: { arguments: JSON.stringify(nativeFileArguments) } }],
  ["surrounded_file_args", `The requested tool data follows:\n${JSON.stringify(nativeFileArguments)}\nEnd tool data.`],
] as const) {
  assert.deepEqual(
    validateModelToolCalls([{ id, name: "file_gen", arguments: argumentsValue }], authenticated)[0]?.arguments,
    nativeFileArguments,
    `${id} should normalize to the provider-neutral file arguments`,
  );
}
assert.throws(() => validateModelToolCalls([{
  id: "metadata_file_args",
  name: "file_gen",
  arguments: { request: "Create it", format: "pdf", provider: "internal" },
}], authenticated), /unrecognized key/i, "provider metadata must not cross the validated tool boundary");

assert.throws(() => validateModelToolCalls([
  { id: "call_2", name: "file_gen", arguments: { request: "Make a PDF", format: "pdf" } },
], guest), /unavailable/);
assert.throws(() => validateModelToolCalls([
  { id: "call_3", name: "unknown_tool", arguments: {} },
], authenticated), /Unknown SentIQ tool/);
assert.throws(() => validateModelToolCalls([
  { id: "call_4", name: "file_gen", arguments: "not-json" },
], authenticated), /valid JSON/);
assert.throws(() => validateModelToolCalls([
  { id: "call_missing", name: "web_surf", arguments: {} },
], authenticated), /Required/);
assert.throws(() => validateModelToolCalls([
  { id: "call_5", name: "file_gen", arguments: { request: "Make it", format: "exe" } },
], authenticated), /Invalid enum value/);
assert.deepEqual(validateModelToolCalls([
  { id: "call_memory_missing_type", name: "memory_update", arguments: { content: "User prefers concise answers.", scope: "global" } },
], authenticated)[0]?.arguments, { content: "User prefers concise answers.", scope: "global" });
assert.equal(validateModelToolCalls([
  { id: "call_memory", name: "memory_update", arguments: { content: "User prefers concise answers.", type: "preference", scope: "global" } },
], authenticated)[0]?.name, "memory_update");
assert.throws(() => validateModelToolCalls([
  { id: "call_6", name: "web_surf", arguments: { query: "news", user_id: "attacker" } },
], authenticated), /unrecognized key/i);
assert.throws(() => validateModelToolCalls([
  { id: "duplicate", name: "web_surf", arguments: { query: "one" } },
  { id: "duplicate", name: "image_gen", arguments: { prompt: "two" } },
], authenticated), /Duplicate/);
assert.throws(() => validateModelToolCalls([
  { id: "index_1", name: "web_surf", arguments: { query: "one" }, index: 0 },
  { id: "index_2", name: "image_gen", arguments: { prompt: "two" }, index: 0 },
], authenticated), /Duplicate tool call index/);
assert.throws(() => validateModelToolCalls([
  { id: "bad id", name: "web_surf", arguments: { query: "news" } },
], authenticated), /ID is malformed/);
assert.throws(() => validateModelToolCalls([
  { id: "oversized", name: "web_surf", arguments: { query: "x".repeat(17_000) } },
], authenticated), /allowed size/);

assert.deepEqual(normalizeAssistantTurn({ kind: "assistant_text", text: "Hello" }, guest), {
  kind: "assistant_text",
  text: "Hello",
});
assert.equal(
  normalizeAssistantTurn({
    kind: "tool_calls",
    calls: [{ id: "call_7", name: "image_gen", arguments: { prompt: "A calm lake" } }],
  }, guest).kind,
  "tool_calls",
);

console.log("Tool registry and validation checks passed.");
