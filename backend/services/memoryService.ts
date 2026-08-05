export type MemoryScope = "global" | "chat";

export type MemoryFactType =
  | "stable_identity"
  | "stable_preference"
  | "active_project_state"
  | "unresolved_commitment"
  | "temporary_condition";

export type MemoryStatus = "active" | "superseded";

export type MemoryRow = {
  id: string;
  user_id: string;
  type: string;
  summary: string;
  importance: number;
  embedding?: number[] | null;
  embedding_model?: string | null;
  embedding_created_at?: string | null;
  embedding_backfill_requested_at?: string | null;
  embedding_backfill_attempts?: number | null;
  embedding_backfill_last_attempt_at?: string | null;
  embedding_backfill_error?: string | null;
  scope?: MemoryScope | null;
  chat_id?: string | null;
  created_at: string;
  subject_key?: string | null;
  fact_type?: MemoryFactType | null;
  source_conversation_id?: string | null;
  source_message_id?: string | null;
  last_confirmed_at?: string | null;
  supersedes_memory_id?: string | null;
  status?: MemoryStatus | null;
  confidence?: number | null;
  temporal_scope?: string | null;
  project_scope?: string | null;
};

export type MemorySearchRow = MemoryRow & {
  exact_phrase_match: boolean;
  entity_or_project_match: boolean;
  lexical_rank: number;
  scope_rank: number;
  recency_rank: number;
  anchor_rank: number;
  retrieval_rank: number;
};

export type MemoryLookupRow = {
  id: string;
  user_id: string;
  summary: string;
};

export type InsertMemoryInput = {
  userId: string;
  type?: string;
  summary?: string;
  importance?: number;
  embedding?: readonly number[] | null;
  embedding_model?: string | null;
  embedding_created_at?: string | null;
  scope?: MemoryScope;
  chat_id?: string | null;
  subject_key?: string | null;
  fact_type?: MemoryFactType | null;
  source_conversation_id?: string | null;
  source_message_id?: string | null;
  confidence?: number | null;
  temporal_scope?: string | null;
  project_scope?: string | null;
};

export type InsertAutomaticMemoryInput = InsertMemoryInput & {
  automaticIdempotencyKey: string;
};

export type AutomaticMemoryInsertResult = MemoryRow & {
  deduplicated: boolean;
};

const MEMORY_SELECT_COLUMNS = [
  "id",
  "user_id",
  "type",
  "summary",
  "importance",
  "embedding",
  "embedding_model",
  "embedding_created_at",
  "embedding_backfill_requested_at",
  "embedding_backfill_attempts",
  "embedding_backfill_last_attempt_at",
  "embedding_backfill_error",
  "scope",
  "chat_id",
  "created_at",
  "subject_key",
  "fact_type",
  "source_conversation_id",
  "source_message_id",
  "last_confirmed_at",
  "supersedes_memory_id",
  "status",
  "confidence",
  "temporal_scope",
  "project_scope",
].join(", ");

function normalizeEmbedding(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector = value
    .map((item) => typeof item === "number" ? item : Number(item))
    .filter((item) => Number.isFinite(item));
  return vector.length === value.length ? vector : null;
}

function normalizeByteCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }

  return 0;
}

function normalizeMemoryRow(value: unknown): MemoryRow | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  return candidate as MemoryRow;
}

