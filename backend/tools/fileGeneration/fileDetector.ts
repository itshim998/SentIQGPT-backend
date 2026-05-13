import type { GeneratedFileFormat } from "./types";

export type FileGenerationIntentStrength = "none" | "exact" | "implied";

export interface FileGenerationIntent {
  readonly strength: FileGenerationIntentStrength;
  readonly format: GeneratedFileFormat | null;
  readonly reason?: string;
}

const EXACT_FORMAT_PATTERNS: ReadonlyArray<[GeneratedFileFormat, RegExp]> = [
  ["xlsx", /(?:^|[\s(["'])\.?xlsx\b/i],
  ["pptx", /(?:^|[\s(["'])\.?pptx\b/i],
  ["docx", /(?:^|[\s(["'])\.?docx\b/i],
  ["pdf", /(?:^|[\s(["'])\.?pdf\b/i],
  ["html", /(?:^|[\s(["'])\.html\b/i],
  ["txt", /(?:^|[\s(["'])\.txt\b/i],
];

const IMPLIED_FORMAT_PATTERNS: ReadonlyArray<[GeneratedFileFormat, RegExp, string]> = [
  ["xlsx", /\b(?:excel\s+(?:file|sheet|workbook|spreadsheet)|spreadsheet|workbook)\b/i, "spreadsheet_alias"],
  ["pptx", /\b(?:ppt|powerpoint|presentation|slide\s*deck|deck|slides?)\b/i, "presentation_alias"],
  ["docx", /\b(?:word\s+(?:file|document|doc)|ms\s*word)\b/i, "word_alias"],
  ["pdf", /\b(?:pdf\s+(?:file|document)|printable\s+pdf)\b/i, "pdf_alias"],
  ["html", /\b(?:html\s+(?:file|page|document)|web\s*page|webpage)\b/i, "html_alias"],
  ["txt", /\b(?:plain\s+text\s+file|text\s+file)\b/i, "text_alias"],
];

const GENERATION_VERBS =
  /\b(?:generate|create|make|build|write|prepare|draft|produce|export|turn\s+.*\s+into|convert\s+.*\s+to)\b/i;

const DOWNLOADABLE_HINTS =
  /\b(?:downloadable|file|document|workbook|spreadsheet|presentation|slides?|deck|pdf|docx|pptx|xlsx|html|txt)\b/i;

function hasGenerationIntent(message: string): boolean {
  return GENERATION_VERBS.test(message) && DOWNLOADABLE_HINTS.test(message);
}

function hasAsFormatIntent(message: string): boolean {
  return /\b(?:as|to)\s+(?:a\s+)?(?:pdf|docx|pptx|xlsx|html|txt|spreadsheet|presentation|word\s+document)\b/i
    .test(message);
}

function stripClarificationOptionCatalog(message: string): string {
  return message.replace(/\nAvailable options:\n[^\n]*(?:\n|$)/i, "\n");
}

export function resolveFileGenerationIntent(message: string): FileGenerationIntent {
  const normalized = stripClarificationOptionCatalog(String(message || "")).trim();
  if (!normalized) return { strength: "none", format: null };

  for (const [format, pattern] of EXACT_FORMAT_PATTERNS) {
    if (pattern.test(normalized)) {
      return { strength: "exact", format, reason: "explicit_format" };
    }
  }

  for (const [format, pattern, reason] of IMPLIED_FORMAT_PATTERNS) {
    if (pattern.test(normalized)) {
      return { strength: "implied", format, reason };
    }
  }

  return { strength: "none", format: null };
}

export function detectGeneratedFileFormat(message: string): GeneratedFileFormat | null {
  return resolveFileGenerationIntent(message).format;
}

export function isFileGenerationRequest(message: string): boolean {
  const normalized = String(message || "").trim();
  if (!normalized) return false;

  const intent = resolveFileGenerationIntent(normalized);
  if (!intent.format) return false;

  if (intent.strength === "exact" && (hasGenerationIntent(normalized) || hasAsFormatIntent(normalized))) {
    return true;
  }

  return false;
}

export function isImpliedFileGenerationRequest(message: string): boolean {
  const normalized = String(message || "").trim();
  const intent = resolveFileGenerationIntent(normalized);
  return intent.strength === "implied" && Boolean(intent.format) && (hasGenerationIntent(normalized) || hasAsFormatIntent(normalized));
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
