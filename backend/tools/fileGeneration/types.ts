export type GeneratedFileFormat = "html" | "txt" | "xlsx" | "pptx" | "docx" | "pdf";

export interface GeneratedFilePreview {
  readonly text?: string;
  readonly html?: string;
  readonly sheet?: {
    readonly name: string;
    readonly rows: readonly (readonly string[])[];
    readonly row_count?: number;
    readonly column_count?: number;
  };
  readonly sheets?: readonly {
    readonly name: string;
    readonly rows: readonly (readonly string[])[];
    readonly row_count: number;
    readonly column_count: number;
  }[];
  readonly slide?: {
    readonly title: string;
    readonly bullets: readonly string[];
    readonly notes?: string;
    readonly index?: number;
  };
  readonly slides?: readonly {
    readonly title: string;
    readonly bullets: readonly string[];
    readonly notes?: string;
    readonly index: number;
  }[];
  readonly slide_count?: number;
  readonly document?: {
    readonly title: string;
    readonly section_count?: number;
    readonly word_count?: number;
  };
}

export interface GeneratedFileResult {
  readonly type?: "file";
  readonly success: boolean;
  readonly format: GeneratedFileFormat;
  readonly file_name: string;
  readonly mime_type: string;
  readonly file_url?: string;
  readonly storage_path?: string;
  readonly storage_bucket?: string;
  readonly file_size_bytes?: number;
  readonly content_sha256?: string;
  readonly version?: number;
  readonly file_id?: string;
  readonly preview?: GeneratedFilePreview;
  readonly html?: string;
  readonly text?: string;
  readonly model_used?: string;
  readonly fallback?: boolean;
  readonly fallback_reason?: string | null;
  readonly error?: string;
}

export interface FileGenerationRequest {
  readonly userMessage: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly userDb: any;
  readonly storageDb?: any;
}
