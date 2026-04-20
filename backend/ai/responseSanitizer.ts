const DEFAULT_SAFE_REPLY_FALLBACK =
  "Sorry, I couldn't generate a proper response. Please try again.";

export interface SanitizeResponseOptions {
  readonly preserveFormatting?: boolean;
  readonly safeFallback?: string;
  readonly enforceFinalClean?: boolean;
}

const DROP_LINE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:internal|hidden|private)\s+(?:reasoning|analysis|notes?)\s*[:\-]?\s*$/i,
  /^\s*(?:chain[- ]of[- ]thought|cot|scratch(?: |-)?work)\s*[:\-]?/i,
  /^\s*(?:thinking|analysis|reasoning|plan|approach|progress update)\s*[:\-]/i,
  /^\s*(?:following the rules|per the instructions|based on the prompt|the prompt asks|the system prompt|the user asked me)\b/i,
  /^\s*(?:json parse failure|invalid json|unexpected token|internal server error|provider failed|modeloutputsanitizationerror)\b/i,
  /^\s*(?:here(?:'| i)s my (?:thinking|reasoning|analysis)|my chain(?: |-)?of(?: |-)?thought)\b/i,
];

const DROP_SENTENCE_PATTERNS: readonly RegExp[] = [
  /^(?:i(?:'| a)?m\s+(?:going to|gonna)\s|i will\b|i should\b|i need to\b|let me\b|let'?s\b|we need to\b|we should\b).*$/i,
  /^(?:following the rules|based on the prompt|the prompt asks|the system prompt|the hidden instructions)\b.*$/i,
  /^(?:first,?\s+)?(?:i(?:'| a)?ll|i will|let me|we need to)\s+(?:analyze|reason|think|check|solve|walk through)\b.*$/i,
  /^(?:analysis|reasoning|plan|approach|internal note|meta)\s*[:\-].*$/i,
  /^(?:alternatively|that means|we can\s+(?:iterate|try|analyze|reason|solve|check)|first,?\s+we|next,?\s+we|then,?\s+we)\b.*$/i,
];

const PROMPT_ECHO_PATTERNS: readonly RegExp[] = [
  /\b(?:return|respond)\s+only\s+(?:with|in)\b/i,
  /\b(?:no\s+markdown|no\s+json|valid json|final answer only)\b/i,
  /\b(?:do not reveal|do not leak|hidden scratchwork|chain[- ]of[- ]thought)\b/i,
  /\b(?:formatting rules?|bullet for final answer|one direct line)\b/i,
  /\bnow,?\s+write\s+the\s+output\b/i,
  /\bthen,?\s+(?:the\s+)?list\s+of\s+steps\b/i,
  /\bthe\s+reasoning\s+summary\s+should\b/i,
  /\bshort\s+reasoning\s+summary\b/i,
  /\bwe'?ll\s+put\s+that\s+inside\b/i,
  /\boutput\s+contract\b/i,
  /\bfinal answer\s+on\s+its\s+own\s+line\b/i,
  /\bdo not include\b[^.]*<think>/i,
];

const FINAL_REASONING_PHRASE_PATTERNS: readonly RegExp[] = [
  /^(?:that means|alternatively|we can\s+(?:iterate|try|analyze|reason|solve|check)|let(?:'|\s)?s iterate)\b.*$/i,
  /^(?:first|next|then),\s+we\b.*$/i,
];

const STEP_LINE_PATTERN = /^\s*(?:step\s*\d+[:.)-]?|\d+[.)-])\s+/i;
const FINAL_ANSWER_LINE_PATTERN = /^\s*(?:#{1,6}\s*)?final answer\s*:?\s*/i;

function looksLikeProviderFailurePayload(raw: string): boolean {
  if (!raw.startsWith("{") || !raw.endsWith("}")) {
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    if (
      typeof parsed.error === "string" &&
      parsed.error.toLowerCase() === "provider_failed"
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripStructuralPrefix(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function cleanLine(line: string, enforceFinalClean: boolean): string {
  const sentences = splitSentences(line);
  if (sentences.length <= 1) {
    const normalizedLine = stripStructuralPrefix(line);
    if (
      DROP_SENTENCE_PATTERNS.some((pattern) => pattern.test(normalizedLine)) ||
      PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(normalizedLine)) ||
      (enforceFinalClean && FINAL_REASONING_PHRASE_PATTERNS.some((pattern) => pattern.test(normalizedLine)))
    ) {
      return "";
    }
    return line.trim();
  }

  const kept = sentences.filter((sentence, index) => {
    const normalizedSentence = stripStructuralPrefix(sentence);

    if (DROP_SENTENCE_PATTERNS.some((pattern) => pattern.test(normalizedSentence))) {
      return false;
    }

    if (enforceFinalClean && FINAL_REASONING_PHRASE_PATTERNS.some((pattern) => pattern.test(normalizedSentence))) {
      return false;
    }

    if (PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(normalizedSentence)) && index < sentences.length - 1) {
      return false;
    }

    return true;
  });

  return kept.join(" ").trim();
}

function collapseBlankLines(lines: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] === "") {
        continue;
      }
      collapsed.push("");
      continue;
    }
    collapsed.push(line);
  }

  while (collapsed.length > 0 && collapsed[0] === "") {
    collapsed.shift();
  }
  while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") {
    collapsed.pop();
  }

  return collapsed;
}

function trimPromptEchoPreamble(lines: readonly string[], hasPromptEcho: boolean): string[] {
  if (!hasPromptEcho || lines.length === 0) {
    return Array.from(lines);
  }

  const startIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return STEP_LINE_PATTERN.test(trimmed) || FINAL_ANSWER_LINE_PATTERN.test(trimmed);
  });

  if (startIndex > 0) {
    return lines.slice(startIndex);
  }

  return Array.from(lines);
}

