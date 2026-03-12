import { callLLMAdapter, strictParseJsonObject, getDemoFallbackResponse } from "./PromptBuilders";
import type { LLMAdapterCall } from "./PromptBuilders";

// SentIQGPT v1 — File Ingestion Handler
//
// Processes uploaded files (PDF, TXT, images) and extracts usable content.
// Returns structured metadata + extracted text for client-side IndexedDB storage.

export interface FileExtractionResult {
  readonly filename: string;
  readonly type: "pdf" | "txt" | "image";
  readonly extracted_text: string;
  readonly size_bytes: number;
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
};

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

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export function validateFileUpload(
  mimetype: string,
  size: number,
  filename: string,
): { valid: boolean; error?: string; type?: "pdf" | "txt" | "image" } {
  // Path traversal prevention
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return { valid: false, error: "Invalid filename." };
  }

  if (size > MAX_FILE_SIZE) {
    return { valid: false, error: `File too large. Maximum ${MAX_FILE_SIZE / 1024 / 1024}MB.` };
  }

  let fileType = ALLOWED_TYPES[mimetype];

  // Fallback: check extension for code files sent as octet-stream
  if (!fileType) {
    const ext = filename.lastIndexOf(".") >= 0 ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
    if (TEXT_EXTENSIONS.has(ext)) {
      fileType = "txt";
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
}): Promise<FileExtractionResult> {
  const validation = validateFileUpload(args.mimetype, args.buffer.length, args.filename);
  if (!validation.valid || !validation.type) {
    throw new Error(validation.error || "Invalid file");
  }

  let extractedText = "";

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
      break;
    }

    case "pdf":
      try {
        extractedText = await extractPdfText(args.buffer);
        console.log(`[File Parser] PDF extracted: ${args.filename} (${extractedText.length} chars)`);
      } catch (err) {
        console.log(`[File Parser] PDF extraction failed: ${args.filename} — ${err instanceof Error ? err.message : err}`);
        extractedText = "[PDF text extraction failed. File stored for reference.]";
      }
      break;

    case "image":
      try {
        extractedText = await analyzeImageWithVision(args.buffer, args.filename, args.mimetype);
        console.log(`[File Parser] image analyzed: ${args.filename} (${extractedText.length} chars)`);
      } catch (err) {
        console.log(`[File Parser] image analysis failed: ${args.filename} — ${err instanceof Error ? err.message : err}`);
        extractedText = `[Image file: ${args.filename}. Vision analysis was unavailable. The image was uploaded but could not be described.]`;
      }
      break;
  }

  return {
    filename: args.filename,
    type: validation.type,
    extracted_text: extractedText,
    size_bytes: args.buffer.length,
  };
}

// Reliable PDF text extraction using pdf-parse v2
// v2 exports a PDFParse class (not a function like v1).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _PDFParseClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("pdf-parse");
  _PDFParseClass = mod.PDFParse ?? null;
  if (_PDFParseClass) {
    console.log("[File Parser] pdf-parse v2 PDFParse class loaded");
    // Disable worker for Node.js server-side usage
    if (typeof _PDFParseClass.setWorker === "function") {
      _PDFParseClass.setWorker("");
    }
  }
} catch {
  console.warn("[File Parser] pdf-parse not available — PDF extraction disabled");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const MAX_PDF_CHARS = 50_000;

  if (!_PDFParseClass) {
    console.warn("[PDF] PDFParse class not loaded — cannot extract text");
    return "[Could not extract text from this PDF. The pdf-parse library failed to load.]";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parser: any = null;
  try {
    parser = new _PDFParseClass({ data: buffer, verbosity: 0 });
    const result = await parser.getText();
    const raw: string = result?.text || "";
    const pageCount: number = result?.total || 0;

    console.log(`[PDF] extracted ${raw.length} chars from ${pageCount} page(s)`);

    const cleaned = raw
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    console.log(`[PDF] cleaned text length: ${cleaned.length} chars`);

    if (cleaned.length > 0) {
      if (cleaned.length > MAX_PDF_CHARS) {
        console.log(`[PDF] text truncated: ${cleaned.length} → ${MAX_PDF_CHARS} chars`);
        return cleaned.slice(0, MAX_PDF_CHARS) + "\n\n[... PDF content truncated to fit context window ...]";
      }
      console.log(`[PDF] context length sent to LLM: ${cleaned.length} chars`);
      return cleaned;
    }

    console.warn("[PDF] extraction returned no text — PDF may be scanned/image-based");
  } catch (err) {
    console.error("[PDF] extraction error:", err instanceof Error ? err.message : err);
  } finally {
    if (parser) {
      try { await parser.destroy(); } catch { /* cleanup best-effort */ }
    }
  }

  return "[Could not extract text from this PDF. The file may be scanned, image-based, or encrypted. " +
         "If the PDF contains selectable text, please try re-uploading. " +
         "Scanned/image-based PDFs are not yet supported for text extraction.]";
}

/**
 * Analyze an image using Gemini Vision (multimodal).
 * Sends the image as base64 to the Python LLM gateway's /llm/vision endpoint.
 */
const LLM_SERVICE_URL = process.env.LLM_SERVICE_URL || `http://localhost:${process.env.LLM_SERVICE_PORT || "3002"}`;

async function analyzeImageWithVision(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<string> {
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
  if (buffer.length > MAX_IMAGE_SIZE) {
    return `[Image ${filename} is too large for vision analysis (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Max: 10MB.]`;
  }

  const base64 = buffer.toString("base64");
  const prompt =
    "Analyze this image thoroughly. Provide:\n" +
    "1. A detailed description of what the image contains\n" +
    "2. Any text visible in the image (OCR)\n" +
    "3. Key details, data, or information shown\n" +
    `Filename: ${filename}`;

  try {
    const response = await fetch(`${LLM_SERVICE_URL}/llm/vision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        image_base64: base64,
        mime_type: mimetype,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Vision API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { result: string };
    return `[Image Analysis of ${filename}]\n\n${data.result}`;
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
}): Promise<string> {
  try {
    const buffer = Buffer.from(args.base64, "base64");
    return await analyzeImageWithVision(buffer, args.filename, "image/jpeg");
  } catch {
    return `[Image: ${args.filename}]`;
  }
}
