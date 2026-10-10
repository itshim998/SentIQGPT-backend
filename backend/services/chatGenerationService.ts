export const CHAT_GENERATION_STATUSES = [
  "queued", "running", "completed", "failed", "recoverable", "cancel_requested", "cancelled",
  "waiting_for_tool", "generating", "persisting",
] as const;

export type ChatGenerationStatus = typeof CHAT_GENERATION_STATUSES[number];
export type ChatGenerationExecutionMode = "fast" | "intuitive";
export const MAX_ACTIVE_GENERATIONS_PER_USER = 3;

export type ChatGenerationRow = {
  id: string;
  conversation_id: string;
  user_id: string;
  client_request_id: string | null;
  generation_session_id: string | null;
  status: ChatGenerationStatus;
  execution_mode: ChatGenerationExecutionMode | null;
  model_route: string | null;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  error_code: string | null;
  partial_text: string;
  tokens_generated: number;
  last_event_sequence: number;
  created_at: string;
  updated_at: string;
  execution_snapshot?: Record<string, unknown>;
  execution_lease_id: string | null;
  execution_lease_expires_at: string | null;
  recovery_attempts: number;
  last_execution_error: string | null;
};

export type CreateChatGenerationInput = {
  conversationId: string;
  userId: string;
  clientRequestId?: string | null;
  generationId?: string | null;
  generationSessionId?: string | null;
  executionMode?: ChatGenerationExecutionMode | null;
  modelRoute?: string | null;
  executionSnapshot?: Record<string, unknown> | null;
};

export type ChatGenerationCheckpoint = {
  partialText?: string;
  tokensGenerated?: number;
  lastEventSequence?: number;
  status?: ChatGenerationStatus;
};

const CHAT_GENERATION_COLUMNS = [
  "id", "conversation_id", "user_id", "client_request_id", "generation_session_id",
  "status", "execution_mode", "model_route", "started_at", "completed_at", "failed_at",
  "cancelled_at", "error_code", "partial_text", "tokens_generated", "last_event_sequence",
  "created_at", "updated_at", "execution_snapshot", "execution_lease_id",
  "execution_lease_expires_at", "recovery_attempts", "last_execution_error",
].join(", ");

function normalizeRequired(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
function normalizeOptional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}
function normalizeStatus(value: unknown): ChatGenerationStatus {
  return typeof value === "string" && (CHAT_GENERATION_STATUSES as readonly string[]).includes(value)
    ? value as ChatGenerationStatus : "queued";
}
function normalizeRow(row: any): ChatGenerationRow {
  return {
    id: String(row.id), conversation_id: String(row.conversation_id), user_id: String(row.user_id),
    client_request_id: row.client_request_id ?? null, generation_session_id: row.generation_session_id ?? null,
    status: normalizeStatus(row.status),
    execution_mode: row.execution_mode === "intuitive" ? "intuitive" : row.execution_mode === "fast" ? "fast" : null,
    model_route: row.model_route ?? null, started_at: row.started_at ?? null, completed_at: row.completed_at ?? null,
    failed_at: row.failed_at ?? null, cancelled_at: row.cancelled_at ?? null, error_code: row.error_code ?? null,
    partial_text: typeof row.partial_text === "string" ? row.partial_text : "",
    tokens_generated: Number.isFinite(Number(row.tokens_generated)) ? Number(row.tokens_generated) : 0,
    last_event_sequence: Number.isFinite(Number(row.last_event_sequence)) ? Number(row.last_event_sequence) : 0,
    created_at: String(row.created_at), updated_at: String(row.updated_at),
    execution_snapshot: row.execution_snapshot && typeof row.execution_snapshot === "object" ? row.execution_snapshot : {},
    execution_lease_id: row.execution_lease_id ?? null,
    execution_lease_expires_at: row.execution_lease_expires_at ?? null,
    recovery_attempts: Number.isFinite(Number(row.recovery_attempts)) ? Number(row.recovery_attempts) : 0,
    last_execution_error: row.last_execution_error ?? null,
  };
}

export async function getChatGenerationById(userDb: any, userId: string, generationId: string) {
  const result = await userDb.from("chat_generations").select(CHAT_GENERATION_COLUMNS)
    .eq("id", normalizeRequired(generationId, "generationId")).eq("user_id", normalizeRequired(userId, "userId")).maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}

