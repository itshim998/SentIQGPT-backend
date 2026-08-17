export const CHAT_GENERATION_STATUSES = [
  "queued", "running", "completed", "failed", "recoverable", "cancel_requested", "cancelled",
  "waiting_for_tool", "generating", "persisting",
] as const;

export type ChatGenerationStatus = typeof CHAT_GENERATION_STATUSES[number];
export type ChatGenerationExecutionMode = "fast" | "intuitive";

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

export async function claimChatGenerationExecution(userDb: any, args: { userId: string; generationId: string; leaseId: string; leaseSeconds?: number }) {
  const result = await userDb.rpc("claim_chat_generation_execution", {
    p_user_id: normalizeRequired(args.userId, "userId"),
    p_generation_id: normalizeRequired(args.generationId, "generationId"),
    p_lease_id: normalizeRequired(args.leaseId, "leaseId"),
    p_lease_seconds: Number.isFinite(args.leaseSeconds) ? Math.max(15, Math.floor(args.leaseSeconds!)) : 60,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export async function renewChatGenerationExecutionLease(userDb: any, args: { userId: string; generationId: string; leaseId: string; leaseSeconds?: number }) {
  const result = await userDb.rpc("renew_chat_generation_execution_lease", {
    p_user_id: normalizeRequired(args.userId, "userId"),
    p_generation_id: normalizeRequired(args.generationId, "generationId"),
    p_lease_id: normalizeRequired(args.leaseId, "leaseId"),
    p_lease_seconds: Number.isFinite(args.leaseSeconds) ? Math.max(15, Math.floor(args.leaseSeconds!)) : 60,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export async function releaseChatGenerationExecutionLease(userDb: any, args: { userId: string; generationId: string; leaseId: string }) {
  const result = await userDb.rpc("release_chat_generation_execution_lease", {
    p_user_id: normalizeRequired(args.userId, "userId"),
    p_generation_id: normalizeRequired(args.generationId, "generationId"),
    p_lease_id: normalizeRequired(args.leaseId, "leaseId"),
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export async function markChatGenerationRecoverable(userDb: any, args: { userId: string; generationId: string; error?: string }) {
  const result = await userDb.rpc("mark_chat_generation_recoverable", {
    p_user_id: normalizeRequired(args.userId, "userId"),
    p_generation_id: normalizeRequired(args.generationId, "generationId"),
    p_error: args.error || "backend_execution_lease_expired",
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export async function markChatGenerationRunning(userDb: any, userId: string, generationId: string) {
  return checkpointChatGeneration(userDb, { userId, generationId, checkpoint: { status: "running" } });
}
export async function markChatGenerationCompleted(userDb: any, args: { userId: string; generationId: string; partialText?: string; tokensGenerated?: number; lastEventSequence?: number }) {
  return checkpointChatGeneration(userDb, { userId: args.userId, generationId: args.generationId, checkpoint: { status: "completed", partialText: args.partialText, tokensGenerated: args.tokensGenerated, lastEventSequence: args.lastEventSequence } });
}
export async function markChatGenerationFailed(userDb: any, args: { userId: string; generationId: string; errorCode: string; partialText?: string; tokensGenerated?: number; lastEventSequence?: number }) {
  const result = await userDb.from("chat_generations").update({ status: "failed", error_code: normalizeRequired(args.errorCode, "errorCode"), failed_at: new Date().toISOString(), ...(typeof args.partialText === "string" ? { partial_text: args.partialText } : {}), ...(Number.isFinite(args.tokensGenerated) ? { tokens_generated: Math.max(0, Math.floor(args.tokensGenerated!)) } : {}), ...(Number.isFinite(args.lastEventSequence) ? { last_event_sequence: Math.max(0, Math.floor(args.lastEventSequence!)) } : {}) })
    .eq("id", normalizeRequired(args.generationId, "generationId")).eq("user_id", normalizeRequired(args.userId, "userId")).select(CHAT_GENERATION_COLUMNS).maybeSingle();
  return { data: result.data ? normalizeRow(result.data) : null, error: result.error };
}
export async function requestChatGenerationCancel(userDb: any, userId: string, generationId: string) {
  const result = await userDb.rpc("request_chat_generation_cancel", { p_user_id: normalizeRequired(userId, "userId"), p_generation_id: normalizeRequired(generationId, "generationId") });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}
export async function cancelChatGeneration(userDb: any, userId: string, generationId: string) {
  const result = await userDb.rpc("cancel_chat_generation", { p_user_id: normalizeRequired(userId, "userId"), p_generation_id: normalizeRequired(generationId, "generationId") });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return { data: row ? normalizeRow(row) : null, error: result.error };
}

export const CHAT_GENERATION_CANCELLATION_INVARIANT =
  "SSE subscriber disconnects do not cancel chat generations; cancellation requires an explicit generation cancellation operation.";
