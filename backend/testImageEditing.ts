import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { executeImageEdit, type ImageEditingDependencies } from "./services/imageEditingService";
import { ImageEditRequestSchema, validateEditInput, validateEditRaster } from "./tools/imageGeneration/imageEditValidation";
import { getImageEditModelIds, supportsImageEdit } from "./tools/imageGeneration/imageEditPolicy";
import { routeImageGeneration, getImageProviderOrder } from "./tools/imageGeneration/imageRouter";
import { CloudflareImageProvider, CLOUDFLARE_MODEL_KLEIN_4B, CLOUDFLARE_MODEL_SCHNELL, setCloudflareFetchForTesting } from "./tools/imageGeneration/providers/cloudflareImageProvider";
import { PollinationsImageModelProvider } from "./tools/imageGeneration/providers/pollinationsImageModelProvider";
import { overrideCloudflareSlotsForTesting, resetCloudflareHealthState } from "./tools/imageGeneration/cloudflareAiPool";
import { compressImage, uploadEditedImageArtifact, loadOwnedEditSource } from "./tools/imageGeneration/imageStorageService";
import { ImageGenerateRequestSchema } from "./validation/schemas";
import type { BillingPlanCode } from "./billing/entitlementTypes";
import { persistEditedImageResult } from "./services/generatedImagePersistenceService";
import { verifyEditedImageArtifact } from "./tools/imageGeneration/imageStorageService";
import { readEditProviderResponse } from "./tools/imageGeneration/imageEditValidation";
import { getChatImages } from "./tools/imageGeneration/imageStorageService";
import { dispatchAutomaticModelToolCall } from "./ai/modelToolExecution";
import { commitImageQuotaSuccess, getQuotaInfo } from "./middleware/imageQuota";

const userId = randomUUID(), conversationId = randomUUID(), sourceImageId = randomUUID();
const input = { sourceImageId, conversationId, clientRequestId: "edit-1", prompt: "Make the wall green" };
const source = () => sharp({ create: { width: 800, height: 600, channels: 4, background: "#ff000080" } }).png().toBuffer();
const code = (value: string) => (error: any) => error?.code === value;

