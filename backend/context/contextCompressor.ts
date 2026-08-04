// SentIQ Chat v2 — Context Compressor
//
// Compresses conversation history before it reaches the reasoning model:
//
//   1. Candidate window — submit up to the latest 20 messages verbatim
//   2. Older-message summary — summarize everything before the candidate window
//      via Groq (memory_compress task → fast, cheap)
//
// The query-aware Context Composer decides which candidate turns fit. The
// compressor no longer pre-reduces every request to six messages.

import { callLLMAdapter } from "../ai/PromptBuilders";
import type { LLMAdapterCall } from "../ai/PromptBuilders";
import { trimTextToTokenBudget } from "../orchestrator/contextBudgetManager";

// ==============================
// Configuration
// ==============================

/** Maximum recent-message candidate set submitted to token-aware composition. */
export const CONVERSATION_WINDOW = 20;

/** Minimum older-message count before triggering summarization. */
const SUMMARY_THRESHOLD = 2;

/** Skip compression when only a very small prefix lies outside the candidate window. */
const SKIP_COMPRESSION_THRESHOLD = 24;

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
 * Compress a conversation history into a recent-message candidate window plus
 * an optional Groq-generated summary of older messages.
 *
 * Short conversations avoid an auxiliary model call. Longer conversations
 * retain up to 20 verbatim candidates so query-aware composition can preserve
 * complete recent exchanges instead of receiving a fixed six-message slice.
 */
export async function compressConversation(
  messages: readonly { role: string; content: string }[],
  userId?: string,
): Promise<CompressedConversation> {
  if (messages.length <= CONVERSATION_WINDOW) {
    return { recentMessages: [...messages] };
  }

  const recentMessages = messages.slice(-CONVERSATION_WINDOW);
  const olderMessages = messages.slice(0, -CONVERSATION_WINDOW);

  if (messages.length < SKIP_COMPRESSION_THRESHOLD || olderMessages.length < SUMMARY_THRESHOLD) {
    console.log(`[COMPRESSOR] skipping LLM compression (${messages.length} messages < ${SKIP_COMPRESSION_THRESHOLD} threshold)`);
    return { recentMessages };
  }

  const transcript = olderMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");
  const budgetedTranscript = trimTextToTokenBudget(transcript, 600, "head_tail");

  const call: LLMAdapterCall = {
    task: "memory_compress",
    prefer: "groq",
    prompt:
      "Summarize the following conversation excerpt in 1-2 concise sentences. " +
      "Capture the key topics discussed and any important decisions or facts.\n\n" +
      `${budgetedTranscript}\n\nSummary:`,
    user_id: userId,
  };

  try {
    const raw = await callLLMAdapter(call);
    const summary = raw.trim();
    return { recentMessages, summary: summary || undefined };
  } catch {
    return { recentMessages };
  }
}
