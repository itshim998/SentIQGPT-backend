import { createHash } from "node:crypto";
import { callLLMAdapter, strictParseJsonObject, getDemoFallbackResponse } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";
import {
  getInternalGatewayHeaders,
  getInternalGatewayUrl,
  waitForInternalGatewayReady,
} from "../internalGateway";
import { bootProfiler } from "../bootProfiler";
import {
  registerPendingPdfCanonicalSource,
  type ExtractedPdfPage,
  type PendingPdfCanonicalSource,
} from "./pdfCanonicalSourceRegistry";

// SentIQ Chat v1 — File Ingestion Handler
//
// Processes uploaded files (PDF, TXT, images) and extracts usable content.
// PDF responses expose only a bounded browser preview. Authenticated PDF uploads
// keep a short-lived parser handle for canonical, page-by-page persistence.

export interface FileExtractionResult {
  readonly filename: string;
  readonly type: "pdf" | "txt" | "image";
  readonly extracted_text: string;
  readonly size_bytes: number;
  readonly page_count?: number;
  readonly indexed_page_count?: number;
  readonly extraction_status?: "text" | "partial" | "ocr_required" | "failed";
  readonly ocr_required?: boolean;
  readonly visual_required?: boolean;
  readonly visual_analysis_status?: "not_required" | "required" | "processing" | "ready" | "failed";
  readonly preview_truncated?: boolean;
  readonly preview_character_count?: number;
}

interface PdfPreviewExtractionResult {
  readonly previewText: string;
  readonly declaredPageCount: number;
  readonly pageCount: number;
  readonly extractionStatus: "text" | "partial" | "ocr_required" | "failed";
  readonly ocrRequired: boolean;
  readonly previewTruncated: boolean;
}

// Allowed MIME types
const ALLOWED_TYPES: Record<string, "pdf" | "txt" | "image"> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/html": "txt",
  "text/css": "txt",
  "text/javascript": "txt",
  "application/javascript": "txt",
  "text/typescript": "txt",
  "application/typescript": "txt",
  "application/json": "txt",
  "text/xml": "txt",
  "application/xml": "txt",
  "text/markdown": "txt",
  "text/x-python": "txt",
  "text/x-java-source": "txt",
  "text/x-c": "txt",
  "text/x-c++src": "txt",
  "text/x-rustsrc": "txt",
  "text/x-go": "txt",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "image/heic": "image",
  "image/heif": "image",
};

const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const EXTENSION_TYPES: Record<string, "pdf" | "image"> = {
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".heic": "image",
  ".heif": "image",
};

function normalizeMimeType(mimetype: string): string {
  return String(mimetype || "").trim().toLowerCase();
}

// Extension-based fallback for code files that browsers send as octet-stream
const TEXT_EXTENSIONS = new Set([
  ".html", ".css", ".js", ".ts", ".json", ".xml", ".md",
  ".txt", ".py", ".java", ".cpp", ".c", ".rs", ".go",
  ".jsx", ".tsx", ".yml", ".yaml", ".toml", ".sh", ".bash",
  ".sql", ".rb", ".php", ".swift", ".kt", ".scala", ".lua",
  ".r", ".m", ".h", ".hpp", ".cs", ".dart", ".vue", ".svelte",
]);

// Map extensions to language identifiers for code block formatting
const EXT_TO_LANG: Record<string, string> = {
  ".html": "html", ".css": "css", ".js": "javascript", ".jsx": "jsx",
  ".ts": "typescript", ".tsx": "tsx", ".json": "json", ".xml": "xml",
  ".md": "markdown", ".py": "python", ".java": "java", ".cpp": "cpp",
  ".c": "c", ".h": "c", ".hpp": "cpp", ".cs": "csharp",
  ".rs": "rust", ".go": "go", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".kt": "kotlin", ".scala": "scala", ".lua": "lua",
  ".sh": "bash", ".bash": "bash", ".sql": "sql", ".r": "r",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml", ".dart": "dart",
  ".vue": "vue", ".svelte": "svelte",
};

function getFileExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf(".");
  return dotIdx >= 0 ? filename.slice(dotIdx).toLowerCase() : "";
}

