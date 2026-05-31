// SentIQGPT v3 — Image Storage Service
//
// Handles image upload to Supabase Storage and metadata persistence.
// Follows clean architecture: Storage → files, Database → metadata only.
//
// Features:
//   - Image compression to target <700KB
//   - Structured storage paths: ${user_id}/${chat_id}/${image_id}.png
//   - Public URL generation for CDN caching
//   - Retry mechanism for upload failures
//   - Multi-DB aware (uses user's assigned database)

import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_STORAGE_BUCKET = "sentiq-images";
const TARGET_MAX_SIZE_BYTES = 700 * 1024; // 700KB target
const STORAGE_BUCKET_LIMIT_BYTES = 1024 * 1024; // Current Supabase bucket limit
const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 2;
const UPLOAD_RETRY_DELAY_MS = 1000;

// Compression quality settings
const INITIAL_QUALITY = 85;
const MIN_QUALITY = 50;
const QUALITY_STEP = 10;

const bucketReadyPromises = new WeakMap<SupabaseClient, Promise<void>>();

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImageUploadParams {
  readonly userId: string;
  readonly chatId: string;
  readonly imageData: string; // base64, data URL, or remote image URL
  readonly prompt?: string;
  readonly provider?: string;
}

export interface ImageUploadResult {
  readonly success: boolean;
  readonly imageUrl?: string;
  readonly storagePath?: string;
  readonly imageId?: string;
  readonly fileSizeBytes?: number;
  readonly error?: string;
}

export interface ImageStorageOptions {
  readonly storageDb?: SupabaseClient;
}

export interface ChatImage {
  readonly id: string;
  readonly imageUrl: string;
  readonly storagePath: string;
  readonly prompt?: string;
  readonly provider?: string;
  readonly fileSizeBytes?: number;
  readonly createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

type PreparedImage = {
  readonly buffer: Buffer;
  readonly mimeType: "image/webp" | "image/jpeg";
  readonly extension: "webp" | "jpg";
};

type FetchLike = (
  input: string,
  init?: {
    signal?: AbortSignal;
    redirect?: "follow";
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const REMOTE_IMAGE_URL_PATTERN = /^https?:\/\//i;

function getStorageBucketName(): string {
  return process.env.SENTIQ_IMAGE_STORAGE_BUCKET?.trim() || DEFAULT_STORAGE_BUCKET;
}

/**
 * Extract raw base64 data from raw base64 or data:image/... URLs.
 */
function extractBase64Data(input: string): Buffer {
  let base64 = input.trim();

  if (base64.startsWith("data:")) {
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(base64)) {
      throw new Error("Invalid image data URL");
    }
    const commaIndex = base64.indexOf(",");
    base64 = commaIndex === -1 ? "" : base64.slice(commaIndex + 1);
  }

  base64 = base64.replace(/\s/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error("image_data must be base64 image data");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid image data");
  }
  if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`Image is too large to store. Maximum decoded size is ${MAX_INPUT_IMAGE_BYTES} bytes.`);
  }

  return buffer;
}

function getDefaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Remote image URLs are not supported because fetch is unavailable");
  }
  return globalThis.fetch.bind(globalThis) as FetchLike;
}