function fixture(plan: BillingPlanCode = "student_core") {
  let row: any;
  let calls = 0, reservations = 0, commits = 0, releases = 0, versions = 0, messages = 0;
  let committed = false;
  let settleFail = false, completeFail = false, checkpointLost = false;
  let providerFail = false;
  const ledger = new Set<string>();
  const db: any = {
    rpc: async (name: string, args: any) => {
      if (name === "claim_image_edit") {
        if (!row) row = { request_id: args.p_request_id, image_id: randomUUID(), fingerprint: args.p_fingerprint,
          lease_token: args.p_lease_token, status: "claimed", acquired: true, source_image_id: args.p_source_image_id,
          operation_metadata: args.p_metadata };
        else {
          if (row.fingerprint !== args.p_fingerprint) return { data: { conflict: true } };
          if (row.yielded) { row.lease_token = args.p_lease_token; row.yielded = false; }
          row.acquired = row.lease_token === args.p_lease_token;
        }
      } else if (name === "transition_image_edit") row.status = args.p_status;
      else if (name === "record_image_edit_artifact") {
        if (!row.artifact) versions++;
        row.artifact = args.p_artifact; row.status = "generated";
        if (checkpointLost) { checkpointLost = false; return { error: { message: "lost response" } }; }
      } else if (name === "complete_image_edit") {
        if (!row.assistant_message_id) { messages++; row.assistant_message_id = randomUUID(); }
        row.status = "completed";
        if (completeFail) { completeFail = false; return { error: { message: "lost response" } }; }
      } else throw new Error(`Unexpected RPC ${name}`);
      return { data: structuredClone(row), error: null };
    },
    from: (table: string) => {
      const q: any = { update: () => q, select: () => q, eq: () => q, in: () => q,
        maybeSingle: async () => ({ data: table === "conversations" ? { id: conversationId } : structuredClone(row), error: null }),
        then: (resolve: any) => { if (["claimed", "storing", "generated"].includes(row.status)) row.yielded = true; return Promise.resolve({ error: null }).then(resolve); } };
      return q;
    },
  };
  const deps: ImageEditingDependencies = {
    billing: {
      resolvePlanCodeForImageBilling: async () => plan,
      reserveFeature: async (args) => {
        reservations++;
        assert.equal(args.units, plan === "pro" && args.metadata?.execution_mode === "intuitive" ? 8 : 2);
        assert.equal(args.feature, "image_generation");
        assert.equal(args.metadata?.image_edit, true);
        return { ...args.route, requestId: args.requestId, planCode: plan, remaining: 10, limit: 12,
          reservedUnits: args.units!, resetAt: null, feature: "image_generation", idempotent: committed,
          status: committed ? "committed" : "reserved" };
      },
      commit: async (reservation, metadata) => {
        assert(row.artifact, "artifact must be durable before settlement");
        assert.equal(metadata?.actual_image_credits, reservation.model === CLOUDFLARE_MODEL_KLEIN_4B ? 2 : 8);
        if (settleFail) { settleFail = false; throw new Error("Control DB temporarily unavailable"); }
        ledger.add(reservation.requestId); commits++; committed = true;
      },
      releaseImageEditRequest: async () => { releases++; },
    },
    loadSource: async () => source(),
    route: async (args) => {
      assert(reservations > 0, "credits must be reserved before invocation");
      await args.beforeInvoke?.(); calls++;
      if (providerFail) return { success: false, prompt: args.prompt };
      return { success: true, prompt: args.prompt, image_base64: (await source()).toString("base64"),
        provider_used: getImageEditModelIds(plan, args.executionMode)[0] };
    },
    persist: async (params) => {
      const artifact = { imageUrl: "https://cdn.example/output.webp", storagePath: `${userId}/${conversationId}/${params.imageId}.webp`,
        fileSizeBytes: 100, contentSha256: "b".repeat(64), provider: params.provider };
      const result = await db.rpc("record_image_edit_artifact", { p_artifact: artifact });
      if (result.error) throw new Error("checkpoint response lost");
      return artifact;
    },
  };
  const ctx = { userId, identity: { userId, isGuest: false, anonymousKeyHash: null }, userDb: db, storageDb: db };
  return { deps, ctx, run: (request: unknown = input) => executeImageEdit(request, ctx, deps),
    counts: () => ({ calls, reservations, commits, releases, versions, messages, charged: ledger.size }),
    failSettlement: () => { settleFail = true; }, failCompletion: () => { completeFail = true; },
    loseCheckpoint: () => { checkpointLost = true; }, failProvider: () => { providerFail = true; },
    row: () => row };
}

test("paid-only entitlement and strict source-aware contract", async () => {
  for (const plan of ["student_core", "premium", "pro"] as const) {
    const f = fixture(plan); assert.equal((await f.run()).success, true);
  }
  for (const identity of ["free", "guest"] as const) {
    const f = fixture(identity === "free" ? "free" : "pro");
    if (identity === "guest") f.ctx.identity.isGuest = true;
    await assert.rejects(f.run(), code("image_edit_paid_only"));
    assert.equal(f.counts().calls, 0); assert.equal(f.counts().reservations, 0);
  }
  for (const key of ["sourceUrl", "planCode", "model", "storagePath", "credits"]) {
    assert.equal(ImageEditRequestSchema.safeParse({ ...input, [key]: "untrusted" }).success, false);
  }
  assert.equal(ImageGenerateRequestSchema.safeParse({ prompt: "test", sourceImageId }).success, false);
  assert.equal(ImageGenerateRequestSchema.safeParse({ prompt: "test" }).success, true);
});

