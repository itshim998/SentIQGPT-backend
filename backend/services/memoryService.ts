export type MemoryScope = "global" | "chat";

export type MemoryRow = {
  id: string;
  user_id: string;
  type: string;
  summary: string;
  importance: number;
  embedding?: number[] | null;
  embedding_model?: string | null;
  embedding_created_at?: string | null;
  scope?: MemoryScope | null;
  chat_id?: string | null;
  created_at: string;
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
};

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

export async function insertMemory(userDb: any, data: InsertMemoryInput) {
  const normalizedScope: MemoryScope = data.scope === "chat" ? "chat" : "global";
  const result = await userDb
    .from("memories")
    .insert({
      user_id: data.userId,
      type: data.type,
      summary: data.summary,
      importance: data.importance,
      embedding: normalizeEmbedding(data.embedding),
      embedding_model: data.embedding_model || null,
      embedding_created_at: data.embedding_created_at || null,
      scope: normalizedScope,
      chat_id: normalizedScope === "chat" ? data.chat_id ?? null : null,
    })
    .select("id, user_id, type, summary, importance, embedding, embedding_model, embedding_created_at, scope, chat_id, created_at")
    .single();

  return {
    data: result.data as MemoryRow | null,
    error: result.error,
  };
}

export async function getUserMemories(userDb: any, userId: string) {
  const result = await userDb
    .from("memories")
    .select("id, user_id, type, summary, importance, embedding, embedding_model, embedding_created_at, scope, chat_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

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
    })
    .eq("id", memoryId)
    .eq("user_id", userId)
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
