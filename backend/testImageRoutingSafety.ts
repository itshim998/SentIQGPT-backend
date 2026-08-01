import assert from "node:assert/strict";
import {
  executeImageGenerationWithProviders,
  getImageProviderOrder,
  type ImageModelPreference,
} from "./tools/imageGeneration/imageRouter";
import { getImageModelForPlan } from "./billing/modelEntitlementRouter";
import { getPlanCatalog } from "./billing/planCatalog";
import { buildPollinationsUrl } from "./tools/imageGeneration/pollinationsUtils";
import {
  ImageProviderFailure,
  failureOutcomeForHttpStatus,
  type ImageProvider,
  type ImageProviderRequestContext,
} from "./tools/imageGeneration/types";

function provider(
  name: string,
  generate: (context?: ImageProviderRequestContext) => Promise<{ base64?: string }>,
): ImageProvider {
  return {
    name,
    isAvailable: () => true,
    generate: async (_prompt, _size, _signal, context) => generate(context),
  };
}

function routeOrder(planCode: "free" | "student_core" | "premium" | "pro", prompt: string): readonly string[] {
  const route = getImageModelForPlan(planCode, prompt);
  return getImageProviderOrder(prompt, route.adapterModelOverride as ImageModelPreference);
}

async function main(): Promise<void> {
  const imageQuotas = Object.fromEntries(
    getPlanCatalog().map((plan) => [plan.code, plan.entitlements.quotas.image_generation]),
  );
  assert.deepEqual(imageQuotas.free, { limit: 2, windowSeconds: 86_400, label: "Images" });
  assert.deepEqual(imageQuotas.student_core, { limit: 4, windowSeconds: 43_200, label: "Images" });
  assert.deepEqual(imageQuotas.premium, { limit: 8, windowSeconds: 43_200, label: "Images" });
  assert.deepEqual(imageQuotas.pro, { limit: 16, windowSeconds: 43_200, label: "Images" });

  assert.equal(getImageModelForPlan("free", "a puppy in snow").model, "dreamshaper");
  assert.equal(getImageModelForPlan("free", "a poster with a title").model, "dreamshaper");
  assert.equal(getImageModelForPlan("student_core", "a puppy in snow").model, "zimage");
  assert.equal(getImageModelForPlan("student_core", "a poster with a title").model, "zimage");
  assert.equal(getImageModelForPlan("premium", "a puppy in snow").model, "zimage");
  assert.equal(getImageModelForPlan("premium", "a poster with a title").model, "zimage");
  assert.equal(getImageModelForPlan("pro", "a puppy in snow").model, "gpt-image-2");
  assert.equal(getImageModelForPlan("pro", "a poster with a title").model, "gpt-image-2");

  assert.deepEqual(routeOrder("free", "a puppy in snow").slice(0, 2), ["dreamshaper", "flux"]);
  assert.deepEqual(routeOrder("free", "a detailed poster with text").slice(0, 2), ["dreamshaper", "flux"]);
  assert.deepEqual(routeOrder("student_core", "a puppy in snow").slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("premium", "a detailed poster with text").slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("pro", "a puppy in snow").slice(0, 2), ["gpt-image-2", "kontext"]);
  assert.deepEqual(routeOrder("pro", "a detailed poster with text").slice(0, 2), ["gpt-image-2", "kontext"]);
  assert.equal(getImageProviderOrder("a puppy in snow", "flux")[0], "flux");
  assert.deepEqual(getImageProviderOrder("a poster", "gptimage").slice(0, 2), ["gptimage", "flux"]);

  assert.equal(failureOutcomeForHttpStatus(400), "definitive");
  assert.equal(failureOutcomeForHttpStatus(429), "definitive");
  assert.equal(failureOutcomeForHttpStatus(408), "indeterminate");
  assert.equal(failureOutcomeForHttpStatus(503), "indeterminate");

  const urlOne = buildPollinationsUrl("a calm landscape", "dreamshaper", "1024x1024", "request-1");
  const urlReplay = buildPollinationsUrl("a calm landscape", "dreamshaper", "1024x1024", "request-1");
  const urlOther = buildPollinationsUrl("a calm landscape", "dreamshaper", "1024x1024", "request-2");
  assert.equal(new URL(urlOne).searchParams.get("model"), "dreamshaper");
  assert.equal(new URL(urlOne).searchParams.get("seed"), new URL(urlReplay).searchParams.get("seed"));
  assert.notEqual(new URL(urlOne).searchParams.get("seed"), new URL(urlOther).searchParams.get("seed"));

  const definitiveCalls: string[] = [];
  const definitive = await executeImageGenerationWithProviders({
    prompt: "simple icon",
    requestKey: "stable-request",
    providers: [
      provider("refusal", async (context) => {
        definitiveCalls.push(context?.requestKey ?? "");
        throw new ImageProviderFailure("HTTP 400", "definitive", 400);
      }),
      provider("success", async (context) => {
        definitiveCalls.push(context?.requestKey ?? "");
        return { base64: "image" };
      }),
    ],
  });
  assert.equal(definitive.success, true);
  assert.deepEqual(definitiveCalls, ["stable-request", "stable-request"]);

  let rateLimitAttempts = 0;
  let rateLimitFallbackCalls = 0;
  const rateLimited = await executeImageGenerationWithProviders({
    prompt: "simple icon",
    requestKey: "rate-limited-request",
    providers: [
      provider("rate-limited", async () => {
        rateLimitAttempts += 1;
        throw new ImageProviderFailure("HTTP 429", "definitive", 429);
      }),
      provider("rate-limit-fallback", async () => {
        rateLimitFallbackCalls += 1;
        return { base64: "image" };
      }),
    ],
  });
  assert.equal(rateLimited.success, true);
  assert.equal(rateLimitAttempts, 2, "429 receives one safe same-provider retry");
  assert.equal(rateLimitFallbackCalls, 1, "429 may fall back after the definitive refusal repeats");

  let fallbackCalls = 0;
  const indeterminate = await executeImageGenerationWithProviders({
    prompt: "simple icon",
    requestKey: "stable-request",
    providers: [
      provider("dreamshaper", async () => {
        throw new ImageProviderFailure("timed out", "indeterminate");
      }),
      provider("flux", async () => {
        fallbackCalls += 1;
        return { base64: "image" };
      }),
    ],
  });
  assert.equal(indeterminate.success, true);
  assert.equal(fallbackCalls, 1, "a DreamShaper timeout must not prevent Flux fallback");

  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  await assert.rejects(
    () => executeImageGenerationWithProviders({
      prompt: "simple icon",
      requestKey: "aborted",
      signal: controller.signal,
      providers: [provider("unused", async () => ({ base64: "unused" }))],
    }),
    /user cancelled/,
  );

  console.log("Plan-tier image routing, quotas, idempotency, and retry-disposition checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