test("masks and unsupported operations fail before reservation or inference", async () => {
  const f = fixture();
  await assert.rejects(f.run({ ...input, operation: "remove_background" }), code("image_edit_operation_unsupported"));
  await assert.rejects(f.run({ ...input, operation: "erase_region" }), code("image_edit_invalid_file"));
  const pixels = Buffer.alloc(800 * 600 * 4, 255); pixels[3] = 0;
  const mask = await sharp(pixels, { raw: { width: 800, height: 600, channels: 4 } }).png().toBuffer();
  const valid = await validateEditInput(await source(), "erase_region", mask);
  assert(valid.mask);
  await assert.rejects(f.run({ ...input, operation: "erase_region", mask: mask.toString("base64") }), code("image_edit_operation_unsupported"));
  await assert.rejects(validateEditRaster(Buffer.from("<svg/>")), code("image_edit_invalid_file"));
  await assert.rejects(validateEditRaster(Buffer.alloc(8 * 1024 * 1024 + 1)), code("image_edit_invalid_file"));
  await assert.rejects(validateEditInput(await source(), "edit", mask), code("image_edit_invalid_file"));
  assert.equal(f.counts().reservations, 0); assert.equal(f.counts().calls, 0);
});

test("concurrent requests, completed replay and conflicting identities", async () => {
  const f = fixture();
  let proceed!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { proceed = resolve; });
  const route = f.deps.route!;
  f.deps.route = async (args) => { started(); await blocked; return route(args); };
  const first = f.run(); await ready;
  await assert.rejects(f.run(), code("image_edit_in_progress"));
  proceed(); const result = await first;
  const replay = await f.run(); assert.equal(replay.image_id, result.image_id); assert.equal(replay.deduplicated, true);
  await assert.rejects(f.run({ ...input, prompt: "different edit" }), code("image_edit_request_conflict"));
  assert.deepEqual(f.counts(), { calls: 1, reservations: 1, commits: 1, releases: 0, versions: 1, messages: 1, charged: 1 });
});

test("artifact recovery handles settlement failure and lost checkpoint/completion responses", async () => {
  for (const mode of ["settlement", "checkpoint", "completion"] as const) {
    const f = fixture();
    if (mode === "settlement") f.failSettlement();
    if (mode === "checkpoint") f.loseCheckpoint();
    if (mode === "completion") f.failCompletion();
    await assert.rejects(f.run());
    const recovered = await f.run(); assert.equal(recovered.success, true);
    assert.equal(f.counts().calls, 1); assert.equal(f.counts().charged, 1);
    assert.equal(f.counts().versions, 1); assert.equal(f.counts().messages, 1); assert.equal(f.counts().releases, 0);
  }
});

test("provider failure releases reservation and never re-invokes same identity", async () => {
  const f = fixture(); f.failProvider();
  await assert.rejects(f.run(), code("image_edit_provider_failed"));
  await assert.rejects(f.run(), code("image_edit_new_request_required"));
  assert.equal(f.counts().calls, 1); assert.equal(f.counts().charged, 0); assert.equal(f.counts().versions, 0);
  assert.equal(f.counts().releases, 2);
});

test("completed replay survives source deletion and still rejects changed input", async () => {
  const f=fixture(); const first=await f.run();
  f.deps.loadSource=async()=>{throw Object.assign(new Error("source deleted"),{code:"image_edit_source_not_found"});};
  const replay=await f.run();
  assert.equal(replay.image_id,first.image_id);assert.equal(replay.deduplicated,true);
  await assert.rejects(f.run({...input,prompt:"a different edit"}),code("image_edit_request_conflict"));
  assert.equal(f.counts().calls,1);assert.equal(f.counts().charged,1);assert.equal(f.counts().reservations,1);
  const originalFrom = f.ctx.userDb.from;
  f.ctx.userDb.from = (table: string) => {
    if (table !== "conversations") return originalFrom(table);
    const query: any = { select: () => query, eq: () => query,
      maybeSingle: async () => ({ data: null, error: null }) };
    return query;
  };
  await assert.rejects(f.run(), code("image_edit_conversation_not_found"));
  f.ctx.userDb.from = originalFrom;
  f.deps.billing.resolvePlanCodeForImageBilling = async () => "free";
  await assert.rejects(f.run(), code("image_edit_paid_only"));
});

test("a paid-plan change does not strand a stored result or re-run inference", async () => {
  const f=fixture("pro"); f.failSettlement();
  const request={...input,executionMode:"intuitive"};
  await assert.rejects(f.run(request));
  f.deps.billing.resolvePlanCodeForImageBilling=async()=>"student_core";
  f.deps.billing.reserveFeature=async(args)=>({...args.route,requestId:args.requestId,planCode:"pro",feature:"image_generation",
    reservedUnits:8,remaining:0,limit:32,resetAt:null,status:"reserved",idempotent:true});
  assert.equal((await f.run(request)).success,true);
  assert.equal(f.counts().calls,1);assert.equal(f.counts().charged,1);
});

