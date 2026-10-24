import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "../httpErrors";
import type { ImageEditingContext } from "./imageEditingService";
import type { BillingQuotaService } from "../billing/quotaService";
import { assertPaidImageEdit } from "../tools/imageGeneration/imageEditPolicy";
import { SaveImageAnnotationSchema } from "../tools/imageGeneration/imageAnnotationContract";
import { renderImageAnnotation } from "../tools/imageGeneration/imageAnnotationRenderer";
import { loadOwnedEditSource, uploadEditedImageArtifact, verifyEditedImageArtifact } from "../tools/imageGeneration/imageStorageService";
import type { EditedImageArtifact } from "./generatedImagePersistenceService";

export const IMAGE_ANNOTATION_SCHEMA_VERSION = "20261024190000";
export type ImageAnnotationDependencies = {
  // No inference, reservation, settlement, quota or cooldown dependency exists.
  billing: Pick<BillingQuotaService, "resolvePlanCodeForImageBilling">;
  loadSource?: typeof loadOwnedEditSource;
  upload?: typeof uploadEditedImageArtifact;
  verifyArtifact?: typeof verifyEditedImageArtifact;
};
type AnnotationRecord = {
  request_id: string; image_id: string; status: "claimed" | "storing" | "completed";
  acquired?: boolean; artifact?: EditedImageArtifact; assistant_message_id?: string;
};
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new HttpError(503, "Saving image markup is temporarily unavailable. Retry the same request.", { code: "image_annotation_unavailable", expose: true });
const metadataFor = (input: ReturnType<typeof SaveImageAnnotationSchema.parse>, sourceHash: string) => ({
  operation: "annotate", source_image_id: input.sourceImageId, source_sha256: sourceHash,
  client_request_id: input.clientRequestId, annotation: input.annotation,
});