export async function getChatGenerationByClientRequestId(userDb: any, userId: string, clientRequestId: string) {
  const result = await userDb.from("chat_generations").select(CHAT_GENERATION_COLUMNS)
    .eq("user_id", normalizeRequired(userId, "userId")).eq("client_request_id", normalizeRequired(clientRequestId, "clientRequestId")).maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}

export async function createChatGeneration(userDb: any, input: CreateChatGenerationInput) {
  const conversationId = normalizeRequired(input.conversationId, "conversationId");
  const userId = normalizeRequired(input.userId, "userId");
  const clientRequestId = normalizeOptional(input.clientRequestId);
  const generationId = normalizeOptional(input.generationId);
  if (clientRequestId) {
    const existing = await getChatGenerationByClientRequestId(userDb, userId, clientRequestId);
    if (existing.error) return { data: null, error: existing.error, duplicate: false };
    if (existing.data) return { data: existing.data, error: null, duplicate: true };
  }
  const payload = {
    ...(generationId ? { id: generationId } : {}), conversation_id: conversationId, user_id: userId,
    client_request_id: clientRequestId, generation_session_id: normalizeOptional(input.generationSessionId),
    status: "queued", execution_mode: input.executionMode ?? null, model_route: normalizeOptional(input.modelRoute),
    partial_text: "", tokens_generated: 0, last_event_sequence: 0,
    ...(input.executionSnapshot ? { execution_snapshot: input.executionSnapshot } : {}),
  };
  const result = await userDb.from("chat_generations").insert(payload).select(CHAT_GENERATION_COLUMNS).single();
  if (result.error?.code === "23505" && clientRequestId) {
    const duplicate = await getChatGenerationByClientRequestId(userDb, userId, clientRequestId);
    return { data: duplicate.data, error: duplicate.error, duplicate: true };
  }
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error, duplicate: false };
}

export async function updateChatGenerationExecutionSnapshot(userDb: any, args: { userId: string; generationId: string; executionSnapshot: Record<string, unknown> }) {
  const result = await userDb.from("chat_generations").update({ execution_snapshot: args.executionSnapshot })
    .eq("id", normalizeRequired(args.generationId, "generationId"))
    .eq("user_id", normalizeRequired(args.userId, "userId"))
    .select(CHAT_GENERATION_COLUMNS)
    .maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}

export async function checkpointChatGeneration(userDb: any, args: { userId: string; generationId: string; checkpoint: ChatGenerationCheckpoint }) {
  const patch: Record<string, unknown> = {};
  if (typeof args.checkpoint.partialText === "string") patch.partial_text = args.checkpoint.partialText;
  if (Number.isFinite(args.checkpoint.tokensGenerated)) patch.tokens_generated = Math.max(0, Math.floor(args.checkpoint.tokensGenerated!));
  if (Number.isFinite(args.checkpoint.lastEventSequence)) patch.last_event_sequence = Math.max(0, Math.floor(args.checkpoint.lastEventSequence!));
  if (args.checkpoint.status) patch.status = args.checkpoint.status;
  if (!Object.keys(patch).length) return getChatGenerationById(userDb, args.userId, args.generationId);
  const result = await userDb.from("chat_generations").update(patch)
    .eq("id", normalizeRequired(args.generationId, "generationId")).eq("user_id", normalizeRequired(args.userId, "userId"))
    .select(CHAT_GENERATION_COLUMNS).maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}