async function fetchRemoteImageBuffer(
  input: string,
  fetchImpl: FetchLike,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetchImpl(input, {
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Remote image fetch failed with HTTP ${response.status}`);
    }

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`Remote URL did not return an image (content-type: ${contentType})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Remote image response was empty");
    }
    if (buffer.length > MAX_INPUT_IMAGE_BYTES) {
      throw new Error(`Image is too large to store. Maximum decoded size is ${MAX_INPUT_IMAGE_BYTES} bytes.`);
    }

    return buffer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Remote image fetch timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveImageInputBuffer(
  input: string,
  fetchImpl: FetchLike = getDefaultFetch(),
): Promise<Buffer> {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    throw new Error("image_data is required");
  }

  if (trimmedInput.startsWith("data:") || /^[A-Za-z0-9+/]+={0,2}$/.test(trimmedInput.replace(/\s/g, ""))) {
    return extractBase64Data(trimmedInput);
  }

  if (REMOTE_IMAGE_URL_PATTERN.test(trimmedInput)) {
    return fetchRemoteImageBuffer(trimmedInput, fetchImpl);
  }

  throw new Error("image_data must be base64 image data, a data URL, or an http(s) image URL");
}

async function assertValidImage(imageBuffer: Buffer): Promise<void> {
  try {
    await sharp(imageBuffer).metadata();
  } catch {
    throw new Error("Invalid image data; unable to decode image");
  }
}

/**
 * Compress image to target size using sharp.
 * Uses WebP first for generated images, with JPEG as a compatibility fallback.
 */
async function compressImage(imageBuffer: Buffer): Promise<PreparedImage> {
  await assertValidImage(imageBuffer);

  let quality = INITIAL_QUALITY;
  let prepared: PreparedImage = {
    buffer: await sharp(imageBuffer)
      .rotate()
      .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer(),
    mimeType: "image/webp",
    extension: "webp",
  };

  while (prepared.buffer.length > TARGET_MAX_SIZE_BYTES && quality > MIN_QUALITY) {
    quality -= QUALITY_STEP;
    prepared = {
      buffer: await sharp(imageBuffer)
        .rotate()
        .resize(1280, 1280, { fit: "inside", withoutEnlargement: true })
        .webp({ quality })
        .toBuffer(),
      mimeType: "image/webp",
      extension: "webp",
    };
  }

  if (prepared.buffer.length > TARGET_MAX_SIZE_BYTES) {
    prepared = {
      buffer: await sharp(imageBuffer)
        .rotate()
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 72, mozjpeg: true })
        .toBuffer(),
      mimeType: "image/jpeg",
      extension: "jpg",
    };
  }

  console.log(
    `[ImageStorage] compress original=${imageBuffer.length} compressed=${prepared.buffer.length} ` +
    `ratio=${((1 - prepared.buffer.length / imageBuffer.length) * 100).toFixed(1)}% mime=${prepared.mimeType}`
  );

  if (prepared.buffer.length > STORAGE_BUCKET_LIMIT_BYTES) {
    throw new Error("Compressed image exceeds the configured storage bucket size limit");
  }

  return prepared;
}

/**
 * Generate storage path for an image.
 * Format: ${user_id}/${chat_id}/${image_id}.${extension}
 */
function generateStoragePath(userId: string, chatId: string, imageId: string, extension: string): string {
  return `${userId}/${chatId}/${imageId}.${extension}`;
}

/**
 * Sleep helper for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function ensureStorageBucket(supabaseClient: SupabaseClient): Promise<void> {
  const existingPromise = bucketReadyPromises.get(supabaseClient);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const bucketName = getStorageBucketName();
    const { data, error } = await supabaseClient.storage.getBucket(bucketName);

    if (!error && data) {
      const isPublic = Boolean((data as { public?: boolean }).public);
      if (!isPublic) {
        const { error: updateError } = await supabaseClient.storage.updateBucket(bucketName, {
          public: true,
          fileSizeLimit: STORAGE_BUCKET_LIMIT_BYTES,
          allowedMimeTypes: ["image/*"],
        });
        if (updateError) {
          throw new Error(`Failed to make image storage bucket public: ${updateError.message}`);
        }
        console.log(`[ImageStorage] bucket.public.ok bucket=${bucketName}`);
      }
      return;
    }

    if (error && !looksLikeMissingBucket(error)) {
      throw new Error(`Failed to inspect image storage bucket: ${getStorageErrorMessage(error)}`);
    }

    console.warn(`[ImageStorage] bucket.missing bucket=${bucketName} - creating`);
    const { error: createError } = await supabaseClient.storage.createBucket(bucketName, {
      public: true,
      fileSizeLimit: STORAGE_BUCKET_LIMIT_BYTES,
      allowedMimeTypes: ["image/*"],
    });

    if (createError && !looksLikeExistingBucket(createError)) {
      throw new Error(`Failed to create image storage bucket: ${createError.message}`);
    }

    console.log(`[ImageStorage] bucket.ready bucket=${bucketName}`);
  })();

  bucketReadyPromises.set(supabaseClient, promise);

  try {
    await promise;
  } catch (error) {
    bucketReadyPromises.delete(supabaseClient);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STORAGE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upload image to Supabase Storage with compression and retries.
 * Returns the public URL on success.
 */
