import { sanitizeResponse } from "./responseSanitizer";

export const DEFAULT_SAFE_REPLY_FALLBACK =
  "Sorry, I couldn't generate a proper response. Please try again.";

const REPLY_KEYS = ["reply", "answer", "final_answer"] as const;
const THINKING_KEYS = ["thinking", "thoughts", "reasoning"] as const;

const THINK_OPEN_TAG = "<think";
const THINK_CLOSE_TAG = "</think>";

const FINAL_ANSWER_MARKER = /(?:^|\n)\s*(?:#{1,6}\s*)?Final Answer\s*:?\s*/i;

const REASONING_LIKE_PREFIX_PATTERNS: readonly RegExp[] = [
  /^(?:that means|alternatively|we can iterate|we can try|let(?:'|\s)?s|first,|next,|then,)\b/i,
  /^(?:analysis|reasoning|approach|plan|thinking)\b/i,
  /^(?:i(?:'|\s)?(?:am|will|should|need)|we(?:'|\s)?(?:re|are|should|need))\b/i,
];

export interface ExtractReplyOptions {
  readonly adapterError?: string | null;
}

export interface ExtractedReply {
  readonly reply: string | null;
  readonly thinking?: string;
  readonly explanation?: string;
  readonly finalAnswer?: string;
  readonly disclaimer?: string;
  readonly source: "json" | "fenced_json" | "plain_text" | "blocked";
  readonly blockedReason?: "adapter_error" | "provider_error_payload" | "missing_reply";
}

export interface FinalizeReplyOptions extends ExtractReplyOptions {
  readonly preserveFormatting?: boolean;
  readonly emptyFallback?: string;
  readonly preferExplanation?: boolean;
}

export interface FinalizedReply {
  readonly answer: string;
  readonly thinking?: string;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripThinkMarkers(value: string): string {
  return value.replace(/<\/?think[^>]*>/gi, "").trim();
}

function looksReasoningLikePrefix(value: string): boolean {
  const firstLine = value.split(/\n+/)[0]?.trim() ?? "";
  return REASONING_LIKE_PREFIX_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function splitThinkAndBody(raw: string): {
  thinking?: string;
  body: string;
  hadThink: boolean;
} {
  const source = raw ?? "";
  const lower = source.toLowerCase();
  const thinkingParts: string[] = [];
  let hadThink = false;
  let cursor = 0;
  let body = "";

  while (cursor < source.length) {
    const openIdx = lower.indexOf(THINK_OPEN_TAG, cursor);
    if (openIdx < 0) {
      body += source.slice(cursor);
      break;
    }

    hadThink = true;
    body += source.slice(cursor, openIdx);

    const openEndIdx = lower.indexOf(">", openIdx);
    if (openEndIdx < 0) {
      const malformedThinkTail = source.slice(openIdx + THINK_OPEN_TAG.length).trim();
      if (malformedThinkTail) {
        thinkingParts.push(malformedThinkTail);
      }
      cursor = source.length;
      break;
    }

    const closeIdx = lower.indexOf(THINK_CLOSE_TAG, openEndIdx + 1);
    if (closeIdx < 0) {
      const unterminatedThink = source.slice(openEndIdx + 1).trim();
      if (unterminatedThink) {
        const malformedFinalMatch = FINAL_ANSWER_MARKER.exec(unterminatedThink);
        if (malformedFinalMatch && malformedFinalMatch.index !== undefined) {
          const markerIndex = malformedFinalMatch.index;
          const markerEnd = markerIndex + malformedFinalMatch[0].length;
          const salvagedThinking = unterminatedThink.slice(0, markerIndex).trim();
          const salvagedAnswer = unterminatedThink.slice(markerEnd).trim();
          if (salvagedThinking) {
            thinkingParts.push(salvagedThinking);
          }
          if (salvagedAnswer) {
            body = [body, salvagedAnswer].filter(Boolean).join("\n\n");
          }
        } else {
          thinkingParts.push(unterminatedThink);
        }
      }
      cursor = source.length;
      break;
    }

    const thinkSegment = source.slice(openEndIdx + 1, closeIdx).trim();
    if (thinkSegment) {
      thinkingParts.push(thinkSegment);
    }

    cursor = closeIdx + THINK_CLOSE_TAG.length;
  }

  const thinking = thinkingParts
    .map(stripThinkMarkers)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return {
    thinking: thinking || undefined,
    body: body.trim(),
    hadThink,
  };
}

function extractFinalAnswerSection(raw: string): {
  answer?: string;
  markerFound: boolean;
} {
  const match = FINAL_ANSWER_MARKER.exec(raw);
  if (!match || match.index === undefined) {
    return { markerFound: false };
  }

  const markerStart = match.index;
  const markerLength = match[0].length;
  const answer = raw.slice(markerStart + markerLength).trim();

  return {
    markerFound: true,
    answer: answer || undefined,
  };
}

function extractThinkingFromParsedEnvelope(parsed: Record<string, unknown>): string | undefined {
  for (const key of THINKING_KEYS) {
    const normalized = normalizeOptionalText(parsed[key]);
    if (normalized) {
      return stripThinkMarkers(normalized);
    }
  }
  return undefined;
}

function unwrapFencedBlock(raw: string): { content: string; fenced: boolean } {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/^```[a-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/i);
  if (!fencedMatch) {
    return { content: trimmed, fenced: false };
  }
  return { content: fencedMatch[1].trim(), fenced: true };
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isProviderFailurePayload(value: unknown): boolean {
  const parsed =
    typeof value === "string"
      ? tryParseJsonObject(unwrapFencedBlock(value).content)
      : typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

  if (!parsed) {
    return false;
  }

  if (REPLY_KEYS.some((key) => typeof parsed[key] === "string" && String(parsed[key]).trim().length > 0)) {
    return false;
  }

  const errorValue = typeof parsed.error === "string" ? parsed.error.toLowerCase() : "";
  const statusValue = typeof parsed.status === "string" ? parsed.status.toLowerCase() : "";
  const detailValue = typeof parsed.detail === "string" ? parsed.detail.toLowerCase() : "";
  const reasonValue = typeof parsed.reason === "string" ? parsed.reason.toLowerCase() : "";

  if (errorValue === "provider_failed") {
    return true;
  }

  if (
    (errorValue.includes("error") || errorValue.includes("fail")) &&
    ("provider" in parsed || "detail" in parsed || "status" in parsed || "reason" in parsed)
  ) {
    return true;
  }

  if (statusValue.includes("error") || statusValue.includes("failed")) {
    return true;
  }

  if (detailValue.includes("provider") && detailValue.includes("fail")) {
    return true;
  }

  if (reasonValue.includes("provider") && reasonValue.includes("fail")) {
    return true;
  }

  return false;
}

export function extractUserFacingAnswer(
  raw: string | undefined,
  options: ExtractReplyOptions = {},
): ExtractedReply {
  if (options.adapterError) {
    return {
      reply: null,
      source: "blocked",
      blockedReason: "adapter_error",
    };
  }

  const text = (raw ?? "").trim();
  if (!text) {
    return {
      reply: null,
      source: "blocked",
      blockedReason: "missing_reply",
    };
  }

  if (isProviderFailurePayload(text)) {
    return {
      reply: null,
      source: "blocked",
      blockedReason: "provider_error_payload",
    };
  }

  const { content, fenced } = unwrapFencedBlock(text);
  const parsed = tryParseJsonObject(content);

  if (parsed) {
    if (isProviderFailurePayload(parsed)) {
      return {
        reply: null,
        source: "blocked",
        blockedReason: "provider_error_payload",
      };
    }

    const explanation = typeof parsed.explanation === "string" && parsed.explanation.trim()
      ? parsed.explanation.trim()
      : undefined;
    const finalAnswer = typeof parsed.final_answer === "string" && parsed.final_answer.trim()
      ? parsed.final_answer.trim()
      : undefined;
    const thinking = extractThinkingFromParsedEnvelope(parsed);

    if (explanation && finalAnswer) {
      return {
        reply: finalAnswer,
        thinking,
        explanation,
        finalAnswer,
        disclaimer: typeof parsed.disclaimer === "string" ? parsed.disclaimer : undefined,
        source: fenced ? "fenced_json" : "json",
      };
    }

    for (const key of REPLY_KEYS) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) {
        return {
          reply: parsed[key].trim(),
          thinking,
          disclaimer: typeof parsed.disclaimer === "string" ? parsed.disclaimer : undefined,
          source: fenced ? "fenced_json" : "json",
        };
      }
    }

    return {
      reply: null,
      thinking,
      disclaimer: typeof parsed.disclaimer === "string" ? parsed.disclaimer : undefined,
      source: fenced ? "fenced_json" : "json",
      blockedReason: "missing_reply",
    };
  }

  const split = splitThinkAndBody(content);
  const finalSection = extractFinalAnswerSection(split.body);

  if (finalSection.answer) {
    return {
      reply: finalSection.answer,
      thinking: split.thinking,
      source: "plain_text",
    };
  }

  if (!split.hadThink) {
    return {
      reply: split.body,
      source: "plain_text",
    };
  }

  if (split.body && !looksReasoningLikePrefix(split.body)) {
    return {
      reply: split.body,
      thinking: split.thinking,
      source: "plain_text",
    };
  }

  return {
    reply: null,
    thinking: split.thinking,
    source: "plain_text",
    blockedReason: "missing_reply",
  };
}

export function composeUserFacingReply(
  extracted: ExtractedReply,
  options: Pick<FinalizeReplyOptions, "preferExplanation"> = {},
): string | null {
  if (options.preferExplanation && extracted.explanation && extracted.finalAnswer) {
    return `${extracted.explanation}\n\nFinal Answer\n${extracted.finalAnswer}`;
  }

  return extracted.reply;
}

function sanitizeThinkingPayload(thinking?: string): string | undefined {
  if (!thinking) {
    return undefined;
  }
  const cleaned = stripThinkMarkers(thinking).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function finalizeStructuredReply(
  raw: string | undefined,
  options: FinalizeReplyOptions = {},
): FinalizedReply {
  const fallback = options.emptyFallback ?? DEFAULT_SAFE_REPLY_FALLBACK;
  const extracted = extractUserFacingAnswer(raw, { adapterError: options.adapterError });
  const composed = composeUserFacingReply(extracted, {
    preferExplanation: options.preferExplanation ?? false,
  });

  if (!composed) {
    return {
      answer: fallback,
      thinking: sanitizeThinkingPayload(extracted.thinking),
    };
  }

  return {
    answer: sanitizeResponse(composed, {
      preserveFormatting: options.preserveFormatting ?? false,
      safeFallback: fallback,
      enforceFinalClean: true,
    }),
    thinking: sanitizeThinkingPayload(extracted.thinking),
  };
}

export function finalizeUserFacingReply(
  raw: string | undefined,
  options: FinalizeReplyOptions = {},
): string {
  return finalizeStructuredReply(raw, options).answer;
}
