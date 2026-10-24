import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { HttpError } from "./httpErrors";
import { saveImageAnnotation, type ImageAnnotationDependencies } from "./services/imageAnnotationService";
import { SaveImageAnnotationSchema, ImageAnnotationSchema } from "./tools/imageGeneration/imageAnnotationContract";
import { renderImageAnnotation } from "./tools/imageGeneration/imageAnnotationRenderer";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const userId = randomUUID(), conversationId = randomUUID(), sourceImageId = randomUUID();
const annotation = { version: 1 as const, strokes: [{ color: "#00ff00", size: 10, points: [{ x: 0.5, y: 0.5 }] }] };
const input = { conversationId, sourceImageId, clientRequestId: "markup-one", annotation };
const source = () => sharp({ create: { width: 96, height: 64, channels: 4, background: "#ff000040" } }).png().toBuffer();
const code = (value: string) => (error: any) => error?.code === value;

function fixture() {
  let row: any, saved: Buffer | undefined;
  let loads = 0, uploads = 0, versions = 0, messages = 0, creditCalls = 0;
  let plan = "student_core", parentDeleted = false, failComplete = false, loseComplete = false, loseCheckpoint = false, failUpload = false;
  let deleted: "image" | "message" | "object" | null = null;
  const db: any = {
    rpc: async (name: string, args: any) => {
      if (name === "claim_image_annotation") {
        if (!row) row = { request_id: args.p_request_id, status: "claimed", image_id: randomUUID(),
          fingerprint: args.p_fingerprint, operation_metadata: args.p_metadata, lease_token: args.p_lease_token, acquired: true };
        else {
          if (row.fingerprint !== args.p_fingerprint) return { data: { conflict: true } };
          if (row.yielded) { row.lease_token = args.p_lease_token; row.yielded = false; }
          row.acquired = row.lease_token === args.p_lease_token;
        }
      } else if (name === "checkpoint_image_annotation") {
        if (row.artifact) assert.deepEqual(row.artifact, args.p_artifact);
        row.artifact = args.p_artifact; row.status = "storing";
        if (loseCheckpoint) { loseCheckpoint = false; return { error: { message: "lost checkpoint response" } }; }
      } else if (name === "complete_image_annotation") {
        if (failComplete) { failComplete = false; return { error: { message: "completion unavailable" } }; }
        if (row.status !== "completed") { versions++; messages++; row.assistant_message_id = randomUUID(); row.status = "completed"; }
        if (loseComplete) { loseComplete = false; return { error: { message: "lost completion response" } }; }
      } else throw new Error("Unexpected RPC " + name);
      return { data: structuredClone(row), error: null };
    },
    from: (table: string) => {
      const query: any = { select: () => query, update: () => query, eq: () => query, in: () => query,
        maybeSingle: async () => ({ data: table === "chat_images" ? deleted === "image" ? null : {
          storage_path: row?.artifact.storagePath, content_sha256: row?.artifact.contentSha256,
          image_url: row?.artifact.imageUrl, edit_request_id: row?.request_id,
        } : table === "messages" ? deleted === "message" ? null : { storage_path: row?.artifact.storagePath } : structuredClone(row), error: null }),
        then: (resolve: any) => { if (row?.status !== "completed") row.yielded = true; return Promise.resolve({ error: null }).then(resolve); } };
      return query;
    },
  };
  const billing: any = {
    resolvePlanCodeForImageBilling: async () => plan,
    reserveFeature: async () => { creditCalls++; throw new Error("Markup cannot reserve credits"); },
    commit: async () => { creditCalls++; throw new Error("Markup cannot settle credits"); },
  };
  const deps: ImageAnnotationDependencies = {
    billing,
    loadSource: async () => { loads++; if (parentDeleted) throw new HttpError(404, "Source removed", { code: "image_edit_source_not_found" }); return source(); },
    upload: async (_db, params) => {
      uploads++;
      const artifact = { imageUrl: "https://cdn.example/markup.png", storagePath: `${userId}/${conversationId}/${params.imageId}.png`,
        fileSizeBytes: params.bytes.length, contentSha256: hash(params.bytes) };
      await params.beforeUpload?.(artifact);
      if (failUpload) { failUpload = false; throw new Error("Object upload failed"); }
      saved = params.bytes; return artifact;
    },
    verifyArtifact: async (_db, artifact) => {
      if (!saved || deleted === "object") throw new HttpError(409, "Missing object", { code: "image_edit_artifact_missing" });
      assert.equal(hash(saved), artifact.contentSha256); assert.equal(saved.length, artifact.fileSizeBytes);
    },
  };
  const ctx = { userId, identity: { userId, anonymousKeyHash: null, isGuest: false }, userDb: db, storageDb: db };
  return { ctx, deps, run: (raw: unknown = input) => saveImageAnnotation(raw, ctx, deps), row: () => row,
    counts: () => ({ loads, uploads, versions, messages, creditCalls }),
    removeParent: () => { parentDeleted = true; }, setPlan: (value: string) => { plan = value; },
    failCompletion: () => { failComplete = true; }, loseCompletion: () => { loseComplete = true; },
    loseCheckpoint: () => { loseCheckpoint = true; }, failUpload: () => { failUpload = true; },
    deleteOutput: (value: typeof deleted) => { deleted = value; } };
}

