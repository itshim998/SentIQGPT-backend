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
  client_request_id?: string | null;
};

export type PriorConversationUserMessageRow = {
  id: string;
  conversation_id: string;
  role: "user";
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
  clientRequestId?: string;
};

const MESSAGE_SELECT_COLUMNS = "id, role, content, created_at, client_request_id";

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
    .maybeSingle();

  return {
    data: result.data as ConversationRow | null,
    error: result.error,
  };
}

export async function insertConversationMessage(userDb: any, data: InsertConversationMessageInput) {
  const trimmedClientRequestId = typeof data.clientRequestId === "string" && data.clientRequestId.trim()
    ? data.clientRequestId.trim()
    : "";

  if (trimmedClientRequestId && data.role === "user") {
    const existingResult = await userDb
      .from("messages")
      .select(MESSAGE_SELECT_COLUMNS)
      .eq("conversation_id", data.conversationId)
      .eq("client_request_id", trimmedClientRequestId)
      .maybeSingle();

    if (existingResult.data) {
      return {
        data: existingResult.data as ConversationMessageRow,
        error: null,
        duplicate: true,
      };
    }
    if (existingResult.error && existingResult.error.code !== "PGRST116") {
      return {
        data: null,
        error: existingResult.error,
        duplicate: false,
      };
    }
  }

  const result = await userDb
    .from("messages")
    .insert({
      conversation_id: data.conversationId,
      role: data.role,
      content: data.content,
      client_request_id: trimmedClientRequestId || null,
    })
    .select(MESSAGE_SELECT_COLUMNS)
    .maybeSingle();

  if (result.error && trimmedClientRequestId && data.role === "user" && result.error.code === "23505") {
    const duplicateResult = await userDb
      .from("messages")
      .select(MESSAGE_SELECT_COLUMNS)
      .eq("conversation_id", data.conversationId)
      .eq("client_request_id", trimmedClientRequestId)
      .maybeSingle();
    return {
      data: duplicateResult.data as ConversationMessageRow | null,
      error: duplicateResult.error,
      duplicate: true,
    };
  }

  return {
    data: (result.data ?? null) as ConversationMessageRow | null,
    error: result.error,
    duplicate: false,
  };
}

export async function getConversationMessages(userDb: any, conversationId: string) {
  const result = await userDb
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  return {
    data: (result.data ?? []) as ConversationMessageRow[],
    error: result.error,
  };
}

export async function getPriorConversationUserMessages(
  userDb: any,
  userId: string,
  excludeConversationId?: string,
  limitConversations = 24,
  limitMessages = 200,
) {
  let conversationQuery = userDb
    .from("conversations")
    .select("id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limitConversations);

  if (excludeConversationId) {
    conversationQuery = conversationQuery.neq("id", excludeConversationId);
  }

  const conversationsResult = await conversationQuery;
  if (conversationsResult.error) {
    return {
      data: [] as PriorConversationUserMessageRow[],
      error: conversationsResult.error,
    };
  }

  const conversationIds = ((conversationsResult.data ?? []) as { id: string }[])
    .map((row) => row.id)
    .filter(Boolean);

  if (conversationIds.length === 0) {
    return {
      data: [] as PriorConversationUserMessageRow[],
      error: null,
    };
  }

  const messagesResult = await userDb
    .from("messages")
    .select("id, conversation_id, role, content, created_at")
    .in("conversation_id", conversationIds)
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(limitMessages);

  return {
    data: (messagesResult.data ?? []) as PriorConversationUserMessageRow[],
    error: messagesResult.error,
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
