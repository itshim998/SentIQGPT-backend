import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedFileFormat, GeneratedFilePreview } from "./types";

const DEFAULT_STORAGE_BUCKET = "sentiq-generated-files-private";
const STORAGE_BUCKET_LIMIT_BYTES = Number.parseInt(
  process.env.SENTIQ_GENERATED_FILE_STORAGE_LIMIT_BYTES || String(25 * 1024 * 1024),
  10,
);
const MAX_UPLOAD_RETRIES = 2;
const UPLOAD_RETRY_DELAY_MS = 1000;

const bucketReadyPromises = new WeakMap<SupabaseClient, Promise<void>>();

export interface UploadGeneratedFileParams {
  readonly userId: string;
  readonly chatId: string;
  readonly format: GeneratedFileFormat;
  readonly buffer: Buffer;
  readonly mimeType: string;
}

export interface UploadGeneratedFileResult {
  readonly success: boolean;
  readonly fileId?: string;
  readonly fileUrl?: string;
  readonly storagePath?: string;
  readonly storageBucket?: string;
  readonly fileSizeBytes?: number;
  readonly contentSha256?: string;
  readonly version?: number;
  readonly error?: string;
}

export interface GeneratedFileMetadataParams {
  readonly fileId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly format: GeneratedFileFormat;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileUrl: string;
  readonly storagePath: string;
  readonly storageBucket?: string;
  readonly fileSizeBytes: number;
  readonly contentSha256?: string;
  readonly version?: number;
  readonly prompt: string;
  readonly provider?: string;
  readonly preview?: GeneratedFilePreview;
}

export interface GeneratedFileMetadataUpdateParams {
  readonly fileId: string;
  readonly userId: string;
  readonly format: GeneratedFileFormat;
  readonly fileName: string;
  readonly mimeType: string;
  readonly fileUrl: string;
  readonly storagePath: string;
  readonly storageBucket: string;
  readonly fileSizeBytes: number;
  readonly contentSha256: string;
  readonly version: number;
  readonly preview?: GeneratedFilePreview;
}

export function getStorageBucketName(): string {
  return process.env.SENTIQ_GENERATED_FILE_STORAGE_BUCKET?.trim() || DEFAULT_STORAGE_BUCKET;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStorageErrorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || "");
  }
  return String(error);
}

function looksLikeMissingBucket(error: unknown): boolean {
  const message = getStorageErrorMessage(error).toLowerCase();
  return message.includes("bucket not found") || message.includes("not found");
}

function looksLikeExistingBucket(error: unknown): boolean {
  const message = getStorageErrorMessage(error).toLowerCase();
  return message.includes("already exists") || message.includes("duplicate");
}

export function buildGeneratedFileApiUrl(fileId: string, mode: "download" | "preview" = "download"): string {
  return mode === "preview"
    ? `/api/generated-files/${fileId}/preview-url`
    : `/api/generated-files/${fileId}/download`;
}

export function hashGeneratedFile(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function ensureStorageBucket(supabaseClient: SupabaseClient): Promise<void> {
  const existingPromise = bucketReadyPromises.get(supabaseClient);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const bucketName = getStorageBucketName();
    const { data, error } = await supabaseClient.storage.getBucket(bucketName);

    if (!error && data) {
      const isPublic = Boolean((data as { public?: boolean }).public);
      if (isPublic) {
        const { error: updateError } = await supabaseClient.storage.updateBucket(bucketName, {
          public: false,
          fileSizeLimit: STORAGE_BUCKET_LIMIT_BYTES,
          allowedMimeTypes: [
            "text/html",
            "text/plain",
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ],
        });
        if (updateError) {
          throw new Error(`Failed to update generated file bucket: ${updateError.message}`);
        }
      }
      return;
    }

    if (error && !looksLikeMissingBucket(error)) {
      throw new Error(`Failed to inspect generated file bucket: ${getStorageErrorMessage(error)}`);
    }

    const { error: createError } = await supabaseClient.storage.createBucket(bucketName, {
      public: false,
      fileSizeLimit: STORAGE_BUCKET_LIMIT_BYTES,
      allowedMimeTypes: [
        "text/html",
        "text/plain",
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    });

    if (createError && !looksLikeExistingBucket(createError)) {
      throw new Error(`Failed to create generated file bucket: ${createError.message}`);
    }
  })();

  bucketReadyPromises.set(supabaseClient, promise);

  try {
    await promise;
  } catch (error) {
    bucketReadyPromises.delete(supabaseClient);
    throw error;
  }
}

function generateStoragePath(
  userId: string,
  chatId: string,
  fileId: string,
  format: GeneratedFileFormat,
  version = 1,
): string {
  return `${userId}/${chatId}/${fileId}/v${version}/doc.${format}`;
}

