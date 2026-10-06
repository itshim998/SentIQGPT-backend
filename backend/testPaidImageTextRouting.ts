import assert from "node:assert/strict";
import { getImageModelForPlan, resolveImageRoute } from "./billing/modelEntitlementRouter";
import { getImageProviderOrder } from "./tools/imageGeneration/imageRouter";
import { detectExplicitTextRenderingRequirement } from "./tools/imageGeneration/imageTextRenderingDecision";
import { getProviderToolDefinitions, validateModelToolCalls } from "./orchestrator/toolContract";

for (const plan of ["student_core", "premium", "pro"] as const) {
  const visual = getImageModelForPlan(plan, false);
  const text = getImageModelForPlan(plan, true);
  const expectedFastModel = plan === "student_core"
    ? "@cf/black-forest-labs/flux-1-schnell"
    : plan === "premium"
      ? "@cf/black-forest-labs/flux-2-klein-4b"
      : "@cf/black-forest-labs/flux-2-klein-9b";
  assert.equal(visual.model, expectedFastModel, plan + " Fast non-text image route");
  assert.equal(text.model, expectedFastModel, plan + " Fast text-rendering image route (policy-owned)");

  // Intuitive mode:
  const intuitiveVisual = resolveImageRoute({ planCode: plan, executionMode: "intuitive", requiresTextRendering: false });
  const intuitiveText = resolveImageRoute({ planCode: plan, executionMode: "intuitive", requiresTextRendering: true });
  const expectedIntuitiveModel = plan === "student_core"
    ? "@cf/black-forest-labs/flux-2-klein-4b"
    : plan === "premium"
      ? "@cf/black-forest-labs/flux-2-klein-9b"
      : "openai/gpt-image-2";
  assert.equal(intuitiveVisual.model, expectedIntuitiveModel, plan + " Intuitive visual route");
  assert.equal(intuitiveText.model, expectedIntuitiveModel, plan + " Intuitive text-rendering route");
}
assert.equal(getImageModelForPlan("free", false).model, "@cf/black-forest-labs/flux-1-schnell");
assert.equal(getImageModelForPlan("free", true).model, "@cf/black-forest-labs/flux-1-schnell");
assert.equal(resolveImageRoute({ planCode: "free", executionMode: "intuitive", requiresTextRendering: true }).model, "@cf/black-forest-labs/flux-1-schnell");

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
