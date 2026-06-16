import assert from "node:assert/strict";
import {
  getAllowedModelOwnedTools,
  isModelOwnedToolAllowed,
  legacyRouteForModelOwnedTool,
  MODEL_OWNED_TOOL_CONTRACTS,
} from "./orchestrator/toolContract";

assert.deepEqual(
  MODEL_OWNED_TOOL_CONTRACTS.map((tool) => tool.name),
  ["web_surf", "image_gen_basic", "image_gen_advanced", "intent_clarification_tool"],
  "tool contract exposes the planned model-owned tools",
);

assert.equal(isModelOwnedToolAllowed("web_surf", "fast"), true, "web_surf is available in Fast mode");
assert.equal(isModelOwnedToolAllowed("image_gen_basic", "fast"), true, "basic image tool is available in Fast mode");
assert.equal(isModelOwnedToolAllowed("image_gen_advanced", "intuitive"), true, "advanced image tool is available in Intuitive mode");
assert.equal(isModelOwnedToolAllowed("intent_clarification_tool", "fast"), false, "clarification tool is not available in Fast mode");
assert.equal(isModelOwnedToolAllowed("intent_clarification_tool", "intuitive"), true, "clarification tool is Intuitive-only");
assert.equal(isModelOwnedToolAllowed("math_reasoning", "intuitive"), false, "math_reasoning is not a model-owned tool");

assert.deepEqual(
  getAllowedModelOwnedTools("fast"),
  ["web_surf", "image_gen_basic", "image_gen_advanced"],
  "Fast mode excludes clarification",
);

assert.deepEqual(
  getAllowedModelOwnedTools("intuitive"),
  ["web_surf", "image_gen_basic", "image_gen_advanced", "intent_clarification_tool"],
  "Intuitive mode includes clarification",
);

assert.equal(legacyRouteForModelOwnedTool("web_surf"), "web_search");
assert.equal(legacyRouteForModelOwnedTool("image_gen_basic"), "image_generation");
assert.equal(legacyRouteForModelOwnedTool("image_gen_advanced"), "image_generation");
assert.equal(legacyRouteForModelOwnedTool("intent_clarification_tool"), "clarification");

console.log("Tool contract validation passed.");