function isCodeFile(filename: string): boolean {
  const ext = getFileExtension(filename);
  return ext !== ".txt" && ext !== ".md" && TEXT_EXTENSIONS.has(ext);
}

function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PDF_PREVIEW_CHARS = 16_000;
const DEFAULT_PDF_PREVIEW_PAGES = 12;
const DEFAULT_PDF_MAX_PAGES = 600;
const PDF_NEAR_EMPTY_PAGE_CHARS = 24;

export function getConfiguredMaxFileSizeBytes(): number {
  return readBoundedInteger(
    process.env.SENTIQ_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_FILE_SIZE_BYTES,
    1024 * 1024,
    100 * 1024 * 1024,
  );
}

export function getConfiguredPdfPreviewChars(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_PREVIEW_CHARS,
    DEFAULT_PDF_PREVIEW_CHARS,
    2_000,
    50_000,
  );
}

export function getConfiguredPdfPreviewPages(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_PREVIEW_PAGES,
    DEFAULT_PDF_PREVIEW_PAGES,
    1,
    50,
  );
}

export function getConfiguredPdfMaxPages(): number {
  return readBoundedInteger(
    process.env.SENTIQ_PDF_MAX_PAGES,
    DEFAULT_PDF_MAX_PAGES,
    1,
    2_000,
  );
}

function isAuthenticatedIdentity(userId: string | undefined): userId is string {
  const normalized = userId?.trim().toLowerCase() ?? "";
  return Boolean(normalized) && normalized !== "guest" && !normalized.startsWith("guest-");
}

export function validateFileUpload(
  mimetype: string,
  size: number,
  filename: string,
): { valid: boolean; error?: string; type?: "pdf" | "txt" | "image" } {
  // Path traversal prevention
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { valid: false, error: "Invalid filename." };
  }

  const maxFileSize = getConfiguredMaxFileSizeBytes();
  if (size > maxFileSize) {
    return {
      valid: false,
      error: `File too large. Maximum ${Math.floor(maxFileSize / 1024 / 1024)}MB.`,
    };
  }

  const normalizedMimeType = normalizeMimeType(mimetype);
  let fileType = ALLOWED_TYPES[normalizedMimeType];
  const ext = getFileExtension(filename);

  // Fallback: browsers often send dropped files as octet-stream or with no MIME.
  if (!fileType) {
    if (TEXT_EXTENSIONS.has(ext)) {
      fileType = "txt";
    } else if (GENERIC_MIME_TYPES.has(normalizedMimeType)) {
      fileType = EXTENSION_TYPES[ext];
    }
  }

  if (!fileType) {
    return { valid: false, error: `Unsupported file type: ${mimetype}` };
  }

  return { valid: true, type: fileType };
}