export async function uploadGeneratedFile(
  supabaseClient: SupabaseClient,
  params: UploadGeneratedFileParams,
): Promise<UploadGeneratedFileResult> {
  const fileId = randomUUID();
  const version = 1;
  const storagePath = generateStoragePath(params.userId, params.chatId, fileId, params.format, version);
  const bucketName = getStorageBucketName();
  const contentSha256 = hashGeneratedFile(params.buffer);
  let lastError: Error | null = null;

  if (params.buffer.length > STORAGE_BUCKET_LIMIT_BYTES) {
    return {
      success: false,
      error: `Generated file exceeds storage limit (${STORAGE_BUCKET_LIMIT_BYTES} bytes).`,
    };
  }

  try {
    await ensureStorageBucket(supabaseClient);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
    try {
      const { error: uploadError } = await supabaseClient.storage
        .from(bucketName)
        .upload(storagePath, params.buffer, {
          contentType: params.mimeType,
          cacheControl: "31536000",
          upsert: false,
        });

      if (uploadError) throw new Error(uploadError.message);

      const { data: urlData } = supabaseClient.storage
        .from(bucketName)
        .getPublicUrl(storagePath);

      if (!urlData?.publicUrl) {
        throw new Error("Failed to get public URL for generated file");
      }

      return {
        success: true,
        fileId,
        fileUrl: buildGeneratedFileApiUrl(fileId),
        storagePath,
        storageBucket: bucketName,
        fileSizeBytes: params.buffer.length,
        contentSha256,
        version,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_UPLOAD_RETRIES) {
        await sleep(UPLOAD_RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || "Generated file upload failed",
  };
}

export async function uploadGeneratedFileReplacement(
  supabaseClient: SupabaseClient,
  params: UploadGeneratedFileParams & {
    readonly fileId: string;
    readonly version: number;
  },
): Promise<UploadGeneratedFileResult> {
  const storagePath = generateStoragePath(params.userId, params.chatId, params.fileId, params.format, params.version);
  const bucketName = getStorageBucketName();
  const contentSha256 = hashGeneratedFile(params.buffer);
  let lastError: Error | null = null;

  if (params.buffer.length > STORAGE_BUCKET_LIMIT_BYTES) {
    return {
      success: false,
      error: `Generated file exceeds storage limit (${STORAGE_BUCKET_LIMIT_BYTES} bytes).`,
    };
  }

  try {
    await ensureStorageBucket(supabaseClient);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
    try {
      const { error: uploadError } = await supabaseClient.storage
        .from(bucketName)
        .upload(storagePath, params.buffer, {
          contentType: params.mimeType,
          cacheControl: "31536000",
          upsert: false,
        });

      if (uploadError) throw new Error(uploadError.message);

      return {
        success: true,
        fileId: params.fileId,
        fileUrl: buildGeneratedFileApiUrl(params.fileId),
        storagePath,
        storageBucket: bucketName,
        fileSizeBytes: params.buffer.length,
        contentSha256,
        version: params.version,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < MAX_UPLOAD_RETRIES) {
        await sleep(UPLOAD_RETRY_DELAY_MS);
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || "Generated file upload failed",
  };
}

export async function saveGeneratedFileMetadata(
  supabaseClient: SupabaseClient,
  params: GeneratedFileMetadataParams,
): Promise<void> {
  const { error } = await supabaseClient
    .from("generated_files")
    .insert({
      id: params.fileId,
      user_id: params.userId,
      chat_id: params.chatId,
      format: params.format,
      file_name: params.fileName,
      mime_type: params.mimeType,
      file_url: params.fileUrl,
      storage_path: params.storagePath,
      storage_bucket: params.storageBucket || getStorageBucketName(),
      file_size_bytes: params.fileSizeBytes,
      content_sha256: params.contentSha256 || null,
      version: params.version || 1,
      prompt: params.prompt,
      provider: params.provider || null,
      preview_json: params.preview || null,
    });

  if (error) {
    throw new Error(`Failed to save generated file metadata: ${error.message}`);
  }
}

export async function updateGeneratedFileMetadata(
  supabaseClient: SupabaseClient,
  params: GeneratedFileMetadataUpdateParams,
): Promise<void> {
  const { error } = await supabaseClient
    .from("generated_files")
    .update({
      file_name: params.fileName,
      mime_type: params.mimeType,
      file_url: params.fileUrl,
      storage_path: params.storagePath,
      storage_bucket: params.storageBucket,
      file_size_bytes: params.fileSizeBytes,
      content_sha256: params.contentSha256,
      version: params.version,
      preview_json: params.preview || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.fileId)
    .eq("user_id", params.userId);

  if (error) {
    throw new Error(`Failed to update generated file metadata: ${error.message}`);
  }
}