export function sanitizeResponse(
  response: string,
  options: SanitizeResponseOptions = {},
): string {
  const fallback = options.safeFallback ?? DEFAULT_SAFE_REPLY_FALLBACK;
  const enforceFinalClean = options.enforceFinalClean ?? true;
  const raw = (response ?? "").replace(/\r\n?/g, "\n").trim();

  if (!raw || looksLikeProviderFailurePayload(raw)) {
    return fallback;
  }

  const rawLines = raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""));

  const hasPromptEcho = PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(raw));
  const preparedLines = trimPromptEchoPreamble(rawLines, hasPromptEcho);

  const keptLines: string[] = [];
  let startedContent = false;

  for (const originalLine of preparedLines) {
    const trimmed = originalLine.trim();
    const normalizedLine = stripStructuralPrefix(trimmed);

    if (!trimmed) {
      if (startedContent) {
        keptLines.push("");
      }
      continue;
    }

    if (DROP_LINE_PATTERNS.some((pattern) => pattern.test(normalizedLine))) {
      continue;
    }

    if (PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(normalizedLine)) && !/[=+\-*/^]|\\frac|\\sqrt|\d/.test(normalizedLine)) {
      continue;
    }

    const cleanedLine = cleanLine(trimmed, enforceFinalClean)
      .replace(/^(?:final answer|answer)\s*:\s*/i, "")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();

    if (!cleanedLine) {
      continue;
    }

    keptLines.push(cleanedLine);
    startedContent = true;
  }

  const normalizedLines = collapseBlankLines(keptLines);
  if (normalizedLines.length === 0) {
    return fallback;
  }

  const cleaned = options.preserveFormatting
    ? normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim()
    : normalizedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const isBroken =
    !cleaned ||
    cleaned.length < 5 ||
    /(?:=|:)\s*$/.test(cleaned);

  if (isBroken) {
    return fallback;
  }

  return cleaned;
}