test("ownership, plan failures, queued cancellation and missing staged artifacts fail closed", async () => {
  const unavailable = fixture();
  unavailable.deps.billing.resolvePlanCodeForImageBilling = async () => { throw new Error("Billing unavailable"); };
  await assert.rejects(unavailable.run()); assert.equal(unavailable.counts().reservations, 0);
  const unauthorized = fixture();
  unauthorized.deps.loadSource = async () => { throw Object.assign(new Error("not found"), { code: "image_edit_source_not_found" }); };
  await assert.rejects(unauthorized.run(), code("image_edit_source_not_found")); assert.equal(unauthorized.counts().calls, 0);
  const cancelled = fixture(); const controller = new AbortController(); controller.abort();
  cancelled.deps.route = async (args) => { assert.equal(args.signal?.aborted, true); throw new Error("aborted"); };
  await assert.rejects(executeImageEdit(input, { ...cancelled.ctx, signal: controller.signal }, cancelled.deps));
  assert.equal(cancelled.counts().releases, 1); assert.equal(cancelled.counts().charged, 0);
  await assert.rejects(readEditProviderResponse(new Response("oversize", { headers: { "content-length": "99999999" } })));
  await assert.rejects(verifyEditedImageArtifact({ storage: { from: () => ({ download: async () => ({ error: { statusCode: 404 } }) }) } } as any,
    { storagePath: "owned/path", fileSizeBytes: 1, contentSha256: "a".repeat(64) }), code("image_edit_artifact_missing"));
});

test("staged artifact recovery avoids inference and relative source references stay bound on replay", async () => {
  const f = fixture(); f.failSettlement(); await assert.rejects(f.run());
  f.row().status = "storing";
  let recoveries = 0;
  f.deps.recover = async () => { recoveries++; f.row().status = "generated"; };
  await f.run(); assert.equal(recoveries, 1); assert.equal(f.counts().calls, 1);
  // The newest image now differs, but a replay of 'latest' must reuse the parent.
  const db = f.ctx.userDb;
  const originalFrom = db.from;
  db.from = (table: string) => table === "image_edit_requests" ? ({
    select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { source_image_id: sourceImageId } }) }) }) }) }),
  }) : table === "conversations" ? originalFrom(table) : (() => { throw new Error("Replay must not look up the new latest image"); })();
  try { assert.equal((await f.run({ ...input, sourceImageId: "latest" })).deduplicated, true); }
  finally { db.from = originalFrom; }
});

test("Pro Intuitive edit fallback stays within verified IDs", async () => {
  const attempted: string[] = [];
  const providers = ["openai/gpt-image-2", "microsoft/mai-image-2.6"].map((name, i) => ({
    name, isAvailable: () => true, editCapabilities: { reference: true, mask: false, transparency: false },
    generate: async () => { attempted.push(name); if (i === 0) throw new Error("Unavailable"); return { base64: "aW1hZ2U=" }; },
  }));
  const result = await routeImageGeneration({ prompt: "test", userId, planCode: "pro", executionMode: "intuitive", requestKey: "test", providers,
    edit: { source: await source(), operation: "edit" } });
  assert.equal(result.provider_used, "microsoft/mai-image-2.6"); assert.equal(attempted.length, 2);
});

test("automatic tool dispatch carries source and operation to the shared executor", async () => {
  const result = await dispatchAutomaticModelToolCall({
    calls: [{ id: "edit-call", name: "image_gen", index: 0, arguments: { prompt: input.prompt, requires_text_rendering: false,
      edit: { sourceImageId: "latest", operation: "replace_background" } } }],
    context: { authenticated: true }, allowedTools: ["image_gen"],
    executeImage: async (prompt, _text, call) => {
      assert.equal(prompt, input.prompt);
      assert.deepEqual(call.arguments.edit, { sourceImageId: "latest", operation: "replace_background" });
      return "edited";
    },
    executeWebSurf: async () => "unused", executeChart: async () => "unused", executeFile: async () => "unused", executeMemory: async () => "unused",
  });
  assert.equal(result.result, "edited");
});

