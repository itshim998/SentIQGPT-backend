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
      extractedText = `[Image file: ${args.filename}, ${args.buffer.length} bytes]`;
      console.log(`[File Parser] image file: ${args.filename} (${args.buffer.length} bytes)`);
      break;
  }

  return {
    filename: args.filename,
    type: validation.type,
    extracted_text: extractedText,
    size_bytes: args.buffer.length,
  };
}

// Reliable PDF text extraction using pdf-parse
let _pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("pdf-parse");
  _pdfParse = typeof mod === "function" ? mod : (mod.default ?? null);
  if (_pdfParse) console.log("[File Parser] pdf-parse loaded successfully");
} catch {
  console.warn("[File Parser] pdf-parse not available — PDF extraction will use fallback");
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Primary: use pdf-parse
  if (_pdfParse) {
    try {
      const data = await _pdfParse(buffer);
      const raw = data.text || "";

      // Quality check: pdf-parse can return empty or garbage for scanned PDFs
      const cleaned = raw
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (cleaned.length < 20) {
        console.warn(`[File Parser] PDF text too short (${cleaned.length} chars) — may be scanned/image-based`);
        return "[This PDF appears to be scanned or image-based. Text extraction returned minimal content. " +
               "The user should be informed that the file could not be fully read.]\n\n" +
               (cleaned || "(no text extracted)");
      }

      // Truncate very large PDFs to avoid context overflow
      const MAX_PDF_CHARS = 50_000;
      if (cleaned.length > MAX_PDF_CHARS) {
        console.log(`[File Parser] PDF text truncated: ${cleaned.length} → ${MAX_PDF_CHARS} chars`);
        return cleaned.slice(0, MAX_PDF_CHARS) + "\n\n[... PDF content truncated to fit context window ...]";
      }

      return cleaned;
    } catch (err) {
      console.error(`[File Parser] pdf-parse error:`, err instanceof Error ? err.message : err);
      // Fall through to fallback
    }
  }

  // Fallback: extract readable ASCII strings from the PDF binary
  const text = buffer.toString("latin1");
  const matches = text.match(/\(([^()]{2,})\)/g);
  if (matches) {
    const extracted = matches
      .map((m) => m.slice(1, -1))
      .filter((s) => /[a-zA-Z]/.test(s))
      .join(" ")
      .slice(0, 10000);
    if (extracted.length > 50) return extracted;
  }

  return "[Could not extract text from this PDF. The file may be scanned, image-based, or encrypted.]";
}

// Use LLM to describe an image (if multimodal support available)
export async function describeImage(args: {
  readonly base64: string;
  readonly filename: string;
}): Promise<string> {
  const call: LLMAdapterCall = {
    task: "file_extract",
    prompt:
      "TASK: Describe the contents of this image briefly.\n" +
      `Filename: ${args.filename}\n` +
      "Provide a 1-2 sentence description.",
    prefer: "gemini",
  };

  try {
    const raw = await callLLMAdapter(call);
    return raw;
  } catch {
    return `[Image: ${args.filename}]`;
  }
}
