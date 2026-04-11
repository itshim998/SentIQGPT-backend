export type MemoryScope = "global" | "chat";

export type MemoryRow = {
  id: string;
  user_id: string;
  type: string;
  summary: string;
  importance: number;
  scope?: MemoryScope | null;
  chat_id?: string | null;
  created_at: string;
};

export type MemorySummaryRow = {
  summary: string | null;
};

export type InsertMemoryInput = {
  userId: string;
  type?: string;
  summary?: string;
  importance?: number;
  scope?: MemoryScope;
  chat_id?: string | null;
};

export async function insertMemory(userDb: any, data: InsertMemoryInput) {
  const normalizedScope: MemoryScope = data.scope === "chat" ? "chat" : "global";
  const result = await userDb
    .from("memories")
    .insert({
      user_id: data.userId,
      type: data.type,
      summary: data.summary,
      importance: data.importance,
      scope: normalizedScope,
      chat_id: normalizedScope === "chat" ? data.chat_id ?? null : null,
    })
    .select("id, user_id, type, summary, importance, scope, chat_id, created_at")
    .single();

  return {
    data: result.data as MemoryRow | null,
    error: result.error,
  };
}

export async function getUserMemories(userDb: any, userId: string) {
  const result = await userDb
    .from("memories")
    .select("id, user_id, type, summary, importance, scope, chat_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return {
    data: (result.data ?? []) as MemoryRow[],
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

export async function getMemorySummaries(userDb: any, userId: string) {
  const result = await userDb
    .from("memories")
    .select("summary")
    .eq("user_id", userId);

  return {
    data: (result.data ?? []) as MemorySummaryRow[],
    error: result.error,
  };
}
