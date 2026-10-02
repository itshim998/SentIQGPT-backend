import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CreateVisualAssetParams,
  VisualAnalysisStatus,
  VisualAssetRow,
} from "./types";

const VISUAL_ASSET_COLUMNS =
  "id,owner_user_id,conversation_id,filename,original_mime_type,asset_type,storage_bucket,storage_path,size_bytes,sha256,page_count,status,visual_required,visual_analysis_status,canonical_source_document_id,visual_analysis_version,metadata,created_at,updated_at";

const fallbackAssetsStore = new Map<string, VisualAssetRow>();

function normalizeVisualAssetRow(value: unknown): VisualAssetRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.owner_user_id !== "string" ||
    typeof row.filename !== "string" ||
    typeof row.original_mime_type !== "string" ||
    typeof row.storage_bucket !== "string" ||
    typeof row.storage_path !== "string" ||
    typeof row.sha256 !== "string"
  ) {
    return undefined;
  }
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    conversation_id: typeof row.conversation_id === "string" ? row.conversation_id : null,
    filename: row.filename,
    original_mime_type: row.original_mime_type,
    asset_type: row.asset_type === "pdf" ? "pdf" : "image",
    storage_bucket: row.storage_bucket,
    storage_path: row.storage_path,
    size_bytes: Number(row.size_bytes) || 0,
    sha256: row.sha256,
    page_count: typeof row.page_count === "number" ? row.page_count : null,
    status: (row.status as VisualAssetRow["status"]) || "ready",
    visual_required: row.visual_required !== false,
    visual_analysis_status:
      (row.visual_analysis_status as VisualAnalysisStatus) || "required",
    canonical_source_document_id:
      typeof row.canonical_source_document_id === "string"
        ? row.canonical_source_document_id
        : null,
    visual_analysis_version: Number(row.visual_analysis_version) || 1,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}

export async function createVisualAssetRecord(args: {
  readonly userDb?: SupabaseClient | any;
  readonly params: CreateVisualAssetParams;
}): Promise<VisualAssetRow> {
  const { params } = args;
  const rowPayload: Record<string, unknown> = {
    owner_user_id: params.ownerUserId,
    conversation_id: params.conversationId ?? null,
    filename: params.filename,
    original_mime_type: params.originalMimeType,
    asset_type: params.assetType,
    storage_bucket: params.storageBucket,
    storage_path: params.storagePath,
    size_bytes: params.sizeBytes,
    sha256: params.sha256,
    page_count: params.pageCount ?? null,
    status: "ready",
    visual_required: params.visualRequired !== false,
    visual_analysis_status: params.visualAnalysisStatus ?? "required",
    visual_analysis_version: 1,
    metadata: params.metadata ?? {},
  };

  if (args.userDb && typeof args.userDb.from === "function") {
    try {
      const result = await args.userDb
        .from("visual_assets")
        .insert(rowPayload)
        .select(VISUAL_ASSET_COLUMNS)
        .single();
      if (!result.error && result.data) {
        const row = normalizeVisualAssetRow(result.data);
        if (row) {
          fallbackAssetsStore.set(row.id, row);
          return row;
        }
      }
    } catch (err) {
      console.warn(`[Visual Asset] DB insert warning: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Fallback row for testing/offline
  const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const fallbackRow: VisualAssetRow = {
    id,
    owner_user_id: params.ownerUserId,
    conversation_id: params.conversationId ?? null,
    filename: params.filename,
    original_mime_type: params.originalMimeType,
    asset_type: params.assetType,
    storage_bucket: params.storageBucket,
    storage_path: params.storagePath,
    size_bytes: params.sizeBytes,
    sha256: params.sha256,
    page_count: params.pageCount ?? null,
    status: "ready",
    visual_required: params.visualRequired !== false,
    visual_analysis_status: params.visualAnalysisStatus ?? "required",
    visual_analysis_version: 1,
    metadata: params.metadata ?? {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fallbackAssetsStore.set(id, fallbackRow);
  return fallbackRow;
}

export async function getVisualAssetById(args: {
  readonly userDb?: SupabaseClient | any;
  readonly assetId: string;
  readonly ownerUserId: string;
}): Promise<VisualAssetRow | null> {
  const local = fallbackAssetsStore.get(args.assetId);
  if (local && local.owner_user_id === args.ownerUserId) {
    return local;
  }

  if (args.userDb && typeof args.userDb.from === "function") {
    try {
      const result = await args.userDb
        .from("visual_assets")
        .select(VISUAL_ASSET_COLUMNS)
        .eq("id", args.assetId)
        .eq("owner_user_id", args.ownerUserId)
        .maybeSingle();
      if (!result.error && result.data) {
        const row = normalizeVisualAssetRow(result.data);
        if (row) {
          fallbackAssetsStore.set(row.id, row);
          return row;
        }
      }
    } catch (err) {
      console.warn(`[Visual Asset] getById error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return local ?? null;
}

export async function findVisualAssetBySha256(args: {
  readonly userDb?: SupabaseClient | any;
  readonly ownerUserId: string;
  readonly sha256: string;
}): Promise<VisualAssetRow | null> {
  for (const asset of fallbackAssetsStore.values()) {
    if (asset.owner_user_id === args.ownerUserId && asset.sha256 === args.sha256) {
      return asset;
    }
  }

  if (args.userDb && typeof args.userDb.from === "function") {
    try {
      const result = await args.userDb
        .from("visual_assets")
        .select(VISUAL_ASSET_COLUMNS)
        .eq("owner_user_id", args.ownerUserId)
        .eq("sha256", args.sha256)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!result.error && result.data) {
        return normalizeVisualAssetRow(result.data) ?? null;
      }
    } catch (err) {
      console.warn(`[Visual Asset] findBySha256 error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return null;
}

export async function updateVisualAssetAnalysis(args: {
  readonly userDb?: SupabaseClient | any;
  readonly assetId: string;
  readonly ownerUserId: string;
  readonly visualAnalysisStatus: VisualAnalysisStatus;
  readonly canonicalSourceDocumentId?: string | null;
  readonly metadataUpdates?: Record<string, unknown>;
}): Promise<void> {
  const existing = fallbackAssetsStore.get(args.assetId);
  if (existing) {
    const updated: VisualAssetRow = {
      ...existing,
      visual_analysis_status: args.visualAnalysisStatus,
      canonical_source_document_id:
        args.canonicalSourceDocumentId !== undefined
          ? args.canonicalSourceDocumentId
          : existing.canonical_source_document_id,
      metadata: { ...existing.metadata, ...(args.metadataUpdates ?? {}) },
      updated_at: new Date().toISOString(),
    };
    fallbackAssetsStore.set(args.assetId, updated);
  }

  if (args.userDb && typeof args.userDb.from === "function") {
    try {
      const patch: Record<string, unknown> = {
        visual_analysis_status: args.visualAnalysisStatus,
        updated_at: new Date().toISOString(),
      };
      if (args.canonicalSourceDocumentId !== undefined) {
        patch.canonical_source_document_id = args.canonicalSourceDocumentId;
      }
      if (args.metadataUpdates) {
        patch.metadata = { ...(existing?.metadata ?? {}), ...args.metadataUpdates };
      }
      await args.userDb
        .from("visual_assets")
        .update(patch)
        .eq("id", args.assetId)
        .eq("owner_user_id", args.ownerUserId);
    } catch (err) {
      console.warn(`[Visual Asset] update error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export function clearVisualAssetStoreForTests(): void {
  fallbackAssetsStore.clear();
}
