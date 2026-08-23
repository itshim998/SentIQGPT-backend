import type { ChatGenerationEvent } from "./chatGenerationTaskCoordinator";

function rowsFromResult(result: any): any[] {
  return Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
}

export async function appendChatGenerationEventFenced(
  userDb: any,
  args: {
    userId: string;
    generationId: string;
    leaseId: string;
    event: ChatGenerationEvent;
    partialText: string;
    tokensGenerated: number;
    status: string;
    errorCode?: string | null;
  },
) {
  const result = await userDb.rpc("append_chat_generation_event_fenced", {
    p_user_id: args.userId,
    p_generation_id: args.generationId,
    p_lease_id: args.leaseId,
    p_sequence: Math.max(1, Math.floor(Number(args.event.sequence))),
    p_event_type: String(args.event.type),
    p_event_payload: args.event,
    p_partial_text: args.partialText,
    p_tokens_generated: Math.max(0, Math.floor(args.tokensGenerated)),
    p_status: args.status,
    p_error_code: args.errorCode ?? null,
  });
  const row = rowsFromResult(result)[0] ?? null;
  return { data: row, error: result?.error ?? null };
}

export async function listChatGenerationEvents(
  userDb: any,
  args: { userId: string; generationId: string; afterSequence?: number; limit?: number },
): Promise<{ data: any[]; error: any }> {
  const result = await userDb
    .from("chat_generation_events")
    .select("generation_id, sequence, event_type, event_payload, created_at")
    .eq("user_id", args.userId)
    .eq("generation_id", args.generationId)
    .gt("sequence", Math.max(0, Math.floor(Number(args.afterSequence ?? 0))))
    .order("sequence", { ascending: true })
    .limit(Math.min(2000, Math.max(1, Math.floor(Number(args.limit ?? 500)))));

  return { data: rowsFromResult(result), error: result?.error ?? null };
}

export function normalizeStoredGenerationEvent(row: any): ChatGenerationEvent | null {
  if (!row || typeof row !== "object" || !row.event_payload || typeof row.event_payload !== "object") return null;
  const event = row.event_payload as Record<string, unknown>;
  return {
    ...event,
    generation_id: String(event.generation_id ?? row.generation_id),
    sequence: Number(event.sequence ?? row.sequence),
    type: String(event.type ?? row.event_type),
  } as ChatGenerationEvent;
}