export async function saveImageAnnotation(raw: unknown, ctx: ImageEditingContext, deps: ImageAnnotationDependencies) {
  const parsed = SaveImageAnnotationSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid image markup request.", { code: "image_annotation_invalid_request" });
  const input = parsed.data;
  if (ctx.identity.userId !== ctx.userId) throw new HttpError(403, "Image editing identity mismatch.");
  const ensurePaid = async () => assertPaidImageEdit(await deps.billing.resolvePlanCodeForImageBilling(ctx.identity), ctx.userId, ctx.identity.isGuest);
  await ensurePaid();
  const requestId = `image-annotation:${digest(JSON.stringify([ctx.userId, input.conversationId, input.clientRequestId]))}`;
  const previousResult = await ctx.userDb.from("image_annotation_requests").select("request_id,status,fingerprint,operation_metadata")
    .eq("request_id", requestId).eq("user_id", ctx.userId).eq("conversation_id", input.conversationId).maybeSingle();
  if (previousResult.error) throw unavailable();
  const previous = previousResult.data;
  let source: Buffer | undefined;
  let metadata: ReturnType<typeof metadataFor>;
  if (previous && ["storing", "completed"].includes(previous.status)) {
    const boundHash = previous.operation_metadata?.source_sha256;
    if (typeof boundHash !== "string" || !/^[0-9a-f]{64}$/.test(boundHash)) throw unavailable();
    metadata = metadataFor(input, boundHash);
    if (previous.request_id !== requestId || previous.fingerprint !== digest(JSON.stringify(metadata))) {
      throw new HttpError(409, "This request ID belongs to different markup.", { code: "image_annotation_request_conflict" });
    }
  } else {
    ctx.signal?.throwIfAborted();
    source = await (deps.loadSource ?? loadOwnedEditSource)(ctx.userDb, ctx.storageDb, ctx.userId, input.conversationId, input.sourceImageId);
    metadata = metadataFor(input, digest(source));
  }
  const lease = randomUUID();
  const rpc = async (name: string, args: Record<string, unknown>): Promise<AnnotationRecord> => {
    const { data, error } = await ctx.userDb.rpc(name, args);
    if (error || !data) throw unavailable();
    if (data.conflict) throw new HttpError(409, "This request ID belongs to different markup.", { code: "image_annotation_request_conflict" });
    return data;
  };
  let record = await rpc("claim_image_annotation", {
    p_request_id: requestId, p_user_id: ctx.userId, p_conversation_id: input.conversationId,
    p_source_image_id: input.sourceImageId, p_fingerprint: digest(JSON.stringify(metadata)), p_metadata: metadata, p_lease_token: lease,
  });
  const validateArtifact = (artifact?: EditedImageArtifact): artifact is EditedImageArtifact => Boolean(artifact
    && new RegExp(`^${ctx.userId}/${input.conversationId}/${record.image_id}\\.(webp|png|jpe?g)$`).test(artifact.storagePath)
    && /^[0-9a-f]{64}$/.test(artifact.contentSha256) && Number.isInteger(artifact.fileSizeBytes)
    && artifact.fileSizeBytes > 0 && artifact.fileSizeBytes <= 1048576 && artifact.provider === "sentiq/annotation");
  const respond = (deduplicated: boolean) => {
    if (!record.assistant_message_id || !validateArtifact(record.artifact)) throw unavailable();
    return { success: true as const, type: "image" as const, persisted: true as const, deduplicated,
      image_id: record.image_id, message_id: record.assistant_message_id, source_image_id: input.sourceImageId,
      image_url: record.artifact.imageUrl, url: record.artifact.imageUrl, storage_path: record.artifact.storagePath,
      file_size_bytes: record.artifact.fileSizeBytes, operation: "annotate" as const, generation_credits_used: 0,
      conversation_id: input.conversationId, client_request_id: input.clientRequestId };
  };
  if (record.status === "completed") {
    if (!record.assistant_message_id || !validateArtifact(record.artifact)) throw new HttpError(410, "This markup version was removed.", { code: "image_edit_result_deleted" });
    const [image, message] = await Promise.all([
      ctx.userDb.from("chat_images").select("storage_path,content_sha256,image_url,edit_request_id")
        .eq("id", record.image_id).eq("user_id", ctx.userId).eq("chat_id", input.conversationId).maybeSingle(),
      ctx.userDb.from("messages").select("storage_path").eq("id", record.assistant_message_id)
        .eq("conversation_id", input.conversationId).eq("role", "assistant").eq("message_type", "image").maybeSingle(),
    ]);
    if (image.error || message.error) throw unavailable();
    if (image.data?.storage_path !== record.artifact.storagePath || image.data?.content_sha256 !== record.artifact.contentSha256
        || image.data?.image_url !== record.artifact.imageUrl || image.data?.edit_request_id !== requestId
        || message.data?.storage_path !== record.artifact.storagePath) {
      throw new HttpError(410, "This markup version was removed.", { code: "image_edit_result_deleted" });
    }
    try { await (deps.verifyArtifact ?? verifyEditedImageArtifact)(ctx.storageDb, record.artifact); }
    catch (error) {
      if (error instanceof HttpError && error.code === "image_edit_artifact_missing") throw new HttpError(410, "This markup version was removed.", { code: "image_edit_result_deleted" });
      throw unavailable();
    }
    return respond(true);
  }
  if (!record.acquired) throw new HttpError(409, "This markup is still being saved. Retry the same request.", {
    code: "image_annotation_in_progress", headers: { "Retry-After": "3" },
  });
  try {
    let artifact = record.artifact;
    if (artifact) {
      if (!validateArtifact(artifact)) throw unavailable();
      try { await (deps.verifyArtifact ?? verifyEditedImageArtifact)(ctx.storageDb, artifact); }
      catch (error) {
        if (!(error instanceof HttpError && error.code === "image_edit_artifact_missing")) throw error;
        // A crash before upload may be retried using the same still-owned parent.
        // Completed/deleted versions never enter this branch or get resurrected.
        artifact = undefined;
      }
    }
    if (!artifact) {
      ctx.signal?.throwIfAborted();
      source ??= await (deps.loadSource ?? loadOwnedEditSource)(ctx.userDb, ctx.storageDb, ctx.userId, input.conversationId, input.sourceImageId);
      if (digest(source) !== metadata.source_sha256) throw new HttpError(409, "The source no longer matches this markup request.", { code: "image_annotation_request_conflict" });
      const bytes = await renderImageAnnotation(source, input.annotation);
      artifact = { ...await (deps.upload ?? uploadEditedImageArtifact)(ctx.storageDb, {
        userId: ctx.userId, conversationId: input.conversationId, imageId: record.image_id, bytes,
        beforeUpload: async prepared => {
          ctx.signal?.throwIfAborted(); await ensurePaid();
          await rpc("checkpoint_image_annotation", { p_request_id: requestId, p_lease_token: lease,
            p_artifact: { ...prepared, provider: "sentiq/annotation" } });
        },
      }), provider: "sentiq/annotation" };
      await (deps.verifyArtifact ?? verifyEditedImageArtifact)(ctx.storageDb, artifact);
    }
    ctx.signal?.throwIfAborted(); await ensurePaid();
    record = await rpc("complete_image_annotation", { p_request_id: requestId, p_lease_token: lease });
    return respond(Boolean(previous));
  } catch (error) {
    // Retain immutable staged objects on an uncertain result. Replays own recovery.
    await ctx.userDb.from("image_annotation_requests").update({ lease_expires_at: new Date(0).toISOString() })
      .eq("request_id", requestId).eq("lease_token", lease).in("status", ["claimed", "storing"]);
    throw error;
  }
}
