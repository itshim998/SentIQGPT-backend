import assert from "node:assert/strict";
import {
  deriveRequiredModelCapabilities,
  routeSupportsCapabilities,
} from "./ai/modelToolCapability";

type ReservationInput = { feature: string; requestId: string; metadata?: Record<string, unknown> };

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
  const { BillingQuotaService } = await import("./billing/quotaService");
  assert.equal(routeSupportsCapabilities(
    { provider: "groq", model: "gpt-oss-120b" },
    ["sentiq_tools_buffered"],
  ), true);
  assert.equal(routeSupportsCapabilities(
    { provider: "groq", model: "gpt-oss-120b" },
    ["image_input"],
  ), false);
  assert.equal(routeSupportsCapabilities(
    { provider: "gemini", model: "gemini-standard" },
    ["image_input", "sentiq_tools_streaming"],
  ), true);
  assert.equal(routeSupportsCapabilities(
    { provider: "gemini", model: "gemma-4-31b-it" },
    ["sentiq_tools_buffered"],
  ), false);
  assert.equal(routeSupportsCapabilities(
    { provider: "pollinations", model: "mistral" },
    ["image_input"],
  ), false);
  assert.deepEqual(deriveRequiredModelCapabilities({
    hasImageInput: true,
    automaticToolsRequested: true,
    streaming: true,
  }), ["image_input", "sentiq_tools_streaming"]);

  const previousPremium = process.env.SENTIQ_MODEL_PREMIUM_TEXT;
  const previousLite = process.env.SENTIQ_MODEL_LITE_TEXT;
  const previousRegistry = process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED;
  const previousGroqTransport = process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;
  const previousGeminiTransport = process.env.SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED;
  process.env.SENTIQ_MODEL_PREMIUM_TEXT = "groq:gpt-oss-120b";
  process.env.SENTIQ_MODEL_LITE_TEXT = "pollinations:mistral";
  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
  process.env.SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED = "true";
  try {
    const calls: ReservationInput[] = [];
    const capableRepository = {
      reserveUsage: async (input: ReservationInput) => {
        calls.push(input);
        return { reserved: true, plan_code: "premium", remaining: 9, limit: 10 };
      },
    };
    const service = new BillingQuotaService(capableRepository as any);
    const imageRoute = await service.reserveTextRoute({
      identity: { userId: "11111111-1111-1111-1111-111111111111", anonymousKeyHash: null, isGuest: false },
      requestId: "capability-image",
      requiredCapabilities: ["image_input"],
    });
    assert.equal(imageRoute.provider, "gemini", "image input must reserve a real Gemini Standard route");
    assert.equal(imageRoute.adapterModelOverride, "gemini-standard");
    assert.equal(calls[0]?.feature, "premium_text", "capability fallback stays within Standard entitlement first");

    const downgradeCalls: ReservationInput[] = [];
    const downgradeRepository = {
      reserveUsage: async (input: ReservationInput) => {
        downgradeCalls.push(input);
        return input.feature === "premium_text"
          ? { reserved: false, plan_code: "free", remaining: 0, limit: 0, reset_at: "later" }
          : { reserved: true, plan_code: "free", remaining: 4, limit: 5 };
      },
    };
    const downgradeService = new BillingQuotaService(downgradeRepository as any);
    const toolRoute = await downgradeService.reserveTextRoute({
      identity: { userId: "22222222-2222-2222-2222-222222222222", anonymousKeyHash: null, isGuest: false },
      requestId: "capability-tools",
      requiredCapabilities: ["sentiq_tools_streaming"],
    });
    assert.equal(toolRoute.route, "lite");
    assert.equal(toolRoute.provider, "gemini", "an incapable configured Lite route must be skipped");
    assert.deepEqual(downgradeCalls.map((call) => call.feature), ["premium_text", "lite_text"]);
  } finally {
    if (previousPremium === undefined) delete process.env.SENTIQ_MODEL_PREMIUM_TEXT;
    else process.env.SENTIQ_MODEL_PREMIUM_TEXT = previousPremium;
    if (previousLite === undefined) delete process.env.SENTIQ_MODEL_LITE_TEXT;
    else process.env.SENTIQ_MODEL_LITE_TEXT = previousLite;
    if (previousRegistry === undefined) delete process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED;
    else process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = previousRegistry;
    if (previousGroqTransport === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;
    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previousGroqTransport;
    if (previousGeminiTransport === undefined) delete process.env.SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED;
    else process.env.SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED = previousGeminiTransport;
  }

  console.log("Capability-aware model routing checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
