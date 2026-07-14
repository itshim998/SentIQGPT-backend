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

export function resolveFileGenerationIntent(message: string): FileGenerationIntent {
  const normalized = String(message || "").trim();
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
