import assert from "node:assert/strict";
import {
  MODEL_OWNED_TOOL_CONTRACTS,
  SENTIQ_TOOL_CHOICE_POLICY,
  SENTIQ_TOOL_REGISTRY_VERSION,
  getAllowedModelOwnedTools,
  getAllowedToolFingerprint,
  getAvailableToolDefinitions,
  getProviderToolDefinitions,
  isModelOwnedToolAllowed,
  legacyRouteForModelOwnedTool,
  normalizeAssistantTurn,
  validateModelToolCalls,
} from "./orchestrator/toolContract";

const guest = { authenticated: false } as const;
const authenticated = { authenticated: true } as const;

assert.match(SENTIQ_TOOL_REGISTRY_VERSION, /^2026-07-pass1-v\d+$/);
assert.deepEqual(
  MODEL_OWNED_TOOL_CONTRACTS.map((tool) => tool.name),
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
  "registry exposes only canonical product tools",
);
assert.doesNotMatch(SENTIQ_TOOL_CHOICE_POLICY, /route\s+by\s+(keyword|regex)/i, "policy must not instruct heuristic routing");
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /Do not call a tool merely because a keyword appears/i);
assert.match(SENTIQ_TOOL_CHOICE_POLICY, /ask a concise conversational clarification/i);

assert.deepEqual(
  getAvailableToolDefinitions(guest).map((tool) => tool.name),
  ["web_surf", "image_gen"],
  "guest availability matches existing executable capabilities",
);
assert.deepEqual(
  getAvailableToolDefinitions(authenticated).map((tool) => tool.name),
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
);
assert.deepEqual(getAllowedModelOwnedTools("fast"), getAllowedModelOwnedTools("intuitive"));
assert.equal(isModelOwnedToolAllowed("image_gen", "fast"), true);
assert.equal(isModelOwnedToolAllowed("intent_clarification_tool", "intuitive"), false);
assert.equal(legacyRouteForModelOwnedTool("web_surf"), "web_search");
assert.equal(legacyRouteForModelOwnedTool("image_gen"), "image_generation");
assert.equal(legacyRouteForModelOwnedTool("chart_gen"), "chart_generation");
assert.equal(legacyRouteForModelOwnedTool("file_gen"), "file_generation");
assert.equal(legacyRouteForModelOwnedTool("memory_update"), "memory_update");

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
