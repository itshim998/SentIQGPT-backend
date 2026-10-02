import "dotenv/config";
import assert from "assert";
import { readFileSync } from "fs";
import { join } from "path";
import { buildContextFast, extractCurrentVisualAssets } from "./context/contextBuilder";
import {
  getEnabledAutomaticSentIQTools,
  hasVisualAssetsRequiringAnalysis,
  getModelToolRuntimeSnapshot,
  isModelImageInputSelectionEnabled,
} from "./ai/modelToolCapability";
import { executeAutomaticModelToolCalls, execImageInput } from "./orchestrator/toolExecutor";
import { ChatRequestSchema } from "./validation/schemas";
import { FAST_PROFILE } from "./orchestrator/executionProfile";
import type { ValidatedToolCall } from "./orchestrator/toolContract";

async function runTests() {
  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
  console.log("=== Running Focused Three Defects Regression Suite ===\n");

  // ----------------------------------------------------
  // TEST 1: Frontend chat-controller.js sanity checks
  // ----------------------------------------------------
  console.log("1. Checking frontend chat-controller.js scoping & wiring...");
  const chatControllerSource = readFileSync(join(__dirname, "..", "frontend", "scripts", "features", "chat-controller.js"), "utf8");
  
  // Verify imageInputResult is declared in handleSend
  assert(chatControllerSource.includes("let imageInputResult = null;"), "imageInputResult must be declared in handleSend");
  // Verify onImageInput sets imageInputResult
  assert(chatControllerSource.includes("onImageInput(imageInputPayload) {\n                imageInputResult = imageInputPayload;"), "onImageInput must store imageInputPayload into imageInputResult");
  // Verify structuredResponse sets imageInputResult
  assert(chatControllerSource.includes("if (structuredResponse?.image_input) imageInputResult = structuredResponse.image_input;"), "structuredResponse must store image_input");
  // Verify non-streaming sets imageInputResult
  assert(chatControllerSource.includes("imageInputResult = response?.image_input || null;"), "non-streaming response must set imageInputResult");
  // Verify line 9840+ uses imageInputResult instead of response?.image_input
  assert(!chatControllerSource.includes("if (response?.image_input?.success && response.image_input.evidence?.relevant_text)"), "response?.image_input must not be evaluated outside non-streaming scope");
  assert(chatControllerSource.includes("if (imageInputResult?.success && effectiveImageEvidence)"), "must check imageInputResult instead of response");
  // Verify composerFileReferences includes all attachments with fileReference
  assert(chatControllerSource.includes(".filter((attachment) => attachment.fileReference)"), "composerFileReferences must include any attachment with fileReference");
  // Verify imageAttachment is enriched with asset_id and visual_asset_id
  assert(chatControllerSource.includes("attachment.imageAttachment.asset_id = fileReference.asset_id;"), "attachment.imageAttachment must receive asset_id");
  console.log("-> Frontend chat-controller.js verification PASSED.\n");

  // ----------------------------------------------------
  // TEST 2: Schema preservation of image_attachments asset_id & visual_asset_id
  // ----------------------------------------------------
  console.log("2. Checking ChatRequestSchema image_attachments asset preservation...");
  const rawPayload = {
    message: "What do the attached images represent?",
    context: {
      image_attachments: [
        {
          filename: "image1.png",
          mime_type: "image/png",
          base64: "dGVzdDE=",
          size_bytes: 100,
          asset_id: "asset-uuid-1",
          visual_asset_id: "asset-uuid-1",
          visual_analysis_status: "required",
        },
        {
          filename: "image2.jpg",
          mime_type: "image/jpeg",
          base64: "dGVzdDI=",
          size_bytes: 200,
          visual_asset_id: "asset-uuid-2",
        },
      ],
    },
  };
  const parsed = ChatRequestSchema.parse(rawPayload);
  assert(parsed.context?.image_attachments, "image_attachments must be present in parsed context");
  assert.strictEqual(parsed.context.image_attachments.length, 2);
  assert.strictEqual(parsed.context.image_attachments[0].asset_id, "asset-uuid-1");
  assert.strictEqual(parsed.context.image_attachments[0].visual_asset_id, "asset-uuid-1");
  assert.strictEqual(parsed.context.image_attachments[1].asset_id, "asset-uuid-2");
  assert.strictEqual(parsed.context.image_attachments[1].visual_asset_id, "asset-uuid-2");
  console.log("-> Schema preservation PASSED.\n");

  // ----------------------------------------------------
  // TEST 3: Context building & visual asset extraction
  // ----------------------------------------------------
  console.log("3. Checking context building with image attachments...");
  const builtContext = await buildContextFast({
    userMessage: "What do these images show?",
    conversationId: "conv-123",
    image_attachments: parsed.context.image_attachments as any,
  });
  assert.strictEqual(builtContext.imageAttachments.length, 2);
  assert.strictEqual(builtContext.imageAttachments[0].asset_id, "asset-uuid-1");
  assert.strictEqual(builtContext.currentVisualAssets.length, 2);
  assert.strictEqual(builtContext.currentVisualAssets[0].asset_id, "asset-uuid-1");
  assert.strictEqual(builtContext.currentVisualAssets[0].filename, "image1.png");
  assert.strictEqual(builtContext.currentVisualAssets[1].asset_id, "asset-uuid-2");
  assert.strictEqual(builtContext.currentVisualAssets[1].filename, "image2.jpg");
  console.log("-> Context building & visual asset extraction PASSED.\n");

  // ----------------------------------------------------
  // TEST 4: Automatic tools calculation with image attachments
  // ----------------------------------------------------
  console.log("4. Checking tool capability with image attachments...");
  const hasVisual = hasVisualAssetsRequiringAnalysis(builtContext.fileReferences, builtContext.currentVisualAssets, builtContext.imageAttachments);
  assert.strictEqual(hasVisual, true, "hasVisualAssetsRequiringAnalysis must be true");

  const tools = getEnabledAutomaticSentIQTools({
    fileReferences: builtContext.fileReferences,
    visualAssets: builtContext.currentVisualAssets,
    imageAttachments: builtContext.imageAttachments,
  });
  assert(tools.includes("image_input"), "image_input must be included in enabled tools");
  console.log("-> Tool capability with image attachments PASSED.\n");

  // ----------------------------------------------------
  // TEST 5: executeAutomaticModelToolCalls does not drop image_input
  // ----------------------------------------------------
  console.log("5. Checking executeAutomaticModelToolCalls permission preservation...");
  // Simulate dispatch when calls has image_input
  const calls: readonly ValidatedToolCall[] = [{
    id: "call-1",
    index: 0,
    name: "image_input" as const,
    arguments: {
      target_asset: "image1.png",
      query: "Analyze this image",
    },
  }];
  
  // This call should not throw "SentIQ tool is unavailable: image_input"
  try {
    const stepResult = await executeAutomaticModelToolCalls(
      calls,
      "What is this image?",
      builtContext,
      FAST_PROFILE,
    );
    // Since mock database doesn't have asset-uuid-1, it should gracefully return:
    // "The visual asset could not be loaded from storage to analyze"
    // rather than throwing AutomaticToolDispatchError: SentIQ tool is unavailable: image_input
    console.log("-> Result tool:", stepResult.tool);
    assert(stepResult.image_input !== undefined, "stepResult must have image_input");
    assert.strictEqual(stepResult.image_input.success, false);
    assert.strictEqual(stepResult.error, "No visual assets found in storage.");
  } catch (err: any) {
    if (err.message && err.message.includes("SentIQ tool is unavailable: image_input")) {
      assert.fail("executeAutomaticModelToolCalls dropped image_input permission!");
    }
    throw err;
  }
  console.log("-> Permission preservation PASSED (image_input allowed and dispatched to execImageInput).\n");

  // ----------------------------------------------------
  // TEST 6: Fast mode scanned PDF toolExecutor routing check
  // ----------------------------------------------------
  console.log("6. Checking toolExecutor routing logic in Fast mode...");
  const toolExecutorSource = readFileSync(join(__dirname, "orchestrator", "toolExecutor.ts"), "utf8");
  assert(
    toolExecutorSource.includes("const shouldSelectTools = (intuitiveLaneActive || (visualNeeded && automaticTools.includes(\"image_input\"))) && automaticTools.length > 0;"),
    "shouldSelectTools must include (visualNeeded && automaticTools.includes(\"image_input\")) in Fast mode",
  );
  assert(
    toolExecutorSource.includes("allowedModelTools: intuitiveLaneActive ? automaticTools : [\"image_input\"],"),
    "Fast mode must pass [\"image_input\"] to selectChatToolCalls",
  );
  console.log("-> toolExecutor routing check PASSED.\n");

  console.log("=== ALL 6 FOCUSED REGRESSION CHECKS PASSED SUCCESSFULLY ===");
}

runTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
