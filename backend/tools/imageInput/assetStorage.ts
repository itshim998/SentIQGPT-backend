import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_VISUAL_ASSET_STORAGE_BUCKET = "sentiq-visual-assets-private";

const STORAGE_BUCKET_LIMIT_BYTES = Number.parseInt(
  process.env.SENTIQ_VISUAL_ASSET_STORAGE_LIMIT_BYTES || String(50 * 1024 * 1024),
  10,
);

const MAX_UPLOAD_RETRIES = 2;

const bucketReadyPromises = new WeakMap<SupabaseClient, Promise<void>>();

// In-memory fallback storage for unit tests / offline runs without live Supabase storage
const fallbackLocalStore = new Map<string, Buffer>();

export function getVisualAssetStorageBucketName(): string {
  return process.env.SENTIQ_VISUAL_ASSET_STORAGE_BUCKET?.trim() || DEFAULT_VISUAL_ASSET_STORAGE_BUCKET;
}

export function hashVisualAsset(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizeStorageFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

export function buildVisualAssetStoragePath(args: {
  readonly userId: string;
  readonly conversationId?: string | null;
  readonly assetId: string;
  readonly filename: string;
}): string {
  const conversationFolder = args.conversationId ? args.conversationId : "unassigned";
  const safeFilename = sanitizeStorageFilename(args.filename);
  return `${args.userId}/${conversationFolder}/${args.assetId}/${safeFilename}`;
}

async function ensureVisualAssetBucket(supabaseClient: SupabaseClient): Promise<void> {
  if (typeof supabaseClient?.storage?.getBucket !== "function") return;
  const existingPromise = bucketReadyPromises.get(supabaseClient);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    const bucketName = getVisualAssetStorageBucketName();
    try {
      const { data, error } = await supabaseClient.storage.getBucket(bucketName);
      if (!error && data) return;
      await supabaseClient.storage.createBucket(bucketName, {
        public: false,
        fileSizeLimit: STORAGE_BUCKET_LIMIT_BYTES,
        allowedMimeTypes: [
          "application/pdf",
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/heic",
          "image/heif",
        ],
      });
    } catch (err) {
      console.warn(`[Visual Storage] bucket check/create warning: ${err instanceof Error ? err.message : err}`);
    }
  })();

  bucketReadyPromises.set(supabaseClient, promise);
  try {
    await promise;
  } catch (error) {
    bucketReadyPromises.delete(supabaseClient);
  }
}

export async function uploadVisualAssetBuffer(args: {
  readonly supabaseClient?: SupabaseClient | any;
  readonly userId: string;
  readonly conversationId?: string | null;
  readonly assetId?: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}): Promise<{
  readonly assetId: string;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}> {
  const assetId = args.assetId || randomUUID();
  const sha256 = hashVisualAsset(args.buffer);
  const sizeBytes = args.buffer.length;
  const storageBucket = getVisualAssetStorageBucketName();
  const storagePath = buildVisualAssetStoragePath({
    userId: args.userId,
    conversationId: args.conversationId,
    assetId,
    filename: args.filename,
  });

  const fullKey = `${storageBucket}/${storagePath}`;
  fallbackLocalStore.set(fullKey, args.buffer);

  if (args.supabaseClient && typeof args.supabaseClient.storage?.from === "function") {
    try {
      await ensureVisualAssetBucket(args.supabaseClient);
      let uploaded = false;
      for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt += 1) {
        const { error } = await args.supabaseClient.storage
          .from(storageBucket)
          .upload(storagePath, args.buffer, {
            contentType: args.mimeType,
            cacheControl: "31536000",
            upsert: true,
          });
        if (!error) {
          uploaded = true;
          break;
        }
      }
      if (!uploaded) {
        console.warn(`[Visual Storage] live upload failed for ${storagePath}, preserved in local fallback`);
      }
    } catch (error) {
      console.warn(`[Visual Storage] error uploading to Supabase: ${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    assetId,
    storageBucket,
    storagePath,
    sizeBytes,
    sha256,
  };
}

export async function downloadVisualAssetBuffer(args: {
  readonly supabaseClient?: SupabaseClient | any;
  readonly storageBucket: string;
  readonly storagePath: string;
}): Promise<Buffer> {
  const fullKey = `${args.storageBucket}/${args.storagePath}`;
  const local = fallbackLocalStore.get(fullKey);
  if (local) return local;

  if (args.supabaseClient && typeof args.supabaseClient.storage?.from === "function") {
    const { data, error } = await args.supabaseClient.storage
      .from(args.storageBucket)
      .download(args.storagePath);
    if (error) {
      throw new Error(`Failed to download visual asset: ${error.message}`);
    }
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fallbackLocalStore.set(fullKey, buffer);
    return buffer;
  }

  throw new Error(`Visual asset not found in storage: ${args.storagePath}`);
}

export function clearVisualAssetLocalStorageForTests(): void {
  fallbackLocalStore.clear();
}
