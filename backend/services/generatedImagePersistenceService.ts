import {
  getConversationMessageByClientRequestId,
  insertConversationMessage,
  type ConversationMessageRow,
} from "./conversationService";
import { uploadChatImage, uploadEditedImageArtifact, verifyEditedImageArtifact } from "../tools/imageGeneration/imageStorageService";
import type { SupabaseClient } from "@supabase/supabase-js";

export type EditedImageArtifact = {
  imageUrl: string; storagePath: string; fileSizeBytes: number; contentSha256: string; provider: string;
};

/** The shard transaction records both version lineage and a recovery checkpoint.
 * The original file is never passed to an upload/delete operation. */
export async function persistEditedImageResult(params: {
  userDb: SupabaseClient; storageDb: SupabaseClient; userId: string; conversationId: string;
  imageId: string; requestId: string; leaseToken: string; bytes: Buffer; provider: string; requireAlpha: boolean;
}): Promise<EditedImageArtifact> {
  const uploaded = await uploadEditedImageArtifact(params.storageDb, { ...params,
    beforeUpload: async (artifact) => {
      const { error } = await params.userDb.rpc("prepare_image_edit_artifact", {
        p_request_id: params.requestId, p_lease_token: params.leaseToken, p_artifact: { ...artifact, provider: params.provider },
      });
      if (error) throw new Error("Edited image upload checkpoint could not be saved");
    },
  });
  const artifact = { ...uploaded, provider: params.provider };
  const { error } = await params.userDb.rpc("record_image_edit_artifact", {
    p_request_id: params.requestId, p_lease_token: params.leaseToken, p_artifact: artifact,
  });
  if (error) throw new Error("Edited image checkpoint could not be saved");
  return artifact;
}

export async function recoverEditedImageResult(userDb: SupabaseClient, storageDb: SupabaseClient,
  requestId: string, leaseToken: string, artifact: EditedImageArtifact): Promise<void> {
  await verifyEditedImageArtifact(storageDb, artifact);
  const { error } = await userDb.rpc("record_image_edit_artifact", {
    p_request_id: requestId, p_lease_token: leaseToken, p_artifact: artifact,
  });
  if (error) throw new Error("Edited image recovery checkpoint could not be saved");
}

type PersistGeneratedImageDependencies = {
  insertMessage?: typeof insertConversationMessage;
  findMessageByClientRequestId?: typeof getConversationMessageByClientRequestId;
  uploadImage?: typeof uploadChatImage;
};

export type PersistGeneratedImageParams = {
  userDb: any;
  userId: string;
  conversationId: string;
  prompt: string;
  generatedImageData: string;
  provider?: string;
  clientRequestId?: string;
  storageDb?: any;
  persistPromptMessage?: boolean;
};

export type PersistGeneratedImageResult = {
  promptMessage: ConversationMessageRow | null;
  assistantMessage: ConversationMessageRow;
  storedImage: {
    imageUrl: string;
    storagePath: string;
    imageId?: string;
    fileSizeBytes?: number;
  };
  promptDuplicate: boolean;
  assistantDuplicate: boolean;
};

export function buildImagePromptMessageContent(prompt: string): string {
  return `Generate image: ${prompt}`;
}

export async function findExistingAssistantImageMessage(
  userDb: any,
  conversationId: string,
  clientRequestId?: string,
  findMessageByClientRequestId: typeof getConversationMessageByClientRequestId = getConversationMessageByClientRequestId,
): Promise<ConversationMessageRow | null> {
  const trimmedClientRequestId = typeof clientRequestId === "string" ? clientRequestId.trim() : "";
  if (!trimmedClientRequestId) return null;

  const { data, error } = await findMessageByClientRequestId(userDb, {
    conversationId,
    clientRequestId: trimmedClientRequestId,
    role: "assistant",
    messageType: "image",
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function persistGeneratedImageResult(
  params: PersistGeneratedImageParams,
  dependencies: PersistGeneratedImageDependencies = {},
): Promise<PersistGeneratedImageResult> {
  const insertMessage = dependencies.insertMessage ?? insertConversationMessage;
  const uploadImage = dependencies.uploadImage ?? uploadChatImage;
  const trimmedClientRequestId = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";

  const promptInsert = params.persistPromptMessage === false
    ? { data: null, error: null, duplicate: false }
    : await insertMessage(params.userDb, {
        conversationId: params.conversationId,
        role: "user",
        content: buildImagePromptMessageContent(params.prompt),
        clientRequestId: trimmedClientRequestId || undefined,
      });

  if (promptInsert.error) throw new Error(promptInsert.error.message);

  const uploaded = await uploadImage(
    params.userDb,
    {
      userId: params.userId,
      chatId: params.conversationId,
      imageData: params.generatedImageData,
      prompt: params.prompt,
      provider: params.provider,
    },
    params.storageDb ? { storageDb: params.storageDb } : {},
  );

  if (!uploaded.success || !uploaded.imageUrl || !uploaded.storagePath) {
    throw new Error(uploaded.error || "Failed to store generated image");
  }

  const assistantInsert = await insertMessage(params.userDb, {
    conversationId: params.conversationId,
    role: "assistant",
    content: "",
    clientRequestId: trimmedClientRequestId || undefined,
    messageType: "image",
    imageUrl: uploaded.imageUrl,
    storagePath: uploaded.storagePath,
    prompt: params.prompt,
    provider: params.provider,
    fileSizeBytes: uploaded.fileSizeBytes,
  });

  if (assistantInsert.error || !assistantInsert.data) {
    throw new Error(assistantInsert.error?.message || "Failed to persist generated image message");
  }

  return {
    promptMessage: promptInsert.data ?? null,
    assistantMessage: assistantInsert.data,
    storedImage: {
      imageUrl: uploaded.imageUrl,
      storagePath: uploaded.storagePath,
      imageId: uploaded.imageId,
      fileSizeBytes: uploaded.fileSizeBytes,
    },
    promptDuplicate: promptInsert.duplicate === true,
    assistantDuplicate: assistantInsert.duplicate === true,
  };
}
