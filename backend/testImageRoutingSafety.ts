import assert from "node:assert/strict";
import {
  executeImageGenerationWithProviders,
} from "./tools/imageGeneration/imageRouter";
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

async function main(): Promise<void> {
  assert.equal(failureOutcomeForHttpStatus(400), "definitive");
  assert.equal(failureOutcomeForHttpStatus(429), "definitive");
  assert.equal(failureOutcomeForHttpStatus(408), "indeterminate");
  assert.equal(failureOutcomeForHttpStatus(503), "indeterminate");
  const urlOne = buildPollinationsUrl("a calm landscape", "zimage", "1024x1024", "request-1");
  const urlReplay = buildPollinationsUrl("a calm landscape", "zimage", "1024x1024", "request-1");
  const urlOther = buildPollinationsUrl("a calm landscape", "zimage", "1024x1024", "request-2");
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

  let forbiddenCalls = 0;
  const indeterminate = await executeImageGenerationWithProviders({
    prompt: "simple icon",
    requestKey: "stable-request",
    providers: [
      provider("timeout", async () => {
        throw new ImageProviderFailure("timed out", "indeterminate");
      }),
      provider("must-not-run", async () => {
        forbiddenCalls += 1;
        return { base64: "duplicate-risk" };
      }),
    ],
  });
  assert.equal(indeterminate.success, false);
  assert.equal(forbiddenCalls, 0, "indeterminate outcomes must stop cross-provider fallback");

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

  console.log("Image routing idempotency and retry-disposition checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
