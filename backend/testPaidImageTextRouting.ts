import assert from "node:assert/strict";
import { getImageModelForPlan } from "./billing/modelEntitlementRouter";
import { getImageProviderOrder } from "./tools/imageGeneration/imageRouter";
import { detectExplicitTextRenderingRequirement } from "./tools/imageGeneration/imageTextRenderingDecision";
import { getProviderToolDefinitions, validateModelToolCalls } from "./orchestrator/toolContract";

for (const plan of ["student_core", "premium", "pro"] as const) {
  const visual = getImageModelForPlan(plan, false);
  const text = getImageModelForPlan(plan, true);
  assert.equal(visual.model, "zimage", plan + " non-text image route");
  assert.equal(text.model, "gpt-image-2", plan + " text-rendering image route");
  assert.deepEqual(getImageProviderOrder("visual", visual.model).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(getImageProviderOrder("text", text.model).slice(0, 2), ["gpt-image-2", "kontext"]);
}
assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");
assert.equal(getImageModelForPlan("free", true).model, "dreamshaper");

const imageTool = getProviderToolDefinitions({ authenticated: true })
  .find((tool) => tool.name === "image_gen");
assert(imageTool);
assert.deepEqual(imageTool.input_schema.required, ["prompt", "requires_text_rendering"]);
assert.equal((imageTool.input_schema.properties as any).requires_text_rendering.type, "boolean");

const call = validateModelToolCalls([{
  id: "paid_text_image",
  name: "image_gen",
  arguments: { prompt: "A poster reading Welcome", requires_text_rendering: true },
}], { authenticated: true });
assert.equal(call[0].arguments.requires_text_rendering, true);
assert.throws(() => validateModelToolCalls([{
  id: "missing_decision",
  name: "image_gen",
  arguments: { prompt: "A poster" },
}], { authenticated: true }), /Required/);

assert.equal(detectExplicitTextRenderingRequirement('A poster that says "Welcome"'), true);
assert.equal(detectExplicitTextRenderingRequirement("A calm lake at sunrise"), false);

console.log("Paid-plan image text-rendering policy checks passed.");
