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

const STORAGE_BUCKET = "sentiq-images";
const TARGET_MAX_SIZE_BYTES = 700 * 1024; // 700KB target
const MAX_UPLOAD_RETRIES = 2;
const UPLOAD_RETRY_DELAY_MS = 1000;

// Compression quality settings
const INITIAL_QUALITY = 85;
const MIN_QUALITY = 50;
const QUALITY_STEP = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ImageUploadParams {
  readonly userId: string;
  readonly chatId: string;
  readonly imageData: string; // base64 or data URL
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

/**
 * Extract raw base64 data from various input formats.
 * Handles: raw base64, data:image/... URLs
 */
function extractBase64Data(input: string): Buffer {
  let base64 = input;
  
  // Remove data URL prefix if present
  if (base64.startsWith("data:")) {
    const commaIndex = base64.indexOf(",");
    if (commaIndex !== -1) {
      base64 = base64.slice(commaIndex + 1);
    }
  }
  
  return Buffer.from(base64, "base64");
}

/**
 * Compress image to target size using sharp.
 * Uses progressive quality reduction until target is met.
 */
async function compressImage(imageBuffer: Buffer): Promise<Buffer> {
  let quality = INITIAL_QUALITY;
  let compressed = imageBuffer;
  
  // First pass: convert to PNG and get initial size
  try {
    compressed = await sharp(imageBuffer)
      .png({ quality: INITIAL_QUALITY, compressionLevel: 9 })
      .toBuffer();
  } catch {
    // If sharp fails, return original
    return imageBuffer;
  }
  
  // Progressive compression if still too large
  while (compressed.length > TARGET_MAX_SIZE_BYTES && quality > MIN_QUALITY) {
    quality -= QUALITY_STEP;
    
    try {
      compressed = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .png({ quality, compressionLevel: 9 })
        .toBuffer();
    } catch {
      break;
    }
  }
  
  // Final fallback: JPEG with aggressive compression
  if (compressed.length > TARGET_MAX_SIZE_BYTES) {
    try {
      compressed = await sharp(imageBuffer)
        .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch {
      // Return best effort
    }
  }
  
  console.log(
    `[ImageStorage] compress original=${imageBuffer.length} compressed=${compressed.length} ` +
    `ratio=${((1 - compressed.length / imageBuffer.length) * 100).toFixed(1)}%`
  );
  
  return compressed;
}

/**
 * Generate storage path for an image.
 * Format: ${user_id}/${chat_id}/${image_id}.png
 */
function generateStoragePath(userId: string, chatId: string, imageId: string): string {
  return `${userId}/${chatId}/${imageId}.png`;
}

/**
 * Sleep helper for retry delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
): Promise<{ publicUrl: string; sizeBytes: number }> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      console.log(`[ImageStorage] upload.start path=${storagePath} attempt=${attempt} size=${imageBuffer.length}`);
      
      const { error: uploadError } = await supabaseClient.storage
        .from(STORAGE_BUCKET)
        .upload(storagePath, imageBuffer, {
          contentType: "image/png",
          cacheControl: "31536000", // 1 year cache
          upsert: false, // Don't overwrite existing
        });
      
      if (uploadError) {
        throw new Error(uploadError.message);
      }
      
      // Get public URL
      const { data: urlData } = supabaseClient.storage
        .from(STORAGE_BUCKET)
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
): Promise<ImageUploadResult> {
  const { userId, chatId, imageData, prompt, provider } = params;
  const imageId = randomUUID();
  
  try {
    // 1. Extract and validate image data
    console.log(`[ImageStorage] process.start userId=${userId} chatId=${chatId}`);
    const rawBuffer = extractBase64Data(imageData);
    
    if (rawBuffer.length === 0) {
      return { success: false, error: "Invalid image data" };
    }
    
    // 2. Compress image to target size
    const compressedBuffer = await compressImage(rawBuffer);
    
    // 3. Generate storage path
    const storagePath = generateStoragePath(userId, chatId, imageId);
    
    // 4. Upload to Supabase Storage
    const { publicUrl, sizeBytes } = await uploadToStorage(userDb, storagePath, compressedBuffer);
    
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
): Promise<boolean> {
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
    const { error: storageError } = await userDb.storage
      .from(STORAGE_BUCKET)
      .remove([image.storage_path]);
    
    if (storageError) {
      console.warn(`[ImageStorage] delete.storage.failed imageId=${imageId} error=${storageError.message}`);
      // Continue to delete metadata even if storage delete fails
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
