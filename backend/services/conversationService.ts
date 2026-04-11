export type ConversationRow = {
  id: string;
  user_id: string;
  title?: string | null;
  created_at?: string;
};

export type ConversationListRow = {
  id: string;
  title: string | null;
  created_at: string;
};

export type ConversationLimitRow = {
  id: string;
  created_at: string;
};

export type ConversationMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type CreateConversationInput = {
  userId: string;
  title: string;
};

export type InsertConversationMessageInput = {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
};

export async function createConversation(userDb: any, data: CreateConversationInput) {
  const result = await userDb
    .from("conversations")
    .insert({ user_id: data.userId, title: data.title })
    .select("id, title, created_at")
    .single();

  return {
    data: result.data as ConversationListRow | null,
    error: result.error,
  };
}

export async function deleteConversations(userDb: any, ids: string[], userId?: string) {
  if (ids.length === 0) {
    return {
      data: null,
      error: null,
    };
  }

  let query = userDb
    .from("conversations")
    .delete()
    .in("id", ids);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const result = await query;
  return {
    data: result.data ?? null,
    error: result.error,
  };
}

export async function getUserConversations(userDb: any, userId: string) {
  const result = await userDb
    .from("conversations")
    .select("id, title, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return {
    data: (result.data ?? []) as ConversationListRow[],
    error: result.error,
  };
}

export async function getUserConversationsOldestFirst(userDb: any, userId: string) {
  const result = await userDb
    .from("conversations")
    .select("id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  return {
    data: (result.data ?? []) as ConversationLimitRow[],
    error: result.error,
  };
}

export async function getConversationById(userDb: any, conversationId: string) {
  const result = await userDb
    .from("conversations")
    .select("id, user_id, title, created_at")
    .eq("id", conversationId)
    .single();

  return {
    data: result.data as ConversationRow | null,
    error: result.error,
  };
}

export async function insertConversationMessage(userDb: any, data: InsertConversationMessageInput) {
  const result = await userDb
    .from("messages")
    .insert({
      conversation_id: data.conversationId,
      role: data.role,
      content: data.content,
    });

  return {
    data: result.data ?? null,
    error: result.error,
  };
}

export async function getConversationMessages(userDb: any, conversationId: string) {
  const result = await userDb
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  return {
    data: (result.data ?? []) as ConversationMessageRow[],
    error: result.error,
  };
}

export async function updateConversationTitle(
  userDb: any,
  conversationId: string,
  userId: string,
  title: string,
) {
  const result = await userDb
    .from("conversations")
    .update({ title })
    .eq("id", conversationId)
    .eq("user_id", userId);

  return {
    data: result.data ?? null,
    error: result.error,
  };
}

export async function deleteConversation(userDb: any, conversationId: string, userId: string) {
  const result = await userDb
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", userId);

  return {
    data: result.data ?? null,
    error: result.error,
  };
}
