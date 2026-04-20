import {
  buildChatPrompt,
  callLLMAdapterDetailed,
  getDemoFallbackResponse,
} from "./PromptBuilders";
import type { ChatContext } from "./PromptBuilders";
import { extractUserFacingAnswer, finalizeStructuredReply } from "./replyGuard";

const REASONING_MAX_OUTPUT_TOKENS = 2600;
const CONTINUATION_MAX_OUTPUT_TOKENS = 1800;

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
    "Continue the Final Answer only.",
    "Do not repeat any earlier text. Do not include a <think> block or the words 'Final Answer'.",
    "",
    "Original question:",
    userMessage,
    "",
    "Final Answer so far:",
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
}

export async function handleChat(args: {
  readonly userMessage: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string }[];
  readonly fileReferences?: readonly { filename: string; extractedText: string }[];
  readonly conversationSummary?: string;
  readonly modelOverride?: string;
  readonly userId?: string;
  readonly reasoningMode?: boolean;
}): Promise<ChatResponse> {
  if (!args.userMessage.trim()) {
    throw new Error("userMessage must be a non-empty string.");
  }

  const ctx: ChatContext = {
    userMessage: args.userMessage,
    recentMessages: args.recentMessages,
    memories: args.memories,
    fileReferences: args.fileReferences,
    conversationSummary: args.conversationSummary,
    modelOverride: args.modelOverride,
    userId: args.userId,
    reasoningMode: args.reasoningMode,
  };

  const baseCall = buildChatPrompt(ctx);
  const call = args.reasoningMode
    ? { ...baseCall, max_output_tokens: REASONING_MAX_OUTPUT_TOKENS }
    : baseCall;

  console.log(
    `[ChatHandler] invoke model=${call.model_override ?? "default"} reasoning=${args.reasoningMode ? "true" : "false"} max_output_tokens=${call.max_output_tokens ?? "none"}`,
  );

  let raw: string;
  let model_used: string | undefined;
  let fallback = false;
  let truncated = false;
  let adapterError: string | null | undefined;
  let finishReason: string | null | undefined;

  try {
    const result = await callLLMAdapterDetailed(call);
    raw = result.text;
    model_used = result.model_used;
    fallback = result.fallback ?? false;
    truncated = result.truncated ?? false;
    adapterError = result.error;
    finishReason = result.finish_reason;
  } catch {
    raw = getDemoFallbackResponse("chat");
  }

  if (finishReason || truncated) {
    console.log(
      `[ChatHandler] result finish_reason=${finishReason ?? "none"} truncated=${truncated ? "true" : "false"} chars=${raw.length}`,
    );
  }

  let disclaimer = "SentIQGPT is an AI assistant. Verify important information independently.";
  const extracted = extractUserFacingAnswer(raw, { adapterError });
  if (typeof extracted.disclaimer === "string" && extracted.disclaimer.trim()) {
    disclaimer = extracted.disclaimer;
  }

  const finalized = finalizeStructuredReply(raw, {
    adapterError,
    truncated: args.reasoningMode ? false : truncated,
  });

  let finalAnswer = finalized.answer;
  let finalThinking = finalized.thinking;

  const shouldAttemptContinuation = truncated && finalAnswer.trim().length >= 20;
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
        conversationSummary: undefined,
        modelOverride: args.modelOverride,
        userId: args.userId,
        reasoningMode: args.reasoningMode,
      });
      const continuationCall = args.reasoningMode
        ? { ...continuationBaseCall, max_output_tokens: CONTINUATION_MAX_OUTPUT_TOKENS }
        : continuationBaseCall;
      const continuationResult = await callLLMAdapterDetailed(continuationCall);
      if (continuationResult.finish_reason || continuationResult.truncated) {
        console.log(
          `[ChatHandler] continuation finish_reason=${continuationResult.finish_reason ?? "none"} truncated=${continuationResult.truncated ? "true" : "false"}`,
        );
      }
      const continuationFinal = finalizeStructuredReply(continuationResult.text, {
        adapterError: continuationResult.error,
        truncated: continuationResult.truncated ?? false,
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

  return {
    answer: finalAnswer,
    reply: finalAnswer,
    thinking: finalThinking,
    disclaimer,
    model_used,
    fallback,
  };
}