export async function claimChatGenerationExecution(userDb: any, args: { userId: string; generationId: string; leaseId: string; leaseSeconds?: number; maxActiveGenerations?: number }) {
  const result = await userDb.rpc("claim_chat_generation_execution", {
    p_user_id: normalizeRequired(args.userId, "userId"),
    p_generation_id: normalizeRequired(args.generationId, "generationId"),
    p_lease_id: normalizeRequired(args.leaseId, "leaseId"),
    p_lease_seconds: Number.isFinite(args.leaseSeconds) ? Math.max(15, Math.floor(args.leaseSeconds!)) : 60,
    p_max_active_generations: Number.isFinite(args.maxActiveGenerations)
      ? Math.max(1, Math.floor(args.maxActiveGenerations!))
      : MAX_ACTIVE_GENERATIONS_PER_USER,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export async function renewChatGenerationExecutionLease(userDb: any, args: { userId: string; generationId: string; leaseId: string; leaseSeconds?: number }) {
  const result = await userDb.rpc("renew_chat_generation_execution_lease", {
    p_user_id: normalizeRequired(args.userId, "userId"), p_generation_id: normalizeRequired(args.generationId, "generationId"), p_lease_id: normalizeRequired(args.leaseId, "leaseId"),
    p_lease_seconds: Number.isFinite(args.leaseSeconds) ? Math.max(15, Math.floor(args.leaseSeconds!)) : 60,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}
export async function releaseChatGenerationExecutionLease(userDb: any, args: { userId: string; generationId: string; leaseId: string }) {
  const result = await userDb.rpc("release_chat_generation_execution_lease", { p_user_id: normalizeRequired(args.userId, "userId"), p_generation_id: normalizeRequired(args.generationId, "generationId"), p_lease_id: normalizeRequired(args.leaseId, "leaseId") });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}
export async function markChatGenerationRecoverable(userDb: any, args: { userId: string; generationId: string; error?: string }) {
  const result = await userDb.rpc("mark_chat_generation_recoverable", { p_user_id: normalizeRequired(args.userId, "userId"), p_generation_id: normalizeRequired(args.generationId, "generationId"), p_error: args.error || "backend_execution_lease_expired" });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}
export async function markChatGenerationRunning(userDb: any, userId: string, generationId: string) { return checkpointChatGeneration(userDb, { userId, generationId, checkpoint: { status: "running" } }); }
export async function markChatGenerationCompleted(userDb: any, args: { userId: string; generationId: string; partialText?: string; tokensGenerated?: number; lastEventSequence?: number }) { return checkpointChatGeneration(userDb, { userId: args.userId, generationId: args.generationId, checkpoint: { status: "completed", partialText: args.partialText, tokensGenerated: args.tokensGenerated, lastEventSequence: args.lastEventSequence } }); }
export async function markChatGenerationFailed(userDb: any, args: { userId: string; generationId: string; errorCode: string; partialText?: string; tokensGenerated?: number; lastEventSequence?: number }) {
  const result = await userDb.from("chat_generations").update({ status: "failed", error_code: normalizeRequired(args.errorCode, "errorCode"), failed_at: new Date().toISOString(), ...(typeof args.partialText === "string" ? { partial_text: args.partialText } : {}), ...(Number.isFinite(args.tokensGenerated) ? { tokens_generated: Math.max(0, Math.floor(args.tokensGenerated!)) } : {}), ...(Number.isFinite(args.lastEventSequence) ? { last_event_sequence: Math.max(0, Math.floor(args.lastEventSequence!)) } : {}) }).eq("id", normalizeRequired(args.generationId, "generationId")).eq("user_id", normalizeRequired(args.userId, "userId")).select(CHAT_GENERATION_COLUMNS).maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}
export async function markChatGenerationFailedGuarded(
  userDb: any,
  args: {
    userId: string;
    generationId: string;
    errorCode: string;
    partialText?: string;
    tokensGenerated?: number;
    lastEventSequence?: number;
    allowAlreadyFailed?: boolean;
    allowStaleStatuses?: boolean;
  }
) {
  const userId = normalizeRequired(args.userId, "userId");
  const generationId = normalizeRequired(args.generationId, "generationId");
  const errorCode = normalizeRequired(args.errorCode, "errorCode");
  const nowIso = new Date().toISOString();

  const updatePayload: Record<string, unknown> = {
    status: "failed",
    error_code: errorCode,
    failed_at: nowIso,
    updated_at: nowIso,
  };
  if (typeof args.partialText === "string") updatePayload.partial_text = args.partialText;
  if (Number.isFinite(args.tokensGenerated)) updatePayload.tokens_generated = Math.max(0, Math.floor(args.tokensGenerated!));
  if (Number.isFinite(args.lastEventSequence)) updatePayload.last_event_sequence = Math.max(0, Math.floor(args.lastEventSequence!));

  let query = userDb
    .from("chat_generations")
    .update(updatePayload)
    .eq("id", generationId)
    .eq("user_id", userId);

  const baseStatuses = ["queued", "recoverable"];
  const staleStatuses = ["running", "generating", "persisting", "waiting_for_tool"];
  const allowedStatuses = [
    ...baseStatuses,
    ...(args.allowStaleStatuses !== false ? staleStatuses : []),
  ];

  if (typeof query.in === "function") {
    query = query.in("status", allowedStatuses);
  }
  if (typeof query.or === "function") {
    query = query.or(`execution_lease_id.is.null,execution_lease_expires_at.is.null,execution_lease_expires_at.lte.${nowIso}`);
  }
  if (typeof query.select === "function") {
    query = query.select(CHAT_GENERATION_COLUMNS);
  }

  const result = await (typeof query.maybeSingle === "function" ? query.maybeSingle() : query);
  if (result?.data) {
    return { data: normalizeRow(result.data), error: null };
  }

  if (args.allowAlreadyFailed) {
    // If the generation was already transitioned to 'failed', reconcile state and event sequence
    // WITHOUT overwriting original error_code or failed_at
    let existingResult: any = null;
    try {
      const fromObj = typeof userDb.from === "function" ? userDb.from("chat_generations") : null;
      if (fromObj && typeof fromObj.select === "function") {
        let selectQuery = fromObj.select(CHAT_GENERATION_COLUMNS).eq("id", generationId).eq("user_id", userId);
        existingResult = await (typeof selectQuery.maybeSingle === "function" ? selectQuery.maybeSingle() : selectQuery);
      }
    } catch {
      existingResult = null;
    }

    const existing = existingResult?.data ? normalizeRow(existingResult.data) : null;
    if (existing && existing.status === "failed") {
      const reconcilePayload: Record<string, unknown> = {
        updated_at: nowIso,
      };
      let needsReconcile = false;
      if (Number.isFinite(args.lastEventSequence)) {
        const nextSequence = Math.max(0, Math.floor(args.lastEventSequence!));
        if (nextSequence > (existing.last_event_sequence ?? 0)) {
          reconcilePayload.last_event_sequence = nextSequence;
          needsReconcile = true;
        }
      }
      if (typeof args.partialText === "string" && (!existing.partial_text || args.partialText.length > existing.partial_text.length)) {
        reconcilePayload.partial_text = args.partialText;
        needsReconcile = true;
      }
      if (Number.isFinite(args.tokensGenerated)) {
        const nextTokens = Math.max(0, Math.floor(args.tokensGenerated!));
        if (nextTokens > (existing.tokens_generated ?? 0)) {
          reconcilePayload.tokens_generated = nextTokens;
          needsReconcile = true;
        }
      }

      if (needsReconcile) {
        try {
          let updateQuery = userDb
            .from("chat_generations")
            .update(reconcilePayload)
            .eq("id", generationId)
            .eq("user_id", userId)
            .eq("status", "failed");
          if (typeof updateQuery.select === "function") {
            updateQuery = updateQuery.select(CHAT_GENERATION_COLUMNS);
          }
          const reconcileRes = await (typeof updateQuery.maybeSingle === "function" ? updateQuery.maybeSingle() : updateQuery);
          if (reconcileRes?.data) {
            return { data: normalizeRow(reconcileRes.data), error: null };
          }
        } catch {
          // If update fails, still return existing row
        }
      }
      return { data: existing, error: null };
    }
  }

  return { data: null, error: result?.error ?? null };
}
export async function requestChatGenerationCancel(userDb: any, userId: string, generationId: string) { const result = await userDb.rpc("request_chat_generation_cancel", { p_user_id: normalizeRequired(userId, "userId"), p_generation_id: normalizeRequired(generationId, "generationId") }); const row = Array.isArray(result.data) ? result.data[0] : result.data; return { data: row ? normalizeRow(row) : null, error: result.error }; }
export async function cancelChatGeneration(userDb: any, userId: string, generationId: string) { const result = await userDb.rpc("cancel_chat_generation", { p_user_id: normalizeRequired(userId, "userId"), p_generation_id: normalizeRequired(generationId, "generationId") }); const row = Array.isArray(result.data) ? result.data[0] : result.data; return { data: row ? normalizeRow(row) : null, error: result.error }; }
export const CHAT_GENERATION_CANCELLATION_INVARIANT = "SSE subscriber disconnects do not cancel chat generations; cancellation requires an explicit generation cancellation operation.";