async function uploadToStorage(
  supabaseClient: SupabaseClient,
  storagePath: string,
  imageBuffer: Buffer,
  contentType: string,
): Promise<{ publicUrl: string; sizeBytes: number }> {
  let lastError: Error | null = null;
  const bucketName = getStorageBucketName();

  await ensureStorageBucket(supabaseClient);
  
  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      console.log(
        `[ImageStorage] upload.start bucket=${bucketName} path=${storagePath} ` +
        `attempt=${attempt} size=${imageBuffer.length} contentType=${contentType}`
      );
      
      const { error: uploadError } = await supabaseClient.storage
        .from(bucketName)
        .upload(storagePath, imageBuffer, {
          contentType,
          cacheControl: "31536000", // 1 year cache
          upsert: false, // Don't overwrite existing
        });
      
      if (uploadError) {
        throw new Error(uploadError.message);
      }
      
      // Get public URL
      const { data: urlData } = supabaseClient.storage
        .from(bucketName)
        .getPublicUrl(storagePath);
      
      if (!urlData?.publicUrl) {
        throw new Error("Failed to get public URL for uploaded image");
      }
      
      console.log(`[ImageStorage] upload.ok path=${storagePath} url=${urlData.publicUrl.slice(0, 80)}...`);
      
      return {
        publicUrl: urlData.publicUrl,
        sizeBytes: imageBuffer.length,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[ImageStorage] upload.failed path=${storagePath} attempt=${attempt} error=${lastError.message}`);
      
      if (attempt < MAX_UPLOAD_RETRIES) {
        await sleep(UPLOAD_RETRY_DELAY_MS);
      }
    }
  }
  
  throw lastError || new Error("Upload failed after all retries");
}

/**
 * Save image metadata to database.
 */
async function saveImageMetadata(
  supabaseClient: SupabaseClient,
  params: {
    imageId: string;
    userId: string;
    chatId: string;
    imageUrl: string;
    storagePath: string;
    prompt?: string;
    provider?: string;
    fileSizeBytes: number;
  },
): Promise<void> {
  const { error } = await supabaseClient
    .from("chat_images")
    .insert({
      id: params.imageId,
      user_id: params.userId,
      chat_id: params.chatId,
      image_url: params.imageUrl,
      storage_path: params.storagePath,
      prompt: params.prompt || null,
      provider: params.provider || null,
      file_size_bytes: params.fileSizeBytes,
    });
  
  if (error) {
    console.error(`[ImageStorage] metadata.save.failed imageId=${params.imageId} error=${error.message}`);
    throw new Error(`Failed to save image metadata: ${error.message}`);
  }
  
  console.log(`[ImageStorage] metadata.save.ok imageId=${params.imageId}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Upload an image to Supabase Storage and save metadata.
 * 
 * @param userDb - The user's assigned Supabase client
 * @param params - Upload parameters including userId, chatId, and image data
 * @returns Upload result with public URL or error
 */
export async function uploadChatImage(
  userDb: SupabaseClient,
  params: ImageUploadParams,
  options: ImageStorageOptions = {},
): Promise<ImageUploadResult> {
  const { userId, chatId, imageData, prompt, provider } = params;
  const storageDb = options.storageDb ?? userDb;
  const imageId = randomUUID();
  let uploadedStoragePath: string | null = null;
  
  try {
    // 1. Extract and validate image data
    console.log(`[ImageStorage] process.start userId=${userId} chatId=${chatId}`);
    const rawBuffer = await resolveImageInputBuffer(imageData);

    // 2. Compress image to target size
    const preparedImage = await compressImage(rawBuffer);
    
    // 3. Generate storage path
    const storagePath = generateStoragePath(userId, chatId, imageId, preparedImage.extension);
    
    // 4. Upload to Supabase Storage
    const { publicUrl, sizeBytes } = await uploadToStorage(
      storageDb,
      storagePath,
      preparedImage.buffer,
      preparedImage.mimeType,
    );
    uploadedStoragePath = storagePath;
    
    // 5. Save metadata to database
    await saveImageMetadata(userDb, {
      imageId,
      userId,
      chatId,
      imageUrl: publicUrl,
      storagePath,
      prompt,
      provider,
      fileSizeBytes: sizeBytes,
    });
    
    console.log(`[ImageStorage] process.ok imageId=${imageId} size=${sizeBytes} url=${publicUrl.slice(0, 60)}...`);
    
    return {
      success: true,
      imageUrl: publicUrl,
      storagePath,
      imageId,
      fileSizeBytes: sizeBytes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ImageStorage] process.failed userId=${userId} chatId=${chatId} error=${message}`);

    if (uploadedStoragePath) {
      await storageDb.storage
        .from(getStorageBucketName())
        .remove([uploadedStoragePath])
        .then(({ error }) => {
          if (error) {
            console.warn(`[ImageStorage] cleanup.failed path=${uploadedStoragePath} error=${error.message}`);
          } else {
            console.log(`[ImageStorage] cleanup.ok path=${uploadedStoragePath}`);
          }
        })
        .catch((cleanupError) => {
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          console.warn(`[ImageStorage] cleanup.error path=${uploadedStoragePath} error=${cleanupMessage}`);
        });
    }
    
    return {
      success: false,
      error: message,
    };
  }
}

/**
 * Get all images for a chat.
 */
export async function getChatImages(
  userDb: SupabaseClient,
  userId: string,
  chatId: string,
): Promise<ChatImage[]> {
  try {
    const { data, error } = await userDb
      .from("chat_images")
      .select("id, image_url, storage_path, prompt, provider, file_size_bytes, created_at")
      .eq("user_id", userId)
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    
    if (error) {
      console.error(`[ImageStorage] getChatImages.failed userId=${userId} chatId=${chatId} error=${error.message}`);
      return [];
    }
    
    return (data || []).map((row: any) => ({
      id: row.id,
      imageUrl: row.image_url,
      storagePath: row.storage_path,
      prompt: row.prompt,
      provider: row.provider,
      fileSizeBytes: row.file_size_bytes,
      createdAt: row.created_at,
    }));
  } catch (err) {
    console.error(`[ImageStorage] getChatImages.error userId=${userId} chatId=${chatId}`, err);
    return [];
  }
}

/**
 * Delete an image from storage and database.
 */
export async function deleteChatImage(
  userDb: SupabaseClient,
  userId: string,
  imageId: string,
  options: ImageStorageOptions = {},
): Promise<boolean> {
  const storageDb = options.storageDb ?? userDb;
  try {
    // Get image metadata first
    const { data: image, error: fetchError } = await userDb
      .from("chat_images")
      .select("storage_path")
      .eq("id", imageId)
      .eq("user_id", userId)
      .single();
    
    if (fetchError || !image) {
      console.error(`[ImageStorage] delete.notfound imageId=${imageId}`);
      return false;
    }
    
    // Delete from storage
    const { error: storageError } = await storageDb.storage
      .from(getStorageBucketName())
      .remove([image.storage_path]);
    
    if (storageError) {
      console.warn(`[ImageStorage] delete.storage.failed imageId=${imageId} error=${storageError.message}`);
      return false;
    }
    
    // Delete metadata
    const { error: dbError } = await userDb
      .from("chat_images")
      .delete()
      .eq("id", imageId)
      .eq("user_id", userId);
    
    if (dbError) {
      console.error(`[ImageStorage] delete.metadata.failed imageId=${imageId} error=${dbError.message}`);
      return false;
    }
    
    console.log(`[ImageStorage] delete.ok imageId=${imageId}`);
    return true;
  } catch (err) {
    console.error(`[ImageStorage] delete.error imageId=${imageId}`, err);
    return false;
  }
}
