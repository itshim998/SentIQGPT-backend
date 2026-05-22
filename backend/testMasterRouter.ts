import assert from "node:assert/strict";
import {
  applyMasterChatRoutingPolicy,
  applyMasterImageRoutingPolicy,
  selectModelForPromptWithMaster,
  validateMasterRoutingDecision,
  type MasterRoutingDecision,
} from "./orchestrator/masterRouter";
import { selectImageProviderMode } from "./tools/imageGeneration/imageRouter";
import type { LLMAdapterCall, LLMAdapterResult } from "./ai/PromptBuilders";

function result(text: string): LLMAdapterResult {
  return {
    text,
    fallback: false,
    fallback_reason: null,
    finish_reason: "stop",
    truncated: false,
    error: null,
    error_detail: null,
  };
}

function decision(
  selected_model: MasterRoutingDecision["selected_model"],
  confidence: number,
): MasterRoutingDecision {
  return { selected_model, confidence, reason: "test" };
}

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

const valid = validateMasterRoutingDecision({
  selected_model: "coding_specialist",
  confidence: 1.5,
  reason: "  Code routing   ",
});
assert.deepEqual(valid, {
  selected_model: "coding_specialist",
  confidence: 1,
  reason: "Code routing",
});

assert.equal(validateMasterRoutingDecision({ selected_model: "unknown", confidence: 0.9, reason: "x" }), null);
assert.equal(validateMasterRoutingDecision({ selected_model: "general_model", confidence: "0.9", reason: "x" }), null);
assert.equal(validateMasterRoutingDecision(null), null);

const highCoding = applyMasterChatRoutingPolicy({
  deterministicModel: "gpt-oss-120b",
  decision: decision("coding_specialist", 0.9),
});
assert.equal(highCoding.source, "master");
assert.equal(highCoding.model, "qwen-coder");

const lowConfidence = applyMasterChatRoutingPolicy({
  deterministicModel: "gpt-oss-120b",
  decision: decision("coding_specialist", 0.3),
});
assert.equal(lowConfidence.source, "deterministic");
assert.equal(lowConfidence.model, "gpt-oss-120b");
assert.equal(lowConfidence.fallback_reason, "confidence_policy");

const advisoryAgreement = applyMasterChatRoutingPolicy({
  deterministicModel: "gpt-oss-120b",
  decision: decision("general_model", 0.5),
});
assert.equal(advisoryAgreement.source, "master");
assert.equal(advisoryAgreement.model, "gpt-oss-120b");

const advisoryDisagreement = applyMasterChatRoutingPolicy({
  deterministicModel: "gpt-oss-120b",
  decision: decision("coding_specialist", 0.5),
});
assert.equal(advisoryDisagreement.source, "deterministic");
assert.equal(advisoryDisagreement.model, "gpt-oss-120b");

const codingDowngrade = applyMasterChatRoutingPolicy({
  deterministicModel: "qwen-coder",
  decision: decision("general_model", 0.95),
});
assert.equal(codingDowngrade.source, "deterministic");
assert.equal(codingDowngrade.model, "qwen-coder");
assert.equal(codingDowngrade.fallback_reason, "incompatible_with_context");

const mathDowngrade = applyMasterChatRoutingPolicy({
  deterministicModel: "openai-large",
  decision: decision("general_model", 0.95),
});
assert.equal(mathDowngrade.source, "deterministic");
assert.equal(mathDowngrade.model, "openai-large");
assert.equal(mathDowngrade.fallback_reason, "incompatible_with_context");

const imageBasic = applyMasterImageRoutingPolicy({
  prompt: "Generate an image of a clean study desk.",
  decision: decision("basic_image_generator", 0.9),
});
assert.equal(imageBasic, "zimage");

const imageAdvanced = applyMasterImageRoutingPolicy({
  prompt: "Generate a poster with text that says Study Smarter.",
  decision: decision("advanced_image_generator", 0.5),
});
assert.equal(imageAdvanced, "wan-image");

assert.equal(selectImageProviderMode("Generate a simple desk image.", "zimage"), "standard");
assert.equal(selectImageProviderMode("Generate a simple desk image.", "wan-image"), "complex");
assert.equal(selectImageProviderMode("Generate a poster with text.", "zimage"), "complex");

async function main(): Promise<void> {
  await withEnv("MASTER_ROUTER_ENABLED", "true", async () => {
    const routed = await selectModelForPromptWithMaster({
      query: "Why is this Python loop failing?",
    }, {
      callModel: async (_call: LLMAdapterCall) => result(JSON.stringify({
        selected_model: "general_model",
        confidence: 0.99,
        reason: "bad downgrade",
      })),
    });
    assert.equal(routed.source, "deterministic");
    assert.equal(routed.model, "qwen-coder");

    const malformed = await selectModelForPromptWithMaster({
      query: "Tell me a short story.",
    }, {
      callModel: async () => result("not json"),
    });
    assert.equal(malformed.source, "deterministic");
    assert.equal(malformed.model, "gpt-oss-120b");

    const failed = await selectModelForPromptWithMaster({
      query: "Tell me a short story.",
    }, {
      callModel: async () => {
        throw new Error("Groq unavailable");
      },
    });
    assert.equal(failed.source, "deterministic");
    assert.equal(failed.model, "gpt-oss-120b");
  });

  await withEnv("MASTER_ROUTER_ENABLED", "false", async () => {
    const disabled = await selectModelForPromptWithMaster({
      query: "Build a React component.",
    }, {
      callModel: async () => {
        throw new Error("should not call model");
      },
    });
    assert.equal(disabled.source, "deterministic");
    assert.equal(disabled.model, "qwen-coder");
    assert.equal(disabled.fallback_reason, "master_router_disabled");
  });

  console.log("Master router tests passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