test("cooldown admission remains retryable and completed replay bypasses cooldown", async () => {
  const f = fixture(); const key = `edit-test:${randomUUID()}`;
  const ctx = { ...f.ctx, imageQuotaKey: key };
  commitImageQuotaSuccess(key);
  await assert.rejects(executeImageEdit(input, ctx, f.deps), code("image_edit_cooldown"));
  assert.equal(f.counts().reservations, 0); assert.equal(f.counts().calls, 0);
  commitImageQuotaSuccess(key, Date.now() - 6000);
  await executeImageEdit(input, ctx, f.deps);
  assert.equal(getQuotaInfo(key).cooldownActive, true);
  assert.equal((await executeImageEdit(input, ctx, f.deps)).deduplicated, true);
  assert.equal(f.counts().calls, 1); assert.equal(f.counts().charged, 1);
});

test("edit chains preserve plan families and never include text-only fallbacks", async () => {
  assert.deepEqual(getImageEditModelIds("pro", "intuitive"), ["openai/gpt-image-2", "microsoft/mai-image-2.6"]);
  assert.equal(supportsImageEdit("black-forest-labs/flux.1.1-pro", "edit"), false);
  assert.equal(supportsImageEdit("gpt-image-2", "edit"), false);
  assert.deepEqual(getImageProviderOrder("test", undefined, "free", "fast"), [CLOUDFLARE_MODEL_SCHNELL, "@cf/lykon/dreamshaper-8-lcm"]);
  let calls = 0;
  await assert.rejects(routeImageGeneration({ prompt: "test", userId, planCode: "student_core", requestKey: "test", edit: { source: await source(), operation: "edit" },
    providers: [{ name: CLOUDFLARE_MODEL_SCHNELL, isAvailable: () => true, generate: async () => { calls++; return {}; } }] }));
  assert.equal(calls, 0);
});

test("Cloudflare edit multipart uses validated binary reference below 512px", async () => {
  overrideCloudflareSlotsForTesting([{ slotIndex: 0, accountId: "account", apiToken: "secret" }]); resetCloudflareHealthState();
  let called = 0;
  setCloudflareFetchForTesting(async (_url, init) => {
    called++;
    assert(init?.body instanceof FormData); const form = init.body as FormData;
    const blob = form.get("input_image_0") as Blob; assert(blob instanceof Blob); assert.equal(blob.type, "image/png");
    const meta = await sharp(Buffer.from(await blob.arrayBuffer())).metadata();
    assert(meta.width! < 512 && meta.height! < 512); assert.equal(form.get("prompt"), "green wall");
    assert.equal((init.headers as Record<string, string>)["Content-Type"], undefined);
    return new Response(JSON.stringify({ result: { image: "aW1hZ2U=" } }), { headers: { "content-type": "application/json" } });
  });
  try {
    await new CloudflareImageProvider(CLOUDFLARE_MODEL_KLEIN_4B).generate("green wall", "1024x1024", undefined,
      { requestKey: "same", edit: { source: await source(), operation: "edit" } });
    await assert.rejects(new CloudflareImageProvider(CLOUDFLARE_MODEL_SCHNELL).generate("test", undefined, undefined,
      { requestKey: "same", edit: { source: await source(), operation: "edit" } }));
    assert.equal(called, 1);
  } finally { setCloudflareFetchForTesting(null); overrideCloudflareSlotsForTesting(null); resetCloudflareHealthState(); }
});