test("annotation schema excludes files, URLs, unsafe SVG and unbounded drawing input", () => {
  assert(SaveImageAnnotationSchema.safeParse(input).success);
  for (const extra of ["image", "sourceUrl", "plan", "credits", "model", "prompt", "operation"]) {
    assert(!SaveImageAnnotationSchema.safeParse({ ...input, [extra]: "untrusted" }).success);
  }
  for (const strokes of [[], [{ ...annotation.strokes[0], color: 'url(https://example.com)' }],
    [{ ...annotation.strokes[0], points: [{ x: NaN, y: 0 }] }],
    [{ ...annotation.strokes[0], points: Array.from({ length: 4097 }, () => ({ x: 0, y: 0 })) }]]) {
    assert(!ImageAnnotationSchema.safeParse({ version: 1, strokes }).success);
  }
});

test("drawing renders actual pixels, preserves source bytes/alpha and bounds CPU concurrency", async () => {
  const original = await source(), before = hash(original), marked = await renderImageAnnotation(original, annotation);
  const { data, info } = await sharp(marked).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray((32 * info.width + 48) * 4, (32 * info.width + 48) * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(data[3], 64); assert.equal(hash(original), before);
  const rotated = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#ffffff" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const oriented = await sharp(await renderImageAnnotation(rotated, annotation)).metadata();
  assert.equal(oriented.width, 40); assert.equal(oriented.height, 80);
  const concurrent = await Promise.allSettled([1, 2, 3].map(() => renderImageAnnotation(original, annotation)));
  assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 2);
  assert.equal(concurrent.filter(result => result.status === "rejected" && (result.reason as any).code === "image_annotation_busy").length, 1);
});

test("annotation saves/replays charge zero generation credits and retain a single immutable version/message", async () => {
  const f = fixture(); const first = await f.run(); f.removeParent();
  assert.equal(first.generation_credits_used, 0); assert.equal(first.operation, "annotate");
  assert.equal((await f.run()).image_id, first.image_id);
  assert.deepEqual(f.counts(), { loads: 1, uploads: 1, versions: 1, messages: 1, creditCalls: 0 });
  await assert.rejects(f.run({ ...input, annotation: { ...annotation, strokes: [{ ...annotation.strokes[0], color: "#0000ff" }] } }), code("image_annotation_request_conflict"));
});

test("source deletion and lost checkpoint/completion responses recover without inference or duplicate versions", async () => {
  for (const mode of ["completion", "checkpoint", "upload", "lost-completion"] as const) {
    const f = fixture();
    if (mode === "completion") f.failCompletion();
    if (mode === "checkpoint") f.loseCheckpoint();
    if (mode === "upload") f.failUpload();
    if (mode === "lost-completion") f.loseCompletion();
    await assert.rejects(f.run());
    if (["completion", "lost-completion"].includes(mode)) f.removeParent();
    const recovered = await f.run(); assert.equal(recovered.success, true);
    assert.equal(f.counts().versions, 1); assert.equal(f.counts().messages, 1); assert.equal(f.counts().creditCalls, 0);
  }
});

test("concurrent saves acquire one lease and do not duplicate persistence", async () => {
  const f = fixture(); let ready!: () => void, proceed!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), blocked = new Promise<void>(resolve => { proceed = resolve; });
  const upload = f.deps.upload!;
  f.deps.upload = async (...args) => { ready(); await blocked; return upload(...args); };
  const first = f.run(); await started;
  await assert.rejects(f.run(), code("image_annotation_in_progress")); proceed(); await first;
  assert.equal(f.counts().versions, 1); assert.equal(f.counts().messages, 1); assert.equal(f.counts().creditCalls, 0);
});

test("Free/guest, foreign sources and deleted output fail closed without charges or resurrection", async () => {
  for (const plan of ["free", "guest"] as const) {
    const f = fixture(); if (plan === "guest") f.ctx.identity.isGuest = true; else f.setPlan("free");
    await assert.rejects(f.run(), code("image_edit_paid_only")); assert.equal(f.counts().loads, 0);
  }
  const foreign = fixture(); foreign.removeParent(); await assert.rejects(foreign.run(), code("image_edit_source_not_found"));
  assert.equal(foreign.counts().uploads, 0);
  for (const removed of ["image", "message", "object"] as const) {
    const f = fixture(); await f.run(); f.deleteOutput(removed);
    await assert.rejects(f.run(), code("image_edit_result_deleted")); assert.equal(f.counts().uploads, 1);
  }
  const downgrade = fixture(); downgrade.failCompletion(); await assert.rejects(downgrade.run()); downgrade.setPlan("free");
  await assert.rejects(downgrade.run(), code("image_edit_paid_only")); assert.equal(downgrade.counts().creditCalls, 0);
});
