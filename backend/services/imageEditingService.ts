import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingIdentity, UsageReservation } from "../billing/entitlementTypes";
import type { BillingQuotaService } from "../billing/quotaService";
import { getImageModelCreditCost } from "../billing/imageCreditPolicy";
import { getImageModelForPlan } from "../billing/modelEntitlementRouter";
import { HttpError } from "../httpErrors";
import { commitImageQuotaSuccess, getQuotaInfo } from "../middleware/imageQuota";
import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";
import { assertPaidImageEdit, assertImageEditSupported, getImageEditModelIds } from "../tools/imageGeneration/imageEditPolicy";
import { ImageEditRequestSchema, decodeEditMask, validateEditInput, validateEditRaster } from "../tools/imageGeneration/imageEditValidation";
import type { ImageEditRequest } from "../tools/imageGeneration/imageEditValidation";
import { loadOwnedEditSource, verifyEditedImageArtifact } from "../tools/imageGeneration/imageStorageService";
import { persistEditedImageResult, recoverEditedImageResult, type EditedImageArtifact } from "./generatedImagePersistenceService";
import { detectPromptInjection } from "../validation/schemas";

type EditRecord = {
  request_id: string; image_id: string; status: "claimed" | "invoking" | "storing" | "generated" | "completed" | "failed";
  lease_token: string; acquired: boolean; conflict?: boolean; artifact?: EditedImageArtifact;
  assistant_message_id?: string;
  source_image_id?: string;
};

export type ImageEditingDependencies = {
  billing: Pick<BillingQuotaService, "resolvePlanCodeForImageBilling" | "reserveFeature" | "commit" | "releaseImageEditRequest">;
  route?: typeof routeImageGeneration;
  loadSource?: typeof loadOwnedEditSource;
  persist?: typeof persistEditedImageResult;
  recover?: typeof recoverEditedImageResult;
  verifyArtifact?: typeof verifyEditedImageArtifact;
};

export type ImageEditingContext = {
  userId: string; identity: BillingIdentity; userDb: SupabaseClient; storageDb: SupabaseClient;
  signal?: AbortSignal; imageQuotaKey?: string;
};

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function requestMetadata(input: ImageEditRequest, sourceId: string, sourceHash: string, maskHash: string | null) {
  return {
    prompt: input.prompt, operation: input.operation, source_image_id: sourceId,
    client_request_id: input.clientRequestId, source_sha256: sourceHash, mask_sha256: maskHash,
    size: input.size, execution_mode: input.executionMode,
  };
}

