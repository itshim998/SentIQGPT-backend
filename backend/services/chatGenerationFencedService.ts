import type { ChatGenerationStatus, ChatGenerationRow } from "./chatGenerationService";

function rowFromResult(result: any): ChatGenerationRow | null {
  const row = Array.isArray(result?.data) ? result.data[0] : result?.data;
  return row && typeof row === "object" ? row as ChatGenerationRow : null;
}

export async function checkpointChatGenerationFenced(
  userDb: any,
  args: {
    userId: string;
    generationId: string;
    leaseId: string;
    partialText: string;
    tokensGenerated: number;
    lastEventSequence: number;
    status?: ChatGenerationStatus;
  },
) {
  const result = await userDb.rpc("checkpoint_chat_generation_fenced", {
    p_user_id: args.userId,
    p_generation_id: args.generationId,
    p_lease_id: args.leaseId,
    p_partial_text: args.partialText,
    p_tokens_generated: Math.max(0, Math.floor(args.tokensGenerated)),
    p_last_event_sequence: Math.max(0, Math.floor(args.lastEventSequence)),
    p_status: args.status ?? null,
  });
  return { data: rowFromResult(result), error: result?.error ?? null };
}

export async function finalizeChatGenerationFenced(
  userDb: any,
  args: {
    userId: string;
    generationId: string;
    leaseId: string;
    status: Extract<ChatGenerationStatus, "completed" | "failed" | "cancelled">;
    errorCode?: string | null;
    partialText: string;
    tokensGenerated: number;
    lastEventSequence: number;
  },
) {
  const result = await userDb.rpc("finalize_chat_generation_fenced", {
    p_user_id: args.userId,
    p_generation_id: args.generationId,
    p_lease_id: args.leaseId,
    p_status: args.status,
    p_error_code: args.errorCode ?? null,
    p_partial_text: args.partialText,
    p_tokens_generated: Math.max(0, Math.floor(args.tokensGenerated)),
    p_last_event_sequence: Math.max(0, Math.floor(args.lastEventSequence)),
  });
  return { data: rowFromResult(result), error: result?.error ?? null };
}
