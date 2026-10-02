export type VisualAssetType = "pdf" | "image";

export type VisualAssetStatus = "processing" | "ready" | "failed";

export type VisualAnalysisStatus =
  | "not_required"
  | "required"
  | "processing"
  | "ready"
  | "partial"
  | "failed";

export interface VisualAssetRow {
  readonly id: string;
  readonly owner_user_id: string;
  readonly conversation_id: string | null;
  readonly filename: string;
  readonly original_mime_type: string;
  readonly asset_type: VisualAssetType;
  readonly storage_bucket: string;
  readonly storage_path: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly page_count?: number | null;
  readonly status: VisualAssetStatus;
  readonly visual_required: boolean;
  readonly visual_analysis_status: VisualAnalysisStatus;
  readonly canonical_source_document_id?: string | null;
  readonly visual_analysis_version: number;
  readonly metadata: Record<string, unknown>;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface CreateVisualAssetParams {
  readonly ownerUserId: string;
  readonly conversationId?: string | null;
  readonly filename: string;
  readonly originalMimeType: string;
  readonly assetType: VisualAssetType;
  readonly storageBucket: string;
  readonly storagePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly pageCount?: number | null;
  readonly visualRequired?: boolean;
  readonly visualAnalysisStatus?: VisualAnalysisStatus;
  readonly metadata?: Record<string, unknown>;
}

export interface ImageInputToolArgs {
  readonly attachment_ids?: readonly string[];
  readonly asset_ids?: readonly string[];
  readonly target_assets?: readonly string[];
  readonly target_asset?: string;
  readonly query?: string;
  readonly request?: string;
  readonly page_range?: string;
  readonly detail_level?: "low" | "medium" | "high";
}

export interface PageVisualEvidence {
  readonly page_number: number;
  readonly extracted_text: string;
  readonly visual_summary: string;
  readonly uncertainty?: string;
  readonly needs_refinement?: boolean;
  readonly confidence?: "high" | "medium" | "low";
  readonly render_dimensions?: { readonly width: number; readonly height: number };
  readonly preprocessing_variant?: string;
}

export interface VisualAssetPageRecord {
  readonly page_number: number;
  readonly render_dimensions: { readonly width: number; readonly height: number };
  readonly preprocessing_variant: string;
  readonly analysis_status: "ready" | "failed";
  readonly ocr_text: string;
  readonly visual_summary: string;
  readonly uncertainty?: string;
  readonly confidence?: "high" | "medium" | "low";
  readonly gemini_model: string;
  readonly processing_version: number;
  readonly updated_at: string;
}

export interface CanonicalSourceReference {
  readonly attachment_id: string;
  readonly source_document_id?: string;
  readonly status: "ready" | "processing" | "failed";
}

export interface RequestEvidence {
  readonly relevant_text: string;
  readonly relevant_pages: readonly number[];
  readonly visual_findings: string;
}

export interface ImageInputTokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached?: boolean;
  readonly key_slot?: number;
  readonly model?: string;
}

export interface ImageInputResult {
  readonly assets: readonly {
    readonly attachment_id: string;
    readonly filename: string;
    readonly asset_type: VisualAssetType;
    readonly pages_processed: number;
  }[];
  readonly pages: readonly PageVisualEvidence[];
  readonly canonical_sources: readonly CanonicalSourceReference[];
  readonly request_evidence: RequestEvidence;
  readonly warnings: readonly string[];
  readonly token_usage?: ImageInputTokenUsage;
}