export async function extractTextFromFile(args: {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly mimetype: string;
  readonly userId?: string;
}): Promise<FileExtractionResult> {
  const validation = validateFileUpload(args.mimetype, args.buffer.length, args.filename);
  if (!validation.valid || !validation.type) {
    throw new Error(validation.error || "Invalid file");
  }

  let extractedText = "";
  let pdfMetadata: Omit<FileExtractionResult, "filename" | "type" | "extracted_text" | "size_bytes"> = {};

  switch (validation.type) {
    case "txt": {
      const raw = args.buffer.toString("utf-8");
      if (isCodeFile(args.filename)) {
        const ext = getFileExtension(args.filename);
        const lang = EXT_TO_LANG[ext] || "code";
        extractedText = `\`\`\`${lang}\n${raw}\n\`\`\``;
        console.log(`[File Parser] code file: ${args.filename} (${lang}, ${raw.length} chars)`);
      } else {
        extractedText = raw;
        console.log(`[File Parser] text file: ${args.filename} (${raw.length} chars)`);
      }
      pdfMetadata = {
        visual_required: false,
        visual_analysis_status: "not_required",
      };
      break;
    }

    case "pdf":
      try {
        const result = await extractPdfPreview({
          buffer: args.buffer,
          filename: args.filename,
          userId: args.userId,
        });
        extractedText = result.previewText;
        const isVisual = result.ocrRequired;
        pdfMetadata = {
          page_count: result.declaredPageCount,
          indexed_page_count: result.pageCount,
          extraction_status: result.extractionStatus,
          ocr_required: result.ocrRequired,
          visual_required: isVisual,
          visual_analysis_status: isVisual ? "required" : "not_required",
          preview_truncated: result.previewTruncated,
          preview_character_count: result.previewText.length,
        };
        console.log(
          `[File Parser] PDF preview extracted: ${args.filename} ` +
          `(${result.previewText.length} chars, ${result.declaredPageCount} page(s), visualRequired=${isVisual})`,
        );
      } catch (err) {
        console.log(`[File Parser] PDF extraction failed: ${args.filename} — ${err instanceof Error ? err.message : err}`);
        extractedText = "[PDF text extraction failed. File stored for reference.]";
        pdfMetadata = {
          extraction_status: "failed",
          ocr_required: true,
          visual_required: true,
          visual_analysis_status: "required",
          preview_truncated: false,
          preview_character_count: extractedText.length,
        };
      }
      break;

    case "image":
      // Layer 1: Native images do not trigger eager vision analysis during upload.
      // They are stored as durable visual assets and analyzed on-demand via the image_input tool.
      extractedText = "";
      pdfMetadata = {
        visual_required: true,
        visual_analysis_status: "required",
      };
      console.log(`[File Parser] image registered for on-demand visual analysis: ${args.filename} (${args.buffer.length} bytes)`);
      break;
  }

  return {
    filename: args.filename,
    type: validation.type,
    extracted_text: extractedText,
    size_bytes: args.buffer.length,
    visual_required: false,
    visual_analysis_status: "not_required",
    ...pdfMetadata,
  };
}

// Reliable PDF text extraction using pdf-parse v2.
// The parser supports partial page extraction; canonical ingestion therefore
// reads one page at a time instead of materializing one unbounded string.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _PDFParseClass: any = null;
bootProfiler.mark("fileIngestion.pdfParser.init.begin");
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("pdf-parse");
  _PDFParseClass = mod.PDFParse ?? null;
  if (_PDFParseClass) {
    console.log("[File Parser] pdf-parse v2 PDFParse class loaded");
    if (typeof _PDFParseClass.setWorker === "function") {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const _path = require("path");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const _url = require("url");
      const workerFile = _path.resolve(
        _path.dirname(require.resolve("pdf-parse")),
        "pdf.worker.mjs",
      );
      const workerURL = _url.pathToFileURL(workerFile).href;
      _PDFParseClass.setWorker(workerURL);
      console.log("[File Parser] pdf.js worker configured:", workerURL);
    }
  }
} catch {
  console.warn("[File Parser] pdf-parse not available — PDF extraction disabled");
} finally {
  bootProfiler.mark("fileIngestion.pdfParser.init.done");
}

function cleanPdfPageText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\n--\s*\d+\s+of\s+\d+\s*--\s*$/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyExtractedPdfPage(
  pageNumber: number,
  text: string,
  error?: unknown,
): ExtractedPdfPage {
  if (error) {
    return {
      pageNumber,
      text: "",
      characterCount: 0,
      extractionStatus: "failed",
      errorType: error instanceof Error ? error.name : "unknown",
    };
  }
  const cleaned = cleanPdfPageText(text);
  return {
    pageNumber,
    text: cleaned,
    characterCount: cleaned.length,
    extractionStatus: cleaned.length >= PDF_NEAR_EMPTY_PAGE_CHARS ? "text" : "empty",
  };
}

