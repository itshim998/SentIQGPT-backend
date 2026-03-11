import {
  buildChatPrompt,
  callLLMAdapter,
  getDemoFallbackResponse,
  strictParseJsonObject,
} from "./PromptBuilders";
import type { ChatContext } from "./PromptBuilders";

// SentIQGPT v1 — Chat Handler
//
// Orchestrates the main conversation pipeline:
// 1. Build context window (messages + memories + files)
// 2. Route to Gemini via PromptBuilders
// 3. Parse and return response

export interface ChatResponse {
  readonly reply: string;
  readonly disclaimer: string;
}

export async function handleChat(args: {
  readonly userMessage: string;
  readonly recentMessages?: readonly { role: string; content: string }[];
  readonly memories?: readonly { type: string; summary: string }[];
  readonly fileReferences?: readonly { filename: string; extractedText: string }[];
  readonly conversationSummary?: string;
  readonly modelOverride?: string;
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
  };

  const call = buildChatPrompt(ctx);

  let raw: string;
  try {
    raw = await callLLMAdapter(call);
  } catch {
    raw = getDemoFallbackResponse("chat");
  }

  // Chat responses may be plain text (not JSON) — handle both
  let reply: string;
  let disclaimer = "SentIQGPT is an AI assistant. Verify important information independently.";

  try {
    const parsed = strictParseJsonObject(raw);
    reply = typeof parsed.reply === "string" ? parsed.reply : raw;
    if (typeof parsed.disclaimer === "string") {
      disclaimer = parsed.disclaimer;
    }
  } catch {
    // Response was plain text — use directly
    reply = raw;
  }

  return { reply, disclaimer };
}
