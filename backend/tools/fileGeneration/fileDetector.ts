import type { GeneratedFileFormat } from "./types";

const FORMAT_PATTERNS: ReadonlyArray<[GeneratedFileFormat, RegExp]> = [
  ["xlsx", /\b(?:\.xlsx|xlsx|excel\s+(?:file|sheet|workbook|spreadsheet)|spreadsheet)\b/i],
  ["pptx", /\b(?:\.pptx|pptx|powerpoint|presentation|slide\s*deck|slides?)\b/i],
  ["docx", /\b(?:\.docx|docx|word\s+(?:file|document)|ms\s*word)\b/i],
  ["pdf", /\b(?:\.pdf|pdf)\b/i],
  ["html", /\b(?:\.html|html\s+(?:file|page|document)|web\s*page|webpage)\b/i],
  ["txt", /\b(?:\.txt|txt|plain\s+text\s+file|text\s+file)\b/i],
];

const GENERATION_VERBS =
  /\b(?:generate|create|make|build|write|prepare|draft|produce|export|turn\s+.*\s+into|convert\s+.*\s+to)\b/i;

const DOWNLOADABLE_HINTS =
  /\b(?:downloadable|file|document|workbook|spreadsheet|presentation|slides?|deck|pdf|docx|pptx|xlsx|html|txt)\b/i;

export function detectGeneratedFileFormat(message: string): GeneratedFileFormat | null {
  const normalized = String(message || "").trim();
  if (!normalized) return null;

  for (const [format, pattern] of FORMAT_PATTERNS) {
    if (pattern.test(normalized)) return format;
  }

  return null;
}

export function isFileGenerationRequest(message: string): boolean {
  const normalized = String(message || "").trim();
  if (!normalized) return false;

  const format = detectGeneratedFileFormat(normalized);
  if (!format) return false;

  if (GENERATION_VERBS.test(normalized) && DOWNLOADABLE_HINTS.test(normalized)) {
    return true;
  }

  return /\b(?:as|in|to)\s+(?:a\s+)?(?:pdf|docx|pptx|xlsx|html|txt|spreadsheet|presentation|word\s+document)\b/i
    .test(normalized);
}

export function getFileGenerationGuestInstruction(message: string): string {
  if (/Guest mode cannot create/i.test(message)) return message;
  const format = detectGeneratedFileFormat(message);
  if (format === "xlsx") {
    return [
      message,
      "",
      "Guest mode cannot create downloadable files. Provide the spreadsheet content as a clear Markdown table in chat only.",
    ].join("\n");
  }

  return [
    message,
    "",
    "Guest mode cannot create, store, preview, or download native files. Provide the requested content directly in chat only.",
  ].join("\n");
}