function buildPdfPreview(args: {
  readonly pages: readonly ExtractedPdfPage[];
  readonly declaredPageCount: number;
  readonly pageCount: number;
  readonly pageLimitExceeded: boolean;
}): { previewText: string; previewTruncated: boolean; ocrRequired: boolean } {
  const maxChars = getConfiguredPdfPreviewChars();
  const textPages = args.pages.filter((page) => page.extractionStatus === "text");
  const failedPages = args.pages.filter((page) => page.extractionStatus === "failed");
  const previewParts: string[] = [];
  let usedCharacters = 0;
  let previewTruncated = false;

  for (const page of textPages) {
    const prefix = `[Page ${page.pageNumber}]\n`;
    const available = Math.max(0, maxChars - usedCharacters - prefix.length);
    if (available <= 0) {
      previewTruncated = true;
      break;
    }
    const pageText = page.text.length > available ? page.text.slice(0, available) : page.text;
    previewParts.push(`${prefix}${pageText}`);
    usedCharacters += prefix.length + pageText.length + 2;
    if (pageText.length < page.text.length) {
      previewTruncated = true;
      break;
    }
  }

  if (textPages.length > 0 && textPages.length < args.pageCount) previewTruncated = true;
  const sampledAllPages = args.pages.length >= args.pageCount;
  const ocrRequired = sampledAllPages && textPages.length === 0 && failedPages.length === 0;

  if (previewParts.length === 0) {
    if (ocrRequired) {
      previewParts.push(
        "[This PDF appears to be scanned or image-based. No selectable text was found. " +
        "OCR is required before its contents can be indexed.]",
      );
    } else if (failedPages.length > 0) {
      previewParts.push(
        "[PDF preview extraction failed for one or more pages. The server will preserve page-level failure status.]",
      );
    } else {
      previewParts.push(
        "[No selectable text was found in the previewed pages. Canonical indexing will inspect the remaining pages.]",
      );
    }
  }

  const notices: string[] = [];
  if (previewTruncated) notices.push("Only a bounded preview is shown here; the complete document is indexed server-side.");
  if (args.pageLimitExceeded) {
    notices.push(`This document has ${args.declaredPageCount} pages; indexing is capped at ${args.pageCount} pages.`);
  }
  if (notices.length > 0) previewParts.push(`[${notices.join(" ")}]`);

  return {
    previewText: previewParts.join("\n\n").trim(),
    previewTruncated,
    ocrRequired,
  };
}

