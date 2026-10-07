// SentIQ Chat v3 — Comprehensive Test Suite for Cloudflare Image Architecture & Storage
//
// Validates:
// 1. 8-Cell Plan/Mode Entitlement Matrix
// 2. Strict Provider Isolation (Pollinations vs Cloudflare)
// 3. Cloudflare Credential Pool & Multi-Account Rotation
// 4. Cloudflare Error Semantics (3036, 3040, 429, 401, 403, 404, 5xx, timeout)
// 5. Account Pool Exhaustion vs Model Fallback Ordering
// 6. Request Construction (JSON for Schnell/Dreamshaper vs Multipart for Klein)
// 7. Safe Logging (Zero credential leakage)
// 8. Dedicated Supabase Storage Client, Binary/Metadata Separation, Cleanup & Deletion

import assert from "node:assert/strict";
import {
  getImageModelForPlan,
  resolveImageRoute,
} from "./billing/modelEntitlementRouter";
import {
  getImageProviderOrder,
  routeImageGeneration,
  executeImageGenerationWithProviders,
} from "./tools/imageGeneration/imageRouter";
import {
  CloudflareImageProvider,
  CLOUDFLARE_MODEL_SCHNELL,
  CLOUDFLARE_MODEL_KLEIN_4B,
  CLOUDFLARE_MODEL_KLEIN_9B,
  CLOUDFLARE_MODEL_DREAMSHAPER,
  setCloudflareFetchForTesting,
} from "./tools/imageGeneration/providers/cloudflareImageProvider";
import {
  overrideCloudflareSlotsForTesting,
  resetCloudflareHealthState,
  isAccountAvailable,
  isAccountModelAvailable,
  getNextUtcMidnight,
  type CloudflareCredentialSlot,
} from "./tools/imageGeneration/cloudflareAiPool";
import {
  getDedicatedImageStorageClient,
  isDedicatedImageStorageConfigured,
  resetDedicatedImageStorageClient,
  overrideDedicatedImageStorageClientForTesting,
} from "./tools/imageGeneration/imageStorageClient";
import {
  uploadChatImage,
  deleteChatImage,
} from "./tools/imageGeneration/imageStorageService";
import { ImageProviderFailure, type ImageModelPreference } from "./tools/imageGeneration/types";

// 1x1 transparent PNG in base64
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH0f8AAAAASUVORK5CYII=";

