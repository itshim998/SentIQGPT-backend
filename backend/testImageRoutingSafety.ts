import assert from "node:assert/strict";
import {
  executeImageGenerationWithProviders,
  getImageProviderOrder,
} from "./tools/imageGeneration/imageRouter";
import { getImageModelForPlan, resolveImageRoute } from "./billing/modelEntitlementRouter";
import { getPlanCatalog } from "./billing/planCatalog";
import {
  buildPollinationsUrl,
  describePollinationsRequest,
} from "./tools/imageGeneration/pollinationsUtils";
import { PollinationsImageModelProvider } from "./tools/imageGeneration/providers/pollinationsImageModelProvider";
import {
  ImageProviderFailure,
  failureOutcomeForHttpStatus,
  requireImageModelPreference,
  type ImageModelPreference,
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

function routeOrder(planCode: "free" | "student_core" | "premium" | "pro", prompt: string, requiresTextRendering = false): readonly string[] {
  const route = getImageModelForPlan(planCode, requiresTextRendering);
  return getImageProviderOrder(prompt, route.adapterModelOverride);
}

async function main(): Promise<void> {
  const imageQuotas = Object.fromEntries(
    getPlanCatalog().map((plan) => [plan.code, plan.entitlements.quotas.image_generation]),
  );
  assert.deepEqual(imageQuotas.free, { limit: 2, windowSeconds: 86_400, label: "Images" });
  assert.deepEqual(imageQuotas.student_core, { limit: 4, windowSeconds: 43_200, label: "Images" });
  assert.deepEqual(imageQuotas.premium, { limit: 8, windowSeconds: 43_200, label: "Images" });
  assert.deepEqual(imageQuotas.pro, { limit: 16, windowSeconds: 43_200, label: "Images" });

  assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");
  assert.equal(getImageModelForPlan("free", true).model, "dreamshaper");
  assert.equal(getImageModelForPlan("student_core", false).model, "zimage");
  assert.equal(getImageModelForPlan("student_core", true).model, "zimage");
  assert.equal(getImageModelForPlan("premium", false).model, "zimage");
  assert.equal(getImageModelForPlan("premium", true).model, "zimage");
  assert.equal(getImageModelForPlan("pro", false).model, "zimage");
  assert.equal(getImageModelForPlan("pro", true).model, "zimage");

  assert.deepEqual(routeOrder("free", "a puppy in snow").slice(0, 2), ["dreamshaper", "flux"]);
  assert.deepEqual(routeOrder("free", "a detailed poster with text").slice(0, 2), ["dreamshaper", "flux"]);
  assert.deepEqual(routeOrder("student_core", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("student_core", "a poster reading Welcome", true).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("premium", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("premium", "a detailed poster with text", true).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("pro", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);
  assert.deepEqual(routeOrder("pro", "a detailed poster with text", true).slice(0, 2), ["zimage", "klein"]);

  // Intuitive mode routing assertions
  assert.equal(resolveImageRoute({ planCode: "free", executionMode: "intuitive" }).model, "dreamshaper");
  assert.equal(resolveImageRoute({ planCode: "student_core", executionMode: "intuitive" }).model, "tongyi-mai/z-image-turbo");
  assert.equal(resolveImageRoute({ planCode: "premium", executionMode: "intuitive" }).model, "tongyi-mai/z-image-turbo");
  assert.equal(resolveImageRoute({ planCode: "pro", executionMode: "intuitive" }).model, "tongyi-mai/z-image-turbo");
  assert.equal(resolveImageRoute({ planCode: "pro", executionMode: "intuitive", requiresTextRendering: true }).model, "tongyi-mai/z-image-turbo");
  assert.deepEqual(
    getImageProviderOrder("a poster", "tongyi-mai/z-image-turbo").slice(0, 2),
    ["tongyi-mai/z-image-turbo", "black-forest-labs/flux.2-klein-4b"],
  );
  assert.equal(getImageProviderOrder("a puppy in snow", "flux")[0], "flux");
  assert.deepEqual(
    getImageProviderOrder("a puppy in snow", "unexpected-model" as ImageModelPreference).slice(0, 2),
    ["dreamshaper", "flux"],
    "an unexpected runtime preference degrades to the safe ordinary chain",
  );
  assert.deepEqual(getImageProviderOrder("a poster", "gptimage").slice(0, 2), ["gptimage", "flux"]);

  assert.equal(requireImageModelPreference("GPT-IMAGE-2"), "gpt-image-2");
  assert.equal(requireImageModelPreference("tongyi-mai/z-image-turbo"), "tongyi-mai/z-image-turbo");
  assert.equal(requireImageModelPreference("black-forest-labs/flux.2-klein-4b"), "black-forest-labs/flux.2-klein-4b");
  assert.throws(() => requireImageModelPreference("unknown-image-model"), /Unsupported image model preference/);
  assert.equal(new PollinationsImageModelProvider("klein").name, "klein");
  assert.equal(new PollinationsImageModelProvider("kontext").name, "kontext");
  assert.equal(new PollinationsImageModelProvider("tongyi-mai/z-image-turbo").name, "tongyi-mai/z-image-turbo");
  assert.equal(new PollinationsImageModelProvider("black-forest-labs/flux.2-klein-4b").name, "black-forest-labs/flux.2-klein-4b");

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

  const zTurboUrl = buildPollinationsUrl("a poster reading SENTIQ", "tongyi-mai/z-image-turbo");
  const kleinUrl = buildPollinationsUrl("a poster reading SENTIQ", "black-forest-labs/flux.2-klein-4b");
  assert.equal(new URL(zTurboUrl).searchParams.get("model"), "tongyi-mai/z-image-turbo");
  assert.equal(new URL(kleinUrl).searchParams.get("model"), "black-forest-labs/flux.2-klein-4b");
  assert(zTurboUrl.includes("model=tongyi-mai%2Fz-image-turbo"), "z-image-turbo must be properly URL encoded");
  assert(kleinUrl.includes("model=black-forest-labs%2Fflux.2-klein-4b"), "flux.2-klein-4b must be properly URL encoded");

  const secretBearingUrl = `${urlOne}&key=do-not-log-this-secret`;
  const safeDiagnostic = describePollinationsRequest(secretBearingUrl, true);
  assert.match(safeDiagnostic, /model=dreamshaper/);
  assert.match(safeDiagnostic, /width=1024 height=1024 auth=true/);
  assert(!safeDiagnostic.includes("do-not-log-this-secret"));
  assert(!safeDiagnostic.includes("a%20calm%20landscape"));
  assert(!safeDiagnostic.includes("seed="));
  assert(!safeDiagnostic.includes("key="));

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

  console.log("Plan-tier image routing, typed preferences, safe logging, quotas, idempotency, and retry checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
