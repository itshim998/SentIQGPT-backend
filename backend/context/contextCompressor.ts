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

/** Skip compression for conversations shorter than this (optimization) */
const SKIP_COMPRESSION_THRESHOLD = 10;

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
 *
 * OPTIMIZATION: Skips LLM compression for short conversations (<10 messages)
 * to avoid unnecessary latency. Compression is only valuable for long
 * conversations where token savings outweigh the LLM call overhead.
 */
export async function compressConversation(
  messages: readonly { role: string; content: string }[],
  userId?: string,
): Promise<CompressedConversation> {
  // Short conversations — no compression needed
  if (messages.length <= CONVERSATION_WINDOW) {
    return { recentMessages: [...messages] };
  }

  const recentMessages = messages.slice(-CONVERSATION_WINDOW);
  const olderMessages = messages.slice(0, -CONVERSATION_WINDOW);

  // OPTIMIZATION: Skip LLM compression for moderately short conversations
  // The latency cost of the Groq call (~1-2s) outweighs the benefit
  // for conversations with only a few messages outside the window.
  if (messages.length < SKIP_COMPRESSION_THRESHOLD || olderMessages.length < SUMMARY_THRESHOLD) {
    console.log(`[COMPRESSOR] skipping LLM compression (${messages.length} messages < ${SKIP_COMPRESSION_THRESHOLD} threshold)`);
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
    user_id: userId,
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