export async function insertMemory(userDb: any, data: InsertMemoryInput) {
  const normalizedScope: MemoryScope = data.scope === "chat" ? "chat" : "global";
  const result = await userDb.rpc("persist_memory_with_lifecycle", {
    p_user_id: data.userId,
    p_type: data.type,
    p_summary: data.summary,
    p_importance: data.importance,
    p_embedding: normalizeEmbedding(data.embedding),
    p_embedding_model: data.embedding_model || null,
    p_embedding_created_at: data.embedding_created_at || null,
    p_scope: normalizedScope,
    p_chat_id: normalizedScope === "chat" ? data.chat_id ?? null : null,
    p_source_conversation_id: data.source_conversation_id ?? (
      normalizedScope === "chat" ? data.chat_id ?? null : null
    ),
    p_source_message_id: data.source_message_id ?? null,
    p_subject_key: data.subject_key ?? null,
    p_fact_type: data.fact_type ?? null,
    p_confidence: data.confidence ?? 0.75,
    p_temporal_scope: data.temporal_scope ?? null,
    p_project_scope: data.project_scope ?? null,
    p_automatic_idempotency_key: null,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;

  return {
    data: normalizeMemoryRow(row?.memory ?? row),
    error: result.error,
  };
}

export async function insertAutomaticMemoryOnce(userDb: any, data: InsertAutomaticMemoryInput) {
  const normalizedScope: MemoryScope = data.scope === "chat" ? "chat" : "global";
  const result = await userDb.rpc("insert_automatic_memory_once", {
    p_user_id: data.userId,
    p_type: data.type,
    p_summary: data.summary,
    p_importance: data.importance,
    p_embedding: normalizeEmbedding(data.embedding),
    p_embedding_model: data.embedding_model || null,
    p_embedding_created_at: data.embedding_created_at || null,
    p_scope: normalizedScope,
    p_chat_id: normalizedScope === "chat" ? data.chat_id ?? null : null,
    p_automatic_idempotency_key: data.automaticIdempotencyKey,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return {
    data: (row ?? null) as AutomaticMemoryInsertResult | null,
    error: result.error,
  };
}

export async function searchUserMemoriesLexically(args: {
  userDb: any;
  userId: string;
  query: string;
  conversationId?: string;
  limit?: number;
}) {
  const result = await args.userDb.rpc("search_memories_lexical", {
    p_user_id: args.userId,
    p_query: args.query,
    p_conversation_id: args.conversationId ?? null,
    p_limit: Math.max(1, Math.min(args.limit ?? 24, 60)),
  });

  return {
    data: (result.data ?? []) as MemorySearchRow[],
    error: result.error,
  };
}

export async function getUserMemories(userDb: any, userId: string) {
  const result = await userDb
    .from("memories")
    .select(MEMORY_SELECT_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("last_confirmed_at", { ascending: false });

  return {
    data: (result.data ?? []) as MemoryRow[],
    error: result.error,
  };
}

export async function updateMemoryEmbedding(
  userDb: any,
  memoryId: string,
  userId: string,
  embedding: readonly number[],
  embeddingModel: string,
) {
  const normalizedEmbedding = normalizeEmbedding(embedding);
  if (!normalizedEmbedding) {
    return {
      data: null,
      error: new Error("Invalid memory embedding"),
    };
  }

  const result = await userDb
    .from("memories")
    .update({
      embedding: normalizedEmbedding,
      embedding_model: embeddingModel,
      embedding_created_at: new Date().toISOString(),
      embedding_backfill_requested_at: null,
      embedding_backfill_error: null,
    })
    .eq("id", memoryId)
    .eq("user_id", userId)
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  return {
    data: result.data ?? null,
    error: result.error,
  };
}

export async function getMemoryById(userDb: any, memoryId: string, userId?: string) {
  let query = userDb
    .from("memories")
    .select("id, user_id, summary")
    .eq("id", memoryId);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const result = await query.maybeSingle();
  return {
    data: result.data as MemoryLookupRow | null,
    error: result.error,
  };
}

export async function deleteMemory(userDb: any, memoryId: string, userId?: string) {
  let query = userDb
    .from("memories")
    .delete()
    .eq("id", memoryId);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const result = await query;
  return {
    data: result.data ?? null,
    error: result.error,
  };
}

export async function getUserMemoryUsageBytes(userDb: any, userId: string) {
  const result = await userDb
    .from("users")
    .select("user_memory_usage_bytes")
    .eq("id", userId)
    .maybeSingle();

  return {
    data: normalizeByteCount(result.data?.user_memory_usage_bytes),
    error: result.error,
  };
}

async function adjustUserMemoryUsage(userDb: any, userId: string, deltaBytes: number) {
  if (deltaBytes === 0) {
    return {
      data: null,
      error: null,
    };
  }

  const result = await userDb.rpc("adjust_user_memory_usage", {
    p_user_id: userId,
    p_delta_bytes: deltaBytes,
  });

  return {
    data: normalizeByteCount(result.data),
    error: result.error,
  };
}

export async function incrementUserMemoryUsage(userDb: any, userId: string, bytes: number) {
  return adjustUserMemoryUsage(userDb, userId, Math.max(0, Math.trunc(bytes)));
}

export async function decrementUserMemoryUsage(userDb: any, userId: string, bytes: number) {
  return adjustUserMemoryUsage(userDb, userId, -Math.max(0, Math.trunc(bytes)));
}

export async function repairUserMemoryUsage(userDb: any, userId: string) {
  const result = await userDb.rpc("repair_user_memory_usage", {
    p_user_id: userId,
  });

  return {
    data: normalizeByteCount(result.data),
    error: result.error,
  };
}