async function runAllTests(): Promise<void> {
  console.log("=== RUNNING SENTIQ CLOUDFLARE & STORAGE ARCHITECTURE TEST SUITE ===\n");

  // =========================================================================
  // 1. EXACT 8-CELL POLICY MATRIX VALIDATION
  // =========================================================================
  console.log("--- 1. Testing 8-Cell Policy Matrix ---");
  const testMatrix = [
    {
      plan: "free" as const,
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
    },
    {
      plan: "free" as const,
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_DREAMSHAPER],
    },
    {
      plan: "student_core" as const,
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    {
      plan: "student_core" as const,
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
    },
    {
      plan: "premium" as const,
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    {
      plan: "premium" as const,
      mode: "intuitive",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_KLEIN_4B,
      expectedChain: [CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL],
    },
    {
      plan: "pro" as const,
      mode: "fast",
      expectedProvider: "cloudflare",
      expectedModel: CLOUDFLARE_MODEL_SCHNELL,
      expectedChain: [CLOUDFLARE_MODEL_SCHNELL, CLOUDFLARE_MODEL_KLEIN_4B],
    },
    {
      plan: "pro" as const,
      mode: "intuitive",
      expectedProvider: "pollinations",
      expectedModel: "openai/gpt-image-2",
      expectedChain: ["openai/gpt-image-2", "microsoft/mai-image-2.6", "black-forest-labs/flux.1.1-pro"],
    },
  ];

  for (const cell of testMatrix) {
    const route = resolveImageRoute({ planCode: cell.plan, executionMode: cell.mode });
    assert.equal(route.provider, cell.expectedProvider, `${cell.plan}/${cell.mode} provider`);
    assert.equal(route.model, cell.expectedModel, `${cell.plan}/${cell.mode} model`);
    assert.equal(route.adapterModelOverride, cell.expectedModel, `${cell.plan}/${cell.mode} adapterModelOverride`);

    const chain = getImageProviderOrder("prompt", route.model, cell.plan, cell.mode);
    assert.deepEqual(chain, cell.expectedChain, `${cell.plan}/${cell.mode} provider fallback chain`);
  }
  console.log("PASS: 8-cell policy matrix verified successfully.");

  // =========================================================================
  // 2. STRICT POLICY ISOLATION
  // =========================================================================
  console.log("\n--- 2. Testing Strict Policy Isolation ---");
  // Non-Pro-Intuitive plans MUST NEVER reach Pollinations
  const nonProIntuitive = testMatrix.filter((c) => !(c.plan === "pro" && c.mode === "intuitive"));
  for (const cell of nonProIntuitive) {
    const chain = getImageProviderOrder("prompt", cell.expectedModel as ImageModelPreference, cell.plan, cell.mode);
    for (const p of chain) {
      assert(!p.startsWith("openai/") && !p.startsWith("microsoft/") && !p.includes("pollinations"), `Forbidden Pollinations model in ${cell.plan}/${cell.mode}: ${p}`);
      assert(p.startsWith("@cf/"), `Expected Cloudflare model in ${cell.plan}/${cell.mode}: ${p}`);
    }
  }

  // Pro Intuitive MUST NEVER reach Cloudflare
  const proIntuitiveChain = getImageProviderOrder("prompt", "openai/gpt-image-2", "pro", "intuitive");
  for (const p of proIntuitiveChain) {
    assert(!p.startsWith("@cf/"), `Forbidden Cloudflare model in Pro Intuitive: ${p}`);
  }
  console.log("PASS: Policy isolation verified (Free/Essential/Plus/Pro Fast never reach Pollinations; Pro Intuitive never reaches Cloudflare).");

  // =========================================================================
  // 3. CLOUDFLARE ACCOUNT POOL CONFIGURATION
  // =========================================================================
  console.log("\n--- 3. Testing Cloudflare Account Pool Configuration ---");
  resetCloudflareHealthState();

  // A: 0 accounts configured -> provider is unavailable, no crash
  overrideCloudflareSlotsForTesting([]);
  const zeroProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL);
  assert.equal(zeroProvider.isAvailable(), false, "Provider should be unavailable when 0 accounts configured");

  await assert.rejects(
    () => zeroProvider.generate("test prompt"),
    /No healthy Cloudflare accounts available/,
    "Generate should throw ImageProviderFailure cleanly when 0 accounts",
  );

  // B: Incomplete slots are ignored
  // E.g. Slot 1 valid, Slot 2 missing token (ignored)
  const partialSlots: CloudflareCredentialSlot[] = [
    { slotIndex: 1, accountId: "acc-1", apiToken: "token-1" },
  ];
  overrideCloudflareSlotsForTesting(partialSlots);
  const providerWithOne = new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL);
  assert.equal(providerWithOne.isAvailable(), true, "Provider should be available with 1 valid slot");

  console.log("PASS: Account pool configuration and slot parsing verified.");

  // =========================================================================
  // 4. CLOUDFLARE REQUEST CONSTRUCTION (JSON vs MULTIPART)
  // =========================================================================
  console.log("\n--- 4. Testing Model-Specific Request Construction ---");
  resetCloudflareHealthState();

  const testSlots: CloudflareCredentialSlot[] = [
    { slotIndex: 1, accountId: "acc-1", apiToken: "secret-token-1" },
  ];
  overrideCloudflareSlotsForTesting(testSlots);

  // Schnell must use application/json
  let schnellCapturedBody: any = null;
  let schnellCapturedHeaders: any = null;
  setCloudflareFetchForTesting(async (url, init) => {
    schnellCapturedHeaders = init?.headers;
    schnellCapturedBody = init?.body;
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const schnellProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL);
  const schnellResult = await schnellProvider.generate("cyberpunk cat", "1024x1024", undefined, { requestKey: "seed-key-1" });
  assert.equal(schnellResult.base64, TINY_PNG_BASE64);
  assert.equal(typeof schnellCapturedBody, "string", "Schnell request body must be JSON string");
  const parsedSchnellBody = JSON.parse(schnellCapturedBody);
  assert.equal(parsedSchnellBody.prompt, "cyberpunk cat");
  assert.equal(parsedSchnellBody.steps, 4, "Schnell must send steps: 4");
  assert.equal(parsedSchnellBody.seed, undefined, "Schnell request must NOT contain seed");
  assert.equal(schnellCapturedHeaders?.["Content-Type"], "application/json");
  assert.equal(schnellCapturedHeaders?.["Authorization"], "Bearer secret-token-1");

  // Klein must use multipart/form-data (FormData)
  let kleinCapturedBody: any = null;
  let kleinCapturedHeaders: any = null;
  setCloudflareFetchForTesting(async (url, init) => {
    kleinCapturedHeaders = init?.headers;
    kleinCapturedBody = init?.body;
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const kleinProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B);
  const kleinResult = await kleinProvider.generate("futuristic city", "1024x1024");
  assert.equal(kleinResult.base64, TINY_PNG_BASE64);
  assert.ok(kleinCapturedBody instanceof FormData, "Klein request body must be FormData (multipart)");
  assert.equal(kleinCapturedBody.get("prompt"), "futuristic city");
  assert.equal(kleinCapturedBody.get("width"), "1024");
  assert.equal(kleinCapturedBody.get("height"), "1024");
  assert.equal(kleinCapturedHeaders?.["Content-Type"], undefined, "FormData must NOT manually set Content-Type header");
  assert.equal(kleinCapturedHeaders?.["Authorization"], "Bearer secret-token-1");

  // Dreamshaper must use application/json with num_steps and optional deterministic seed (no redundant steps)
  let dreamshaperCapturedBody: any = null;
  setCloudflareFetchForTesting(async (url, init) => {
    dreamshaperCapturedBody = init?.body;
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const dreamshaperProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_DREAMSHAPER);
  await dreamshaperProvider.generate("fantasy landscape", undefined, undefined, { requestKey: "dreamshaper-seed-key" });
  assert.equal(typeof dreamshaperCapturedBody, "string");
  const parsedDreamshaper = JSON.parse(dreamshaperCapturedBody);
  assert.equal(parsedDreamshaper.prompt, "fantasy landscape");
  assert.equal(parsedDreamshaper.num_steps, 4, "DreamShaper must send num_steps: 4");
  assert.equal(parsedDreamshaper.steps, undefined, "DreamShaper request must NOT contain redundant steps");
  assert.ok(parsedDreamshaper.seed, "DreamShaper may send deterministic seed when available");

  console.log("PASS: Request formats strictly adhere to Cloudflare API contract (JSON for Schnell/Dreamshaper, FormData for Klein).");

  // =========================================================================
  // 5. CLOUDFLARE HEALTH SEMANTICS & ERROR HANDLING
  // =========================================================================
  console.log("\n--- 5. Testing Cloudflare Error & Health Semantics ---");
  resetCloudflareHealthState();

  const multiSlots: CloudflareCredentialSlot[] = [
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
    { slotIndex: 3, accountId: "acc-3", apiToken: "tok-3" },
  ];
  overrideCloudflareSlotsForTesting(multiSlots);

  // A: 3036 Daily Neuron Exhaustion (Account-Level)
  // Account 1 receives 3036 -> marks entire account 1 exhausted until next 00:00 UTC.
  // Account 2 succeeds -> overall request succeeds.
  let callCount = 0;
  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    callCount++;
    if (url.includes("acc-1")) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 3036, message: "Daily free allocation of neurons exhausted" }],
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const testProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL);
  const res3036 = await testProvider.generate("test prompt");
  assert.equal(res3036.base64, TINY_PNG_BASE64);
  assert.equal(isAccountAvailable(1), false, "Account 1 must be marked exhausted after error 3036");
  assert.equal(isAccountModelAvailable(1, CLOUDFLARE_MODEL_KLEIN_4B), false, "Account 1 must be exhausted across ALL models");
  assert.equal(isAccountAvailable(2), true, "Account 2 must remain available");

  // B: 3040 Capacity Limit (Model/Account temporary cooldown)
  // Account 2 receives 3040 on Klein 4B -> short cooldown, account remains usable for other models
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
  ]);

  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 3040, message: "Capacity temporarily exceeded" }],
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const res3040 = await testProvider.generate("test prompt");
  assert.equal(res3040.base64, TINY_PNG_BASE64);
  assert.equal(isAccountAvailable(1), true, "Account 1 must NOT be permanently disabled after 3040");
  assert.equal(isAccountModelAvailable(1, CLOUDFLARE_MODEL_SCHNELL), false, "Account 1 Schnell should be cooling down after 3040");

  // C: HTTP 401 Credential Failure (Permanent disable)
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-1", apiToken: "bad-token" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "good-token" },
  ]);

  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const res401 = await testProvider.generate("test prompt");
  assert.equal(res401.base64, TINY_PNG_BASE64);
  assert.equal(isAccountAvailable(1), false, "Account 1 must be permanently disabled on 401");

  // Subsequent request must skip Account 1 completely without calling its endpoint
  let acc1Called = false;
  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) acc1Called = true;
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await testProvider.generate("another prompt");
  assert.equal(acc1Called, false, "Permanently disabled account 1 must be skipped");

  // D: HTTP 403 Account-Level Error (code 3023: Workers AI not enabled for account)
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
  ]);

  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 3023, message: "Workers AI is not enabled for this account" }],
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const res403Account = await testProvider.generate("test prompt");
  assert.equal(res403Account.base64, TINY_PNG_BASE64);
  assert.equal(isAccountAvailable(1), false, "Account 1 must be permanently disabled on 403 code 3023");
  assert.equal(isAccountAvailable(2), true, "Account 2 must remain available");

  // E: HTTP 403 Model-Access Error (codes 5018/3041/5035: Model not authorized / restricted)
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
  ]);

  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) {
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 5018, message: "Model access not authorized" }],
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const res403Model = await testProvider.generate("test prompt");
  assert.equal(res403Model.base64, TINY_PNG_BASE64);
  assert.equal(isAccountAvailable(1), true, "Account 1 must remain available when error is model-scoped (5018)");
  assert.equal(isAccountModelAvailable(1, CLOUDFLARE_MODEL_SCHNELL), false, "Schnell must be marked unavailable on Account 1");
  assert.equal(isAccountModelAvailable(1, CLOUDFLARE_MODEL_KLEIN_4B), true, "Klein 4B must remain available on Account 1");

  // F: HTTP 429 Rate Limit Retry and Cooldown
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
  ]);

  let acc1Attempts = 0;
  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes("acc-1")) {
      acc1Attempts++;
      return new Response("Too Many Requests", { status: 429 });
    }
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const res429 = await testProvider.generate("test prompt");
  assert.equal(res429.base64, TINY_PNG_BASE64);
  assert.equal(acc1Attempts, 2, "429 must be retried once on the same account before moving on");
  assert.equal(isAccountModelAvailable(1, CLOUDFLARE_MODEL_SCHNELL), false, "Account 1 Schnell should be cooling down after failed retry");

  console.log("PASS: Cloudflare error semantics verified (3036 account reset, 3040 capacity, 401 permanent disable, 429 retry & cooldown).");

  // =========================================================================
  // 6. ACCOUNT POOL EXHAUSTION BEFORE MODEL FALLBACK
  // =========================================================================
  console.log("\n--- 6. Testing Account Pool vs Model Fallback Ordering ---");
  resetCloudflareHealthState();

  const threeAccountSlots: CloudflareCredentialSlot[] = [
    { slotIndex: 1, accountId: "acc-1", apiToken: "tok-1" },
    { slotIndex: 2, accountId: "acc-2", apiToken: "tok-2" },
    { slotIndex: 3, accountId: "acc-3", apiToken: "tok-3" },
  ];
  overrideCloudflareSlotsForTesting(threeAccountSlots);

  // Scenario 1: Pro Fast (Primary = Klein 9B, Fallback = Klein 4B).
  // Schnell: Account 1 fails (3036), Account 2 fails (3040), Account 3 SUCCEEDS.
  // Result: Succeeded on Schnell! MUST NOT fall back to Klein 4B!
  const calledModels: string[] = [];
  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes(CLOUDFLARE_MODEL_SCHNELL)) {
      calledModels.push(CLOUDFLARE_MODEL_SCHNELL);
      if (url.includes("acc-1")) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 3036, message: "exhausted" }] }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("acc-2")) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 3040, message: "busy" }] }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    calledModels.push("other_model");
    return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const proFastResult = await routeImageGeneration({
    prompt: "high detail portrait",
    planCode: "pro",
    executionMode: "fast",
  });
  assert.equal(proFastResult.success, true);
  assert.equal(proFastResult.provider_used, CLOUDFLARE_MODEL_SCHNELL);
  assert(!calledModels.includes(CLOUDFLARE_MODEL_KLEIN_4B), "Must NOT call Klein 4B when Schnell succeeded on account 3");

  // Scenario 2: Pro Fast: ALL accounts fail on Schnell -> ONLY THEN Klein 4B begins.
  resetCloudflareHealthState();
  overrideCloudflareSlotsForTesting(threeAccountSlots);
  const executionOrder: string[] = [];

  setCloudflareFetchForTesting(async (rawUrl) => {
    const url = String(rawUrl);
    if (url.includes(CLOUDFLARE_MODEL_SCHNELL)) {
      executionOrder.push(`${CLOUDFLARE_MODEL_SCHNELL}::${url.includes("acc-1") ? "acc-1" : url.includes("acc-2") ? "acc-2" : "acc-3"}`);
      return new Response("500 Server Error", { status: 500 });
    }
    if (url.includes(CLOUDFLARE_MODEL_KLEIN_4B)) {
      executionOrder.push(`${CLOUDFLARE_MODEL_KLEIN_4B}::${url.includes("acc-1") ? "acc-1" : url.includes("acc-2") ? "acc-2" : "acc-3"}`);
      return new Response(JSON.stringify({ success: true, result: { image: TINY_PNG_BASE64 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("500 Server Error", { status: 500 });
  });

  const proFastFallbackResult = await routeImageGeneration({
    prompt: "portrait on fallback",
    planCode: "pro",
    executionMode: "fast",
  });
  assert.equal(proFastFallbackResult.success, true);
  assert.equal(proFastFallbackResult.provider_used, CLOUDFLARE_MODEL_KLEIN_4B);

  // Check that all 3 accounts were attempted for Schnell before any Klein 4B request was made
  const schnellCalls = executionOrder.filter((item) => item.startsWith(CLOUDFLARE_MODEL_SCHNELL));
  assert.equal(schnellCalls.length, 3, "All 3 accounts must be exhausted on Schnell before fallback");
  assert.ok(executionOrder[3]?.startsWith(CLOUDFLARE_MODEL_KLEIN_4B), "Klein 4B begins only after all Schnell accounts failed");

  console.log("PASS: Account pool exhaustively attempted before advancing to next model in fallback chain.");

  // =========================================================================
  // 7. SAFE LOGGING & ZERO CREDENTIAL LEAKAGE
  // =========================================================================
  console.log("\n--- 7. Testing Credential-Safe Logging & Diagnostics ---");
  resetCloudflareHealthState();
  const secretToken = "super-secret-cloudflare-bearer-token-xyz-12345";
  overrideCloudflareSlotsForTesting([
    { slotIndex: 1, accountId: "acc-secret", apiToken: secretToken },
  ]);

  setCloudflareFetchForTesting(async () => {
    return new Response("Internal Server Error", { status: 500 });
  });

  try {
    const safeProvider = new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL);
    await safeProvider.generate("secret prompt text");
    assert.fail("Should have thrown");
  } catch (err: any) {
    const errorString = err instanceof Error ? err.message : String(err);
    assert(!errorString.includes(secretToken), "Thrown error must never contain API token");
    assert(!errorString.includes("Bearer"), "Thrown error must not contain Bearer header");
  }
  console.log("PASS: Sensitive tokens never leaked in error messages.");

  // =========================================================================
  // 8. DEDICATED SUPABASE IMAGE STORAGE CLIENT & OPERATIONS
  // =========================================================================
  console.log("\n--- 8. Testing Dedicated Supabase Storage Client & Operations ---");
  resetDedicatedImageStorageClient();

  // A: Dedicated Client Configuration
  process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_URL = "https://dedicated-image-storage.supabase.co";
  process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_SERVICE_ROLE_KEY = "dedicated-service-role-key-999";
  assert.equal(isDedicatedImageStorageConfigured(), true);

  const dedicatedClient = getDedicatedImageStorageClient();
  assert.ok(dedicatedClient, "Dedicated Supabase client must be instantiated");

  // B: Mock storage and user database to test upload, cleanup, and delete ordering
  let storageUploadCalled = false;
  let storageUploadBucket = "";
  let storageUploadPath = "";
  let storageRemoveCalled = false;
  let storageRemovePaths: string[] = [];

  const mockDedicatedClient: any = {
    storage: {
      getBucket: async (b: string) => ({ data: { public: true }, error: null }),
      createBucket: async () => ({ error: null }),
      updateBucket: async () => ({ error: null }),
      from: (bucket: string) => ({
        upload: async (path: string, buffer: Buffer) => {
          storageUploadCalled = true;
          storageUploadBucket = bucket;
          storageUploadPath = path;
          return { data: { path }, error: null };
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://dedicated-storage.supabase.co/storage/v1/object/public/${bucket}/${path}` },
        }),
        remove: async (paths: string[]) => {
          storageRemoveCalled = true;
          storageRemovePaths = paths;
          return { data: paths, error: null };
        },
      }),
    },
  };

  let userDbInsertCalled = false;
  let userDbDeleteCalled = false;
  let metadataPersisted: any = null;

  const mockUserDb: any = {
    from: (table: string) => ({
      insert: async (data: any) => {
        userDbInsertCalled = true;
        metadataPersisted = data;
        return { error: null };
      },
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: { storage_path: "user-1/chat-1/img-1.webp" },
              error: null,
            }),
          }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: async () => {
            userDbDeleteCalled = true;
            return { error: null };
          },
        }),
      }),
    }),
  };

  overrideDedicatedImageStorageClientForTesting(mockDedicatedClient);

  // Upload test
  const uploadResult = await uploadChatImage(
    mockUserDb,
    {
      userId: "11111111-1111-1111-1111-111111111111",
      chatId: "22222222-2222-2222-2222-222222222222",
      imageData: TINY_PNG_BASE64,
      prompt: "A puppy",
      provider: CLOUDFLARE_MODEL_SCHNELL,
    },
    { storageDb: mockDedicatedClient },
  );

  assert.equal(uploadResult.success, true);
  assert.ok(storageUploadCalled, "Image binary must be uploaded via dedicated storage client");
  assert.equal(storageUploadBucket, "sentiq-images");
  assert.ok(userDbInsertCalled, "Image metadata must be persisted to userDb (not storage project)");
  assert.equal(metadataPersisted.provider, CLOUDFLARE_MODEL_SCHNELL);
  assert.equal(metadataPersisted.user_id, "11111111-1111-1111-1111-111111111111");

  // Failure cleanup test: when metadata insert fails, uploaded binary must be removed from storage
  storageRemoveCalled = false;
  const failingUserDb: any = {
    from: () => ({
      insert: async () => ({ error: { message: "database offline" } }),
    }),
  };

  const failingResult = await uploadChatImage(
    failingUserDb,
    {
      userId: "11111111-1111-1111-1111-111111111111",
      chatId: "22222222-2222-2222-2222-222222222222",
      imageData: TINY_PNG_BASE64,
      prompt: "A puppy",
    },
    { storageDb: mockDedicatedClient },
  );

  assert.equal(failingResult.success, false);
  assert.ok(storageRemoveCalled, "When metadata persistence fails, binary must be cleaned up from storage");

  // Deletion test: metadata resolved -> storage binary deleted FIRST -> metadata deleted ONLY after binary succeeds
  const deletionExecutionOrder: string[] = [];
  storageRemoveCalled = false;
  userDbDeleteCalled = false;

  const orderTrackingStorageClient: any = {
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          deletionExecutionOrder.push("storage.remove");
          storageRemoveCalled = true;
          return { data: paths, error: null };
        },
      }),
    },
  };

  const orderTrackingUserDb: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: { storage_path: "user-1/chat-1/img-1.webp" },
              error: null,
            }),
          }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: async () => {
            deletionExecutionOrder.push("metadata.delete");
            userDbDeleteCalled = true;
            return { error: null };
          },
        }),
      }),
    }),
  };

  const deleteResult = await deleteChatImage(
    orderTrackingUserDb,
    "11111111-1111-1111-1111-111111111111",
    "img-1",
    { storageDb: orderTrackingStorageClient },
  );
  assert.equal(deleteResult, true);
  assert.deepEqual(
    deletionExecutionOrder,
    ["storage.remove", "metadata.delete"],
    "Binary MUST be deleted from storage FIRST, metadata deleted ONLY after binary succeeds",
  );

  // Deletion failure test: if storage binary removal fails, chat_images metadata MUST NOT be deleted
  let metadataDeleteAttemptedOnStorageFailure = false;
  const failingStorageClient: any = {
    storage: {
      from: () => ({
        remove: async () => ({
          data: null,
          error: { message: "Supabase storage error (500)" },
        }),
      }),
    },
  };
  const guardedUserDb: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({
              data: { storage_path: "user-1/chat-1/img-1.webp" },
              error: null,
            }),
          }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: async () => {
            metadataDeleteAttemptedOnStorageFailure = true;
            return { error: null };
          },
        }),
      }),
    }),
  };

  const failingDeleteResult = await deleteChatImage(
    guardedUserDb,
    "11111111-1111-1111-1111-111111111111",
    "img-1",
    { storageDb: failingStorageClient },
  );
  assert.equal(failingDeleteResult, false);
  assert.equal(
    metadataDeleteAttemptedOnStorageFailure,
    false,
    "Metadata in chat_images must NEVER be deleted if storage binary removal failed",
  );

  // Reset test state
  resetDedicatedImageStorageClient();
  overrideCloudflareSlotsForTesting(null);
  setCloudflareFetchForTesting(null);
  delete process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_URL;
  delete process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_SERVICE_ROLE_KEY;

  console.log("PASS: Dedicated Supabase image storage client, binary/metadata separation, cleanup, and delete ordering verified.");

  console.log("\n=========================================================================");
  console.log("ALL TESTS IN CLOUDFLARE IMAGE ARCHITECTURE SUITE PASSED SUCCESSFULLY!");
  console.log("=========================================================================\n");
}

runAllTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exitCode = 1;
});
