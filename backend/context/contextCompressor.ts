// SentIQGPT v2 — Context Compressor
//
// Compresses conversation history before it reaches the reasoning model:
//
//   1. Conversation Window  — keep only the last N messages (default 6)
//   2. Older Message Summary — summarize everything before the window
//      via Groq (memory_compress task → fast, cheap)
//
// This dramatically reduces token usage on long conversations while
// preserving essential context through the summary.

import { callLLMAdapter } from "../ai/PromptBuilders";
import type { LLMAdapterCall } from "../ai/PromptBuilders";

// ==============================
// Configuration
// ==============================

/** Number of recent messages kept verbatim in the prompt. */
export const CONVERSATION_WINDOW = 6;

/** Minimum older-message count before triggering summarization. */
const SUMMARY_THRESHOLD = 2;

// ==============================
// Types
// ==============================

export interface CompressedConversation {
  readonly recentMessages: readonly { role: string; content: string }[];
  readonly summary?: string;
}

// ==============================
// Public API
// ==============================

/**
 * Compress a conversation history into a recent-message window plus
 * an optional Groq-generated summary of older messages.
 */
export async function compressConversation(
  messages: readonly { role: string; content: string }[],
): Promise<CompressedConversation> {
  // Short conversations — no compression needed
  if (messages.length <= CONVERSATION_WINDOW) {
    return { recentMessages: [...messages] };
  }

  const recentMessages = messages.slice(-CONVERSATION_WINDOW);
  const olderMessages = messages.slice(0, -CONVERSATION_WINDOW);

  // Not enough older messages to justify a summarization call
  if (olderMessages.length < SUMMARY_THRESHOLD) {
    return { recentMessages };
  }

  // Build a compact transcript of older messages
  const transcript = olderMessages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n")
    .slice(0, 2000); // hard cap to keep the summarization prompt small

  const call: LLMAdapterCall = {
    task: "memory_compress",
    prefer: "groq",
    prompt:
      "Summarize the following conversation excerpt in 1-2 concise sentences. " +
      "Capture the key topics discussed and any important decisions or facts.\n\n" +
      `${transcript}\n\nSummary:`,
  };

  try {
    const raw = await callLLMAdapter(call);
    const summary = raw.trim();
    return { recentMessages, summary: summary || undefined };
  } catch {
    // Summarization failure is non-fatal — just skip the summary
    return { recentMessages };
  }
}
