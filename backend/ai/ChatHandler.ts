import {
  buildChatPrompt,
  callLLMAdapterDetailed,
  getDemoFallbackResponse,
} from "./PromptBuilders";
import type { ChatContext } from "./PromptBuilders";
import { extractUserFacingAnswer, finalizeStructuredReply } from "./replyGuard";

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
  };

  const call = buildChatPrompt(ctx);

  let raw: string;
  let model_used: string | undefined;
  let fallback = false;
  let truncated = false;
  let adapterError: string | null | undefined;

  try {
    const result = await callLLMAdapterDetailed(call);
    raw = result.text;
    model_used = result.model_used;
    fallback = result.fallback ?? false;
    truncated = result.truncated ?? false;
    adapterError = result.error;
  } catch {
    raw = getDemoFallbackResponse("chat");
  }

  let disclaimer = "SentIQGPT is an AI assistant. Verify important information independently.";
  const extracted = extractUserFacingAnswer(raw, { adapterError });
  if (typeof extracted.disclaimer === "string" && extracted.disclaimer.trim()) {
    disclaimer = extracted.disclaimer;
  }

  const finalized = finalizeStructuredReply(raw, {
    adapterError,
    truncated,
  });

  return {
    answer: finalized.answer,
    reply: finalized.answer,
    thinking: finalized.thinking,
    disclaimer,
    model_used,
    fallback,
  };
}
