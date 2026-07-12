import {
  buildChatPrompt,
  callLLMAdapterDetailed,
  getDemoFallbackResponse,
} from "./PromptBuilders";
import type { ChatContext, ImageAttachment } from "./PromptBuilders";
import type { RouteEvidenceItem } from "../orchestrator/contextComposer";
import { extractUserFacingAnswer, finalizeStructuredReply } from "./replyGuard";
import { PRODUCT_DISCLAIMER } from "../branding";
import type { WebSurfAnswerPlan, WebSurfAnswerSourceContext } from "../tools/webSearch/webSurfAnswerIntelligence";
import { normalizeWebSurfAnswerOutput } from "../tools/webSearch/webSurfOutputGuard";

const REASONING_MAX_OUTPUT_TOKENS = 2600;
const CONTINUATION_MAX_OUTPUT_TOKENS = 1800;
const RAW_REASONING_FALLBACK =
  "I couldn't complete that response. Please retry in a moment.";
const GENERIC_CHAT_FALLBACK_PATTERN =
  /\bcurrently unable to process your request\b|\bplease try again shortly\b/i;

function buildMemoryBackedFallbackAnswer(args: {
  readonly userMessage: string;
  readonly memories?: readonly { type: string; summary: string; importance?: number; relevance?: number }[];
}): string | null {
  if (!/\b(?:what(?:'s| is)\s+my\s+name|who\s+am\s+i|do\s+you\s+remember\s+my\s+name)\b/i.test(args.userMessage)) {
    return null;
  }
  const identityMemory = (args.memories ?? []).find((memory) =>
    memory.type === "identity" && /\b(?:user'?s|my)\s+name\s+is\b/i.test(memory.summary),
  );
  const nameMatch = identityMemory?.summary.match(/\bname\s+is\s+([^.!?\n,;]+)/i);
  const name = nameMatch?.[1]?.trim();
  return name ? `Your name is ${name}.` : null;
}

function mergeContinuation(base: string, continuation: string): string {
  const left = base.trimEnd();
  const right = continuation.trim();
  if (!right) return left;

  const maxOverlap = Math.min(300, left.length, right.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 20; size -= 1) {
    if (left.endsWith(right.slice(0, size))) {
      overlap = size;
      break;
    }
  }

  const glue = left.endsWith("\n") || right.startsWith("\n") ? "" : "\n";
  return `${left}${glue}${right.slice(overlap)}`.trim();
}

function buildContinuationMessage(userMessage: string, answerSoFar: string): string {
  return [
    "Continue the answer only.",
    "Do not repeat any earlier text. Do not include chain-of-thought or a <think> block.",
    "",
    "Original question:",
    userMessage,
    "",
    "Answer so far:",
    answerSoFar,
  ].join("\n");
}

export interface ChatResponse {
  readonly answer: string;
  readonly reply: string;
  readonly thinking?: string;
  readonly disclaimer: string;
  readonly model_used?: string;
  readonly fallback?: boolean;
  readonly sanitize_bypass?: boolean;
}

export async function handleChat(args: {
  readonly userMessage: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string }[];
  readonly fileReferences?: readonly { filename: string; extractedText: string }[];
  readonly imageAttachments?: readonly ImageAttachment[];
  readonly conversationSummary?: string;
  readonly conversationCapsule?: string;
  readonly workspaceCapsule?: string;
  readonly priorConversationEvidence?: readonly { content: string; createdAt?: string }[];
  readonly routeEvidence?: readonly RouteEvidenceItem[];
  readonly isExplicitRecallQuery?: boolean;
  readonly trustedProfile?: { displayName: string };
  readonly modelOverride?: string;
  readonly userId?: string;
  readonly reasoningMode?: boolean;
  readonly reasoningEffort?: "low" | "medium";
  readonly webSurfSourceIds?: readonly string[];
  readonly webSurfAnswerPlan?: WebSurfAnswerPlan;
  readonly webSurfAnswerSources?: readonly WebSurfAnswerSourceContext[];
  readonly signal?: AbortSignal;
}): Promise<ChatResponse> {
  if (!args.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string.");
  }

  const ctx: ChatContext = {
    userMessage: args.userMessage,
    recentMessages: args.recentMessages,
    memories: args.memories,
    fileReferences: args.fileReferences,
    imageAttachments: args.imageAttachments,
    conversationSummary: args.conversationSummary,
    conversationCapsule: args.conversationCapsule,
    workspaceCapsule: args.workspaceCapsule,
    priorConversationEvidence: args.priorConversationEvidence,
    routeEvidence: args.routeEvidence,
    isExplicitRecallQuery: args.isExplicitRecallQuery,
    trustedProfile: args.trustedProfile,
    modelOverride: args.modelOverride,
    userId: args.userId,
    reasoningMode: args.reasoningMode,
    reasoningEffort: args.reasoningEffort,
    webSurfSourceIds: args.webSurfSourceIds,
    webSurfAnswerPlan: args.webSurfAnswerPlan,
    webSurfAnswerSources: args.webSurfAnswerSources,
  };

  const baseCall = buildChatPrompt(ctx);
  const call = args.reasoningMode
    ? { ...baseCall, max_output_tokens: REASONING_MAX_OUTPUT_TOKENS, skip_wrappers: true }
    : baseCall;

  console.log(
    `[ChatHandler] invoke model=${call.model_override ?? "default"} reasoning=${args.reasoningMode ? "true" : "false"} max_output_tokens=${call.max_output_tokens ?? "none"}`,
  );
  const bypassSanitization = args.modelOverride === "openai-large";

  let raw: string;
  let model_used: string | undefined;
  let fallback = false;
  let truncated = false;
  let adapterError: string | null | undefined;
  let finishReason: string | null | undefined;

  try {
    const result = await callLLMAdapterDetailed({ ...call, signal: args.signal });
    raw = result.text;
    model_used = result.model_used;
    fallback = result.fallback ?? false;
    truncated = result.truncated ?? false;
    adapterError = result.error;
    finishReason = result.finish_reason;
  } catch {
    raw = args.reasoningMode ? RAW_REASONING_FALLBACK : getDemoFallbackResponse("chat");
  }

  if (finishReason || truncated) {
    console.log(
      `[ChatHandler] result finish_reason=${finishReason ?? "none"} truncated=${truncated ? "true" : "false"} chars=${raw.length}`,
    );
  }

  if (args.reasoningMode) {
    const finalAnswer = raw.trim() || RAW_REASONING_FALLBACK;
    return {
      answer: finalAnswer,
      reply: finalAnswer,
      thinking: undefined,
      disclaimer: PRODUCT_DISCLAIMER,
      model_used,
      fallback,
      sanitize_bypass: bypassSanitization,
    };
  }

  let disclaimer = PRODUCT_DISCLAIMER;
  if (!bypassSanitization) {
    const extracted = extractUserFacingAnswer(raw, { adapterError });
    if (typeof extracted.disclaimer === "string" && extracted.disclaimer.trim()) {
      disclaimer = extracted.disclaimer;
    }
  }

  const finalized = finalizeStructuredReply(raw, {
    adapterError,
    truncated: args.reasoningMode ? false : truncated,
    sanitizeMode: bypassSanitization ? "none" : args.reasoningMode ? "minimal" : "strict",
  });

  let finalAnswer = finalized.answer;
  let finalThinking = finalized.thinking;
  if (args.reasoningMode) {
    finalThinking = undefined;
  }

  // Pass B has a deliberately bounded single-synthesis contract. Ordinary chat
  // retains its existing continuation behavior when the feature is not active.
  const shouldAttemptContinuation = !args.webSurfAnswerPlan && truncated && finalAnswer.trim().length >= 20;
  if (shouldAttemptContinuation) {
    try {
      console.log(
        `[ChatHandler] continuation triggered reasoning=${args.reasoningMode ? "true" : "false"} chars=${finalAnswer.length}`,
      );
      const continuationBaseCall = buildChatPrompt({
        userMessage: buildContinuationMessage(args.userMessage, finalAnswer),
        recentMessages: [],
        memories: [],
        fileReferences: undefined,
        imageAttachments: undefined,
        conversationSummary: undefined,
        modelOverride: args.modelOverride,
        userId: args.userId,
        reasoningMode: args.reasoningMode,
      });
      const continuationCall = args.reasoningMode
        ? { ...continuationBaseCall, max_output_tokens: CONTINUATION_MAX_OUTPUT_TOKENS, skip_wrappers: true }
        : continuationBaseCall;
      const continuationResult = await callLLMAdapterDetailed({ ...continuationCall, signal: args.signal });
      if (continuationResult.finish_reason || continuationResult.truncated) {
        console.log(
          `[ChatHandler] continuation finish_reason=${continuationResult.finish_reason ?? "none"} truncated=${continuationResult.truncated ? "true" : "false"}`,
        );
      }
      const continuationFinal = finalizeStructuredReply(continuationResult.text, {
        adapterError: continuationResult.error,
        truncated: continuationResult.truncated ?? false,
        sanitizeMode: bypassSanitization ? "none" : args.reasoningMode ? "minimal" : "strict",
      });
      const merged = mergeContinuation(finalAnswer, continuationFinal.answer);
      if (merged && merged !== finalAnswer) {
        finalAnswer = merged;
      } else {
        finalThinking = undefined;
      }
    } catch {
      finalThinking = undefined;
    }
  }

  if (GENERIC_CHAT_FALLBACK_PATTERN.test(finalAnswer)) {
    const memoryBackedAnswer = buildMemoryBackedFallbackAnswer({
      userMessage: args.userMessage,
      memories: args.memories,
    });
    if (memoryBackedAnswer) {
      finalAnswer = memoryBackedAnswer;
      finalThinking = undefined;
      fallback = true;
    }
  }

  if (args.webSurfAnswerPlan && args.webSurfSourceIds?.length) {
    finalAnswer = normalizeWebSurfAnswerOutput(finalAnswer, new Set(args.webSurfSourceIds));
  }

  return {
    answer: finalAnswer,
    reply: finalAnswer,
    thinking: finalThinking,
    disclaimer,
    model_used,
    fallback,
    sanitize_bypass: bypassSanitization,
  };
}