async function extractPdfPreview(args: {
  readonly buffer: Buffer;
  readonly filename: string;
  readonly userId?: string;
}): Promise<PdfPreviewExtractionResult> {
  if (!_PDFParseClass) {
    console.warn("[PDF] PDFParse class not loaded — cannot extract text");
    return {
      previewText: "[Could not extract text from this PDF. The pdf-parse library failed to load.]",
      declaredPageCount: 0,
      pageCount: 0,
      extractionStatus: "failed",
      ocrRequired: false,
      previewTruncated: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parser: any = new _PDFParseClass({ data: args.buffer, verbosity: 0 });
  let parserOwnedByRegistry = false;
  try {
    const info = await parser.getInfo({ parsePageInfo: false });
    const declaredPageCount = Math.max(0, Math.floor(Number(info?.total) || 0));
    if (declaredPageCount <= 0) {
      throw new Error("PDF page count could not be determined");
    }

    const pageCount = Math.min(declaredPageCount, getConfiguredPdfMaxPages());
    const pageLimitExceeded = declaredPageCount > pageCount;
    const pageCache = new Map<number, Promise<ExtractedPdfPage>>();
    const readPage = (pageNumber: number): Promise<ExtractedPdfPage> => {
      const boundedPageNumber = Math.max(1, Math.min(pageCount, Math.floor(pageNumber)));
      const existing = pageCache.get(boundedPageNumber);
      if (existing) return existing;
      const extraction = (async () => {
        try {
          const result = await parser.getText({ partial: [boundedPageNumber] });
          return classifyExtractedPdfPage(boundedPageNumber, String(result?.text || ""));
        } catch (error) {
          console.warn(
            `[PDF] page extraction failed: ${args.filename} page=${boundedPageNumber} ` +
            `error=${error instanceof Error ? error.name : "unknown"}`,
          );
          return classifyExtractedPdfPage(boundedPageNumber, "", error);
        }
      })();
      pageCache.set(boundedPageNumber, extraction);
      return extraction;
    };

    const previewPageCount = Math.min(pageCount, getConfiguredPdfPreviewPages());
    const previewPages: ExtractedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= previewPageCount; pageNumber += 1) {
      previewPages.push(await readPage(pageNumber));
    }
    const preview = buildPdfPreview({
      pages: previewPages,
      declaredPageCount,
      pageCount,
      pageLimitExceeded,
    });

    if (isAuthenticatedIdentity(args.userId)) {
      const source: PendingPdfCanonicalSource = {
        ownerUserId: args.userId,
        filename: args.filename,
        sizeBytes: args.buffer.length,
        previewText: preview.previewText,
        contentHash: createHash("sha256").update(args.buffer).digest("hex"),
        declaredPageCount,
        pageCount,
        pageLimitExceeded,
        readPage,
        destroy: async () => {
          try {
            await parser.destroy();
          } catch {
            // Cleanup is best-effort and must not change the upload response.
          }
        },
      };
      registerPendingPdfCanonicalSource(source);
      parserOwnedByRegistry = true;
    }

    const sampledAllPages = previewPages.length >= pageCount;
    const textPageCount = previewPages.filter((page) => page.extractionStatus === "text").length;
    const failedPageCount = previewPages.filter((page) => page.extractionStatus === "failed").length;
    const extractionStatus: PdfPreviewExtractionResult["extractionStatus"] = pageLimitExceeded
      ? "partial"
      : sampledAllPages && textPageCount === 0 && failedPageCount === 0
        ? "ocr_required"
        : failedPageCount > 0
          ? "partial"
          : "text";

    console.log(
      `[PDF] preview pages=${previewPages.length}/${declaredPageCount} ` +
      `text_pages=${textPageCount} failed_pages=${failedPageCount} ` +
      `preview_chars=${preview.previewText.length}`,
    );

    return {
      previewText: preview.previewText,
      declaredPageCount,
      pageCount,
      extractionStatus,
      ocrRequired: extractionStatus === "ocr_required",
      previewTruncated: preview.previewTruncated,
    };
  } finally {
    if (!parserOwnedByRegistry) {
      try {
        await parser.destroy();
      } catch {
        // Cleanup is best-effort.
      }
    }
  }
}

/**
 * Analyze an image using Gemini Vision (multimodal).
 * Sends the image as base64 to the Python LLM gateway's /llm/vision endpoint.
 */
async function analyzeImageWithVision(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  userId?: string,
): Promise<string> {
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  if (buffer.length > MAX_IMAGE_SIZE) {
    return `[Image ${filename} is too large for vision analysis (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max: 10MB.]`;
  }
  if (!userId?.trim() || userId === "guest") {
    return `[Image: ${filename}, ${(buffer.length / 1024).toFixed(1)}KB. Attach this image to a chat message for direct analysis.]`;
  }

  const base64 = buffer.toString("base64");
  const prompt =
    "Analyze this image thoroughly. Provide:\n" +
    "1. A detailed description of what the image contains\n" +
    "2. Any text visible in the image (OCR)\n" +
    "3. Key details, data, or information shown\n" +
    `Filename: ${filename}`;

  try {
    await waitForInternalGatewayReady();
    const response = await fetch(getInternalGatewayUrl("/llm/vision"), {
      method: "POST",
      headers: getInternalGatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        prompt,
        image_base64: base64,
        mime_type: mimetype,
        user_id: userId,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Vision API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      result:
        | string
        | {
            text: string;
            model_used?: string;
            fallback?: boolean;
            fallback_reason?: string | null;
          };
    };
    const text = typeof data.result === "string" ? data.result : data.result.text;
    return `[Image Analysis of ${filename}]\n\n${text}`;
  } catch (err) {
    console.error(`[File Parser] Gemini Vision failed:`, err instanceof Error ? err.message : err);
    // Fallback: return basic metadata
    return `[Image: ${filename}, ${(buffer.length / 1024).toFixed(1)}KB. Vision analysis unavailable.]`;
  }
}

// Legacy export for compatibility
export async function describeImage(args: {
  readonly base64: string;
  readonly filename: string;
  readonly userId?: string;
}): Promise<string> {
  try {
    const buffer = Buffer.from(args.base64, "base64");
    return await analyzeImageWithVision(buffer, args.filename, "image/jpeg", args.userId);
  } catch {
    return `[Image: ${args.filename}]`;
  }
}
