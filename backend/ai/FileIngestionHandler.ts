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
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
};

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

  const fileType = ALLOWED_TYPES[mimetype];
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
    case "txt":
      extractedText = args.buffer.toString("utf-8");
      break;

    case "pdf":
      // PDF text extraction — attempt basic extraction
      // In production, use pdf-parse or pdfjs-dist
      try {
        extractedText = await extractPdfText(args.buffer);
      } catch {
        extractedText = "[PDF text extraction failed. File stored for reference.]";
      }
      break;

    case "image":
      // Images don't have text — store metadata
      extractedText = `[Image file: ${args.filename}, ${args.buffer.length} bytes]`;
      break;
  }

  return {
    filename: args.filename,
    type: validation.type,
    extracted_text: extractedText,
    size_bytes: args.buffer.length,
  };
}

// Basic PDF text extraction (best-effort without heavy dependencies)
async function extractPdfText(buffer: Buffer): Promise<string> {
  // Try to find readable text in the PDF buffer
  // This is a lightweight fallback — for production, install pdf-parse
  try {
    const pdfParse = await import("pdf-parse");
    const parseFn = (pdfParse as any).default || pdfParse;
    if (typeof parseFn === "function") {
      const data = await parseFn(buffer);
      return data.text || "";
    }
  } catch {
    // pdf-parse not installed — fall back to regex extraction
  }

  // Fallback: extract readable ASCII strings from the PDF
  const text = buffer.toString("latin1");
  const matches = text.match(/\(([^()]{2,})\)/g);
  if (matches) {
    return matches
      .map((m) => m.slice(1, -1))
      .filter((s) => /[a-zA-Z]/.test(s))
      .join(" ")
      .slice(0, 10000);
  }

  return "[Could not extract text from PDF]";
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