test("Pollinations edit sends exact ID, bytes, stable seed and bearer auth without URL credentials", async () => {
  const oldFetch = globalThis.fetch, oldKey = process.env.POLLINATIONS_API_KEY;
  process.env.POLLINATIONS_API_KEY = "test-secret";
  const requests: any[] = [];
  let servedModel = "openai/gpt-image-2";
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://gen.pollinations.ai/v1/images/edits");
    assert.equal((init?.headers as any).Authorization, "Bearer test-secret");
    const body = JSON.parse(String(init?.body)); requests.push(body);
    assert.equal(body.model, "openai/gpt-image-2"); assert(body.image.startsWith("data:image/png;base64,"));
    assert.equal(body.response_format, "b64_json"); assert.equal(body.mask, undefined);
    return new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { headers: { "x-model-used": servedModel } });
  };
  try {
    const provider = new PollinationsImageModelProvider("openai/gpt-image-2");
    const context = { requestKey: "same", edit: { source: await source(), operation: "edit" as const } };
    await provider.generate("test", undefined, undefined, context); await provider.generate("test", undefined, undefined, context);
    assert.equal(requests[0].seed, requests[1].seed);
    servedModel = "black-forest-labs/flux.1.1-pro";
    await assert.rejects(provider.generate("test", undefined, undefined, context));
    await assert.rejects(new PollinationsImageModelProvider(servedModel).generate("test", undefined, undefined, context));
    assert.equal(requests.length, 3);
  } finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.POLLINATIONS_API_KEY; else process.env.POLLINATIONS_API_KEY = oldKey; }
});

test("transparent storage, immutable versions, ownership, and persistence checkpoint", async () => {
  // High entropy forces the compression fallback. Alpha must survive it.
  const rgba = Buffer.alloc(1600 * 1600 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 157 + (i >> 7) * 53) % 256;
  const bytes = await sharp(rgba, { raw: { width: 1600, height: 1600, channels: 4 } }).png().toBuffer();
  const prepared = await compressImage(bytes);
  assert.equal(prepared.mimeType, "image/webp"); assert.equal((await sharp(prepared.buffer).metadata()).hasAlpha, true);
  let saved: Buffer | undefined; let uploads = 0; let path: string | undefined;
  const storage: any = { storage: { getBucket: async () => ({ data: { public: true } }), from: () => ({
    upload: async (p: string, b: Buffer, options: any) => { assert.equal(options.upsert, false); uploads++; path = p;
      if (saved) return { error: { message: "The resource already exists" } }; saved = b; return { error: null }; },
    getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/output.webp" } }),
    download: async () => ({ data: new Blob([new Uint8Array(saved!)]) }),
  }) } };
  const params = { userId, conversationId, imageId: randomUUID(), bytes: await source(), requireAlpha: true };
  const result = await uploadEditedImageArtifact(storage, params);
  assert.equal((await uploadEditedImageArtifact(storage, params)).storagePath, result.storagePath); assert.equal(uploads, 2);
  assert.equal(path?.includes(sourceImageId), false);
  const operations: any[] = [];
  const db: any = { rpc: async (name: string, args: any) => { operations.push([name, args]); return { data: {}, error: null }; } };
  await persistEditedImageResult({ ...params, storageDb: storage, userDb: db, requestId: "identity", leaseToken: randomUUID(), provider: CLOUDFLARE_MODEL_KLEIN_4B });
  assert.equal(operations[0][0], "prepare_image_edit_artifact");
  assert.equal(operations[1][0], "record_image_edit_artifact");
  const filters: any[] = []; const q: any = { select: () => q, eq: (k: string, v: string) => { filters.push([k,v]); return q; }, maybeSingle: async () => ({ data: null }) };
  await assert.rejects(loadOwnedEditSource({ from: () => q } as any, storage, userId, conversationId, sourceImageId), code("image_edit_source_not_found"));
  assert(filters.some(([key, value]) => key === "user_id" && value === userId));
  assert(filters.some(([key, value]) => key === "chat_id" && value === conversationId));
  const imageListQuery: any = { select: () => imageListQuery, eq: () => imageListQuery, order: async () => ({ data: [{
    id: params.imageId, image_url: result.imageUrl, storage_path: result.storagePath, created_at: "2026-10-24T00:00:00Z",
    source_image_id: sourceImageId, edit_request_id: "request", operation: "edit", operation_metadata: { prompt: "test" }, content_sha256: result.contentSha256,
  }] }) };
  const listed = await getChatImages({ from: () => imageListQuery } as any, userId, conversationId);
  assert.equal(listed[0].sourceImageId, sourceImageId); assert.equal(listed[0].operation, "edit");
});