async function rpc(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<EditRecord> {
  const { data, error } = await db.rpc(name, args);
  if (error || !data) throw new HttpError(503, "Image edit recovery is temporarily unavailable. Retry with the same request ID.", { code: "image_edit_recovery_unavailable", expose: true });
  return data as EditRecord;
}

function response(record: Pick<EditRecord, "artifact" | "assistant_message_id" | "image_id" | "source_image_id">, deduplicated: boolean) {
  if (!record.artifact || !record.assistant_message_id) throw new Error("Image edit completion is missing its artifact");
  return {
    success: true as const, type: "image" as const, image_url: record.artifact.imageUrl,
    url: record.artifact.imageUrl, image_id: record.image_id, message_id: record.assistant_message_id,
    storage_path: record.artifact.storagePath, file_size_bytes: record.artifact.fileSizeBytes,
    provider_used: record.artifact.provider, persisted: true as const, deduplicated,
    source_image_id: record.source_image_id,
  };
}

/** Shared by HTTP and automatic tool execution. Client plan, model, URLs, costs,
 * and storage paths are deliberately absent from the accepted request schema. */
export async function executeImageEdit(raw: unknown, ctx: ImageEditingContext, deps: ImageEditingDependencies) {
  const parsed = ImageEditRequestSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid image editing request.", { code: "image_edit_invalid_request" });
  let input = parsed.data;
  if (detectPromptInjection(input.prompt)) throw new HttpError(400, "Image prompt rejected by safety filter.");
  if (ctx.identity.userId !== ctx.userId) throw new HttpError(403, "Image editing identity mismatch.");
  const plan = await deps.billing.resolvePlanCodeForImageBilling(ctx.identity);
  assertPaidImageEdit(plan, ctx.userId, ctx.identity.isGuest);
  const models = getImageEditModelIds(plan, input.executionMode);
  const requestId = `image-edit:${hash(JSON.stringify([ctx.userId, input.conversationId, input.clientRequestId]))}`;
  const mask = input.mask ? decodeEditMask(input.mask) : undefined;
  const previousResult = await ctx.userDb.from("image_edit_requests")
    .select("request_id,image_id,status,fingerprint,source_image_id,operation,operation_metadata,assistant_message_id,artifact")
    .eq("request_id", requestId).eq("user_id", ctx.userId).eq("conversation_id", input.conversationId).maybeSingle();
  if (previousResult.error) throw new HttpError(503, "Image source recovery is unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
  const previous = previousResult.data;
  const recoveringArtifact = previous != null && previous.artifact != null && ["storing", "generated"].includes(previous.status);
  if (previous?.status === "completed" || recoveringArtifact) {
    // A checkpointed action is bound to its original source hash. Recovery must
    // not depend on the continued existence of that parent file or invoke again.
    const sourceId = previous.operation_metadata?.source_image_id;
    const sourceHash = previous.operation_metadata?.source_sha256;
    if (typeof sourceId !== "string" || typeof sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(sourceHash)) {
      throw new HttpError(503, "Stored image edit identity is unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
    }
    if (previous.operation !== input.operation || previous.operation_metadata?.operation !== input.operation
        || previous.request_id !== requestId
        || (input.sourceImageId !== "latest" && input.sourceImageId !== sourceId)
        || hash(JSON.stringify(requestMetadata(input, sourceId, sourceHash, mask ? hash(mask) : null))) !== previous.fingerprint) {
      throw new HttpError(409, "This request ID was already used for a different edit.", { code: "image_edit_request_conflict" });
    }
    const ownedConversation = await ctx.userDb.from("conversations").select("id")
      .eq("id", input.conversationId).eq("user_id", ctx.userId).maybeSingle();
    if (ownedConversation.error) throw new HttpError(503, "Conversation ownership could not be checked.", { code: "image_edit_recovery_unavailable", expose: true });
    if (!ownedConversation.data) throw new HttpError(404, "Conversation was not found.", { code: "image_edit_conversation_not_found" });
    if (recoveringArtifact) {
      const artifact = previous.artifact as EditedImageArtifact;
      if (!new RegExp(`^${ctx.userId}/${input.conversationId}/${previous.image_id}\\.(webp|png|jpe?g)$`).test(artifact.storagePath)
          || !/^[0-9a-f]{64}$/.test(artifact.contentSha256) || !Number.isInteger(artifact.fileSizeBytes)
          || artifact.fileSizeBytes < 1 || artifact.fileSizeBytes > 1048576) {
        throw new HttpError(503, "Stored image edit identity is unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
      }
    }
    if (previous.status === "completed") {
      const artifact = previous.artifact as EditedImageArtifact | undefined;
      if (!artifact || !previous.assistant_message_id || !previous.image_id) {
        throw new HttpError(410, "This edit result is no longer available.", { code: "image_edit_result_deleted" });
      }

      // Image removal deletes the immutable object and its chat_images row, but a
      // completed request remains as an idempotency tombstone. Never replay its
      // obsolete public URL or invoke the provider again.
      const { data: imageRow, error: imageError } = await ctx.userDb.from("chat_images")
        .select("id,storage_path,image_url,content_sha256")
        .eq("id", previous.image_id).eq("user_id", ctx.userId)
        .eq("chat_id", input.conversationId).maybeSingle();
      if (imageError) throw new HttpError(503, "Image result lookup is temporarily unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
      if (!imageRow || imageRow.storage_path !== artifact.storagePath
          || imageRow.image_url !== artifact.imageUrl || imageRow.content_sha256 !== artifact.contentSha256) {
        throw new HttpError(410, "This edit result is no longer available.", { code: "image_edit_result_deleted" });
      }
      const { data: messageRow, error: messageError } = await ctx.userDb.from("messages")
        .select("id,storage_path")
        .eq("id", previous.assistant_message_id).eq("conversation_id", input.conversationId)
        .eq("role", "assistant").eq("message_type", "image").maybeSingle();
      if (messageError) throw new HttpError(503, "Image message lookup is temporarily unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
      if (!messageRow || messageRow.storage_path !== artifact.storagePath) {
        throw new HttpError(410, "This edit result is no longer available.", { code: "image_edit_result_deleted" });
      }
      try {
        await (deps.verifyArtifact ?? verifyEditedImageArtifact)(ctx.storageDb, artifact);
      } catch (error) {
        if (error instanceof HttpError && error.code === "image_edit_artifact_missing") {
          throw new HttpError(410, "This edit result is no longer available.", { code: "image_edit_result_deleted" });
        }
        throw new HttpError(503, "Stored image verification is temporarily unavailable.", { code: "image_edit_recovery_unavailable", expose: true });
      }
      return response({ ...previous, source_image_id: sourceId }, true);
    }
  }
  if (input.sourceImageId === "latest") {
    // Bind relative references to the original source across replays, even after
    // the new version becomes the latest image in the conversation.
    let sourceId = previous?.source_image_id || previous?.operation_metadata?.source_image_id;
    if (!sourceId) {
      const latest = await ctx.userDb.from("chat_images").select("id")
        .eq("user_id", ctx.userId).eq("chat_id", input.conversationId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
      if (latest.error) throw new HttpError(503, "Image source lookup is unavailable.", { code: "image_edit_source_unavailable", expose: true });
      sourceId = latest.data?.id;
    }
    if (!sourceId) throw new HttpError(404, "No stored image was found in this conversation.", { code: "image_edit_source_not_found" });
    input = { ...input, sourceImageId: sourceId };
  }

  // Only a trusted durable checkpoint can bypass reading the original source.
  // Fresh/claimed/invoking requests retain the existing ownership and file checks.
  let edit: Awaited<ReturnType<typeof validateEditInput>> | undefined;
  let metadata: ReturnType<typeof requestMetadata>;
  if (recoveringArtifact) {
    metadata = previous.operation_metadata;
  } else {
    const source = await (deps.loadSource ?? loadOwnedEditSource)(ctx.userDb, ctx.storageDb, ctx.userId, input.conversationId, input.sourceImageId);
    edit = await validateEditInput(source, input.operation, mask);
    assertImageEditSupported(models, input.operation);
    metadata = requestMetadata(input, input.sourceImageId, hash(source), edit.mask ? hash(edit.mask) : null);
  }
  const fingerprint = recoveringArtifact ? previous.fingerprint : hash(JSON.stringify(metadata));
  const leaseToken = randomUUID();
  let record = await rpc(ctx.userDb, recoveringArtifact ? "claim_image_edit_recovery" : "claim_image_edit", {
    p_request_id: requestId, p_user_id: ctx.userId, p_conversation_id: input.conversationId,
    p_source_image_id: recoveringArtifact ? metadata.source_image_id : input.sourceImageId,
    p_fingerprint: fingerprint, p_operation: input.operation,
    ...(recoveringArtifact ? { p_artifact: previous.artifact } : { p_metadata: metadata }), p_lease_token: leaseToken,
  });
  if (record.conflict) throw new HttpError(409, "This request ID was already used for a different edit.", { code: "image_edit_request_conflict" });
  // A concurrent completion must pass the same row/message/Storage replay checks.
  if (record.status === "completed") return executeImageEdit(raw, ctx, deps);
  if (record.status === "failed") {
    await deps.billing.releaseImageEditRequest(requestId);
    throw new HttpError(409, "This edit did not complete. Submit a new request ID to try again.", { code: "image_edit_new_request_required" });
  }
  if (!record.acquired) throw new HttpError(409, "This image edit is already processing. Retry with the same request ID.", { code: "image_edit_in_progress", headers: { "Retry-After": "3" } });

  let reservation: UsageReservation | undefined;
  let providerSucceeded = false;
  let artifact = record.artifact;
  const controller = new AbortController();
  const onAbort = () => controller.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) onAbort();
  else ctx.signal?.addEventListener("abort", onAbort, { once: true });
  // Bound queue + provider work below the durable lease and credit reservation TTL.
  const timer = setTimeout(() => controller.abort(new Error("Image edit timed out")), 5 * 60_000);
  try {
    if (artifact) {
      // Verify both generated and storing checkpoints before touching the ledger.
      await (deps.verifyArtifact ?? verifyEditedImageArtifact)(ctx.storageDb, artifact);
      if (record.status === "storing") {
        await (deps.recover ?? recoverEditedImageResult)(ctx.userDb, ctx.storageDb, requestId, leaseToken, artifact);
      }
    }
    const cooldown = ctx.imageQuotaKey ? getQuotaInfo(ctx.imageQuotaKey) : undefined;
    if (!artifact && cooldown?.cooldownActive) {
      throw new HttpError(429, "Image generation cooldown is active.", { code: "image_edit_cooldown",
        headers: { "Retry-After": String(Math.max(1, Math.ceil(cooldown.cooldownResetMs / 1000))) } });
    }
    reservation = await deps.billing.reserveFeature({
      identity: ctx.identity, feature: "image_generation", requestId,
      units: Math.max(...models.map(getImageModelCreditCost)), route: getImageModelForPlan(plan, false),
      conversationId: input.conversationId, clientRequestId: input.clientRequestId,
      metadata: { image_edit: true, fingerprint, execution_mode: input.executionMode },
    });
    assertPaidImageEdit(reservation.planCode, ctx.userId);
    // A stored result may belong to an earlier paid plan. Its existing ledger
    // fixes the successful model/cost; a paid-plan change must not strand it.
    if (!artifact && reservation.planCode !== plan) throw new HttpError(409, "Subscription changed during this edit. Submit a new request.", { code: "image_edit_plan_changed" });
    if (!artifact && reservation.status === "committed") throw new Error("Image edit reservation already settled without an artifact");
    if (!artifact) {
      const result = await (deps.route ?? routeImageGeneration)({
        prompt: input.operation === "replace_background"
          ? `Replace the background of image 0 as follows: ${input.prompt}. Preserve the foreground subject.` : input.prompt,
        size: input.size, userId: ctx.userId, planCode: plan, executionMode: input.executionMode,
        requestKey: requestId, edit, signal: controller.signal,
        beforeInvoke: async () => {
          // Plan resolution remains server-owned immediately before inference.
          const currentPlan = await deps.billing.resolvePlanCodeForImageBilling(ctx.identity);
          assertPaidImageEdit(currentPlan, ctx.userId);
          if (currentPlan !== plan) throw new HttpError(409, "Subscription changed during this edit.", { code: "image_edit_plan_changed" });
          record = await rpc(ctx.userDb, "transition_image_edit", {
            p_request_id: requestId, p_lease_token: leaseToken, p_status: "invoking",
          });
        },
      });
      if (!result.success || !result.image_base64 || !result.provider_used || !models.includes(result.provider_used)) {
        throw new HttpError(502, "Image editing could not finish.", { code: "image_edit_provider_failed", expose: true });
      }
      if (result.image_base64.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.image_base64)) {
        throw new HttpError(502, "Image editing returned an invalid image.", { code: "image_edit_invalid_output", expose: true });
      }
      const bytes = Buffer.from(result.image_base64, "base64");
      await validateEditRaster(bytes);
      providerSucceeded = true;
      artifact = await (deps.persist ?? persistEditedImageResult)({
        userDb: ctx.userDb, storageDb: ctx.storageDb, userId: ctx.userId, conversationId: input.conversationId,
        imageId: record.image_id, requestId, leaseToken, bytes, provider: result.provider_used,
        requireAlpha: input.operation === "remove_background",
      });
    }
    // Persisted artifact is the recovery boundary. Settlement and message completion
    // are independently idempotent across a crash between control DB and shard.
    await deps.billing.commit({ ...reservation, provider: artifact.provider, model: artifact.provider }, {
      image_edit: true, actual_image_credits: getImageModelCreditCost(artifact.provider), provider_used: artifact.provider,
    });
    record = await rpc(ctx.userDb, "complete_image_edit", { p_request_id: requestId, p_lease_token: leaseToken });
    if (ctx.imageQuotaKey) commitImageQuotaSuccess(ctx.imageQuotaKey);
    return response({ ...record, source_image_id: record.source_image_id ?? metadata.source_image_id }, Boolean(record.status === "completed" && reservation.idempotent));
  } catch (error) {
    if (error instanceof HttpError && error.code === "image_edit_cooldown") {
      // Cooldown rejection is admission control, so keep the same request ID
      // retryable without reserving credits or extending the burst cooldown.
      await ctx.userDb.from("image_edit_requests").update({ lease_expires_at: new Date(0).toISOString() })
        .eq("request_id", requestId).eq("lease_token", leaseToken).eq("status", "claimed");
      throw error;
    }
    if ((!artifact && !providerSucceeded) || (error instanceof HttpError && error.code === "image_edit_artifact_missing")) {
      // A failed/aborted inference never leaves chargeable usage behind.
      // If release itself fails, leave the claim recoverable (do not mark failed).
      await deps.billing.releaseImageEditRequest(requestId);
      await rpc(ctx.userDb, "transition_image_edit", { p_request_id: requestId, p_lease_token: leaseToken, p_status: "failed" });
    } else {
      if (!artifact) {
        const { data, error: lookupError } = await ctx.userDb.from("image_edit_requests").select("status")
          .eq("request_id", requestId).eq("lease_token", leaseToken).maybeSingle();
        if (!lookupError && data?.status === "invoking") {
          await deps.billing.releaseImageEditRequest(requestId);
          await rpc(ctx.userDb, "transition_image_edit", { p_request_id: requestId, p_lease_token: leaseToken, p_status: "failed" });
          throw error;
        }
      }
      // A checkpoint write may have committed despite a lost response. Only yield
      // storing/generated records; invoking records must never permit another inference.
      await ctx.userDb.from("image_edit_requests").update({ lease_expires_at: new Date(0).toISOString() })
        .eq("request_id", requestId).eq("lease_token", leaseToken).in("status", ["storing", "generated"]);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}
