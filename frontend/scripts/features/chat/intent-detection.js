import {
  CHART_ACTION_PATTERNS,
  CHART_DATA_CONTEXT_PATTERNS,
  CHART_REQUEST_PATTERNS,
  CODING_BUILD_GUARD_PATTERNS,
} from "./constants.js";

/** Keyword-based detection of image generation requests. */
export function isImageRequest(text) {
  if (isChartRequest(text)) return false;
  if (isLikelyFileGenerationRequest(text)) return false;
  const patterns = [
    /\b(generate|create|make|draw|paint|render|design|sketch|produce)\b.*\b(image|picture|photo|art|illustration|artwork|portrait|landscape|wallpaper|icon|logo|poster|banner)\b/i,
    /\b(image|picture|photo|art|illustration|artwork)\b.*\b(of|for|with|showing|depicting|featuring)\b/i,
    /\bgenerate\s+(an?\s+)?image\b/i,
    /\bcreate\s+(an?\s+)?image\b/i,
    /\bdraw\s+(me\s+)?(an?\s+)?(image|picture|art|portrait|landscape|sketch|cartoon|character|scene|logo|icon)\b/i,
    /\bpaint\s+(me\s+)?(an?\s+)?(image|picture|art|portrait|landscape|scene|mural)\b/i,
    /\billustrate\b/i,
    /\bshow\s+me\s+(an?\s+)?(image|picture|photo)\b/i,
    /\bimage\s+of\b/i,
    /\bpicture\s+of\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function looksLikeCodingBuildRequest(text) {
  const normalized = text || "";
  const hits = CODING_BUILD_GUARD_PATTERNS.filter((pattern) => pattern.test(normalized)).length;
  return hits >= 2;
}

export function isChartRequest(text) {
  const normalized = text || "";
  if (!normalized.trim()) return false;
  if (isLikelyFileGenerationRequest(normalized)) return false;
  if (looksLikeCodingBuildRequest(normalized)) return false;
  return CHART_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))
    || CHART_ACTION_PATTERNS.some((pattern) => pattern.test(normalized))
    || CHART_DATA_CONTEXT_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function detectRequestedFileFormat(text) {
  const normalized = String(text || "");
  const checks = [
    ["xlsx", /(?:^|[\s(["'])\.?xlsx\b/i],
    ["pptx", /(?:^|[\s(["'])\.?pptx\b/i],
    ["docx", /(?:^|[\s(["'])\.?docx\b/i],
    ["pdf", /(?:^|[\s(["'])\.?pdf\b/i],
    ["html", /(?:^|[\s(["'])\.html\b/i],
    ["txt", /(?:^|[\s(["'])\.txt\b/i],
  ];
  const match = checks.find(([, pattern]) => pattern.test(normalized));
  return match ? match[0] : null;
}

export function isLikelyFileGenerationRequest(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  const format = detectRequestedFileFormat(normalized);
  if (!format) return false;
  const hasVerb = /\b(?:generate|create|make|build|write|prepare|draft|produce|export|turn\s+.*\s+into|convert\s+.*\s+to)\b/i.test(normalized);
  const hasFileHint = /\b(?:downloadable|file|document|workbook|spreadsheet|presentation|slides?|deck|pdf|docx|pptx|xlsx|html|txt)\b/i.test(normalized);
  return (hasVerb && hasFileHint)
    || /\b(?:as|to)\s+(?:a\s+)?(?:pdf|docx|pptx|xlsx|html|txt|spreadsheet|presentation|word\s+document)\b/i.test(normalized);
}

export function detectClarificationDownloadFormat(clarificationResponse) {
  if (!clarificationResponse || typeof clarificationResponse !== "object") return null;
  const selectedOptionId = String(clarificationResponse.selected_option_id || clarificationResponse.selectedOptionId || "").trim().toLowerCase();
  const optionIdMatch = selectedOptionId.match(/^download_(html|txt|xlsx|pptx|docx|pdf)$/i);
  if (optionIdMatch) return optionIdMatch[1].toLowerCase();

  const visibleAnswer = String(clarificationResponse.answer || clarificationResponse.label || "").trim();
  const answers = Array.isArray(clarificationResponse.answers) ? clarificationResponse.answers : [];
  const latestAnswer = answers.length ? String(answers[answers.length - 1] || "") : "";
  const haystack = `${visibleAnswer}\n${latestAnswer}`;
  if (!/\bdownloadable\b/i.test(haystack)) return null;
  return detectRequestedFileFormat(haystack);
}

export function buildGuestFileGenerationInstruction(message, format) {
  if (/Guest mode cannot create/i.test(String(message || ""))) return message;
  const suffix = format === "xlsx"
    ? "Guest mode cannot create downloadable files. Provide the spreadsheet content as a clear Markdown table in chat only."
    : "Guest mode cannot create, store, preview, or download native files. Provide the requested content directly in chat only.";
  return `${message}\n\n${suffix}`;
}

export function isLikelyMathReasoningPrompt(text) {
  void text;
  return false;
}

export function isLikelyLogicReasoningPrompt(text) {
  void text;
  return false;
}

export function isLikelyBufferedReasoningPrompt(text) {
  return isLikelyMathReasoningPrompt(text) || isLikelyLogicReasoningPrompt(text);
}

export function detectLoaderKindForPrompt(text, options = {}) {
  if (options.forceImage) return "loader-image";
  if (options.file || isLikelyFileGenerationRequest(text)) return "loader-generic";
  if (options.structured || isChartRequest(text)) return "loader-chart";
  if (isImageRequest(text)) return "loader-image";
  if (options.reasoning || isLikelyBufferedReasoningPrompt(text)) return "loader-generic";
  return "loader-text";
}
