import { sanitizeResponse } from "./responseSanitizer";

export const DEFAULT_SAFE_REPLY_FALLBACK =
  "Sorry, I couldn't generate a proper response. Please try again.";

const REPLY_KEYS = ["reply", "answer", "final_answer"] as const;

export interface ExtractReplyOptions {
  readonly adapterError?: string | null;
}

export interface ExtractedReply {
  readonly reply: string | null;
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

    if (explanation && finalAnswer) {
      return {
        reply: finalAnswer,
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
          disclaimer: typeof parsed.disclaimer === "string" ? parsed.disclaimer : undefined,
          source: fenced ? "fenced_json" : "json",
        };
      }
    }

    return {
      reply: null,
      disclaimer: typeof parsed.disclaimer === "string" ? parsed.disclaimer : undefined,
      source: fenced ? "fenced_json" : "json",
      blockedReason: "missing_reply",
    };
  }

  return {
    reply: content,
    source: "plain_text",
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

export function finalizeUserFacingReply(
  raw: string | undefined,
  options: FinalizeReplyOptions = {},
): string {
  const fallback = options.emptyFallback ?? DEFAULT_SAFE_REPLY_FALLBACK;
  const extracted = extractUserFacingAnswer(raw, { adapterError: options.adapterError });
  const composed = composeUserFacingReply(extracted, {
    preferExplanation: options.preferExplanation ?? false,
  });

  if (!composed) {
    return fallback;
  }

  return sanitizeResponse(composed, {
    preserveFormatting: options.preserveFormatting ?? false,
    safeFallback: fallback,
  });
}
