export type ConversationRow = {
  id: string;
  user_id: string;
  title?: string | null;
  created_at?: string;
  last_activity_at?: string | null;
};

export type ConversationListRow = {
  id: string;
  title: string | null;
  created_at: string;
  last_activity_at?: string | null;
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
  message_type?: string | null;
  image_url?: string | null;
  storage_path?: string | null;
  prompt?: string | null;
  provider?: string | null;
  file_size_bytes?: number | null;
  file_url?: string | null;
  file_name?: string | null;
  file_format?: string | null;
  mime_type?: string | null;
  preview_json?: any;
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
  messageType?: string;
  imageUrl?: string;
  storagePath?: string;
  prompt?: string;
  provider?: string;
  fileSizeBytes?: number;
  fileUrl?: string;
  fileName?: string;
  fileFormat?: string;
  mimeType?: string;
  previewJson?: any;
};

export type ConversationMessageClientRequestLookup = {
  conversationId: string;
  clientRequestId: string;
  role: "user" | "assistant";
  messageType?: string;
};

const MESSAGE_SELECT_COLUMNS =
  "id, role, content, created_at, client_request_id, message_type, image_url, storage_path, prompt, provider, file_size_bytes, file_url, file_name, file_format, mime_type, preview_json";

function buildClientRequestMessageQuery(userDb: any, data: ConversationMessageClientRequestLookup) {
  let query = userDb
    .from("messages")
    .select(MESSAGE_SELECT_COLUMNS)
    .eq("conversation_id", data.conversationId)
    .eq("client_request_id", data.clientRequestId)
    .eq("role", data.role);

  if (data.messageType) {
    query = query.eq("message_type", data.messageType);
  }

  return query;
}

export async function getConversationMessageByClientRequestId(
  userDb: any,
  data: ConversationMessageClientRequestLookup,
) {
  const trimmedClientRequestId = typeof data.clientRequestId === "string" ? data.clientRequestId.trim() : "";
  if (!trimmedClientRequestId) {
    return {
      data: null as ConversationMessageRow | null,
      error: null,
    };
  }

  const result = await buildClientRequestMessageQuery(userDb, {
    ...data,
    clientRequestId: trimmedClientRequestId,
  }).maybeSingle();

  return {
    data: (result.data ?? null) as ConversationMessageRow | null,
    error: result.error,
  };
}

export async function createConversation(userDb: any, data: CreateConversationInput) {
  const result = await userDb
    .from("conversations")
    .insert({ user_id: data.userId, title: data.title })
    .select("id, title, created_at, last_activity_at")
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
    .select("id, title, created_at, last_activity_at")
    .eq("user_id", userId)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
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
    .select("id, user_id, title, created_at, last_activity_at")
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
  const normalizedMessageType = data.messageType || "text";
  const canDeduplicateByClientRequestId = Boolean(
    trimmedClientRequestId && (
      data.role === "user"
      || (data.role === "assistant" && (normalizedMessageType === "image" || normalizedMessageType === "file"))
    ),
  );

  if (canDeduplicateByClientRequestId) {
    const existingResult = await getConversationMessageByClientRequestId(userDb, {
      conversationId: data.conversationId,
      clientRequestId: trimmedClientRequestId,
      role: data.role,
      ...(data.role === "assistant" && (normalizedMessageType === "image" || normalizedMessageType === "file")
        ? { messageType: normalizedMessageType }
        : {}),
    });

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
      message_type: normalizedMessageType,
      image_url: data.imageUrl || null,
      storage_path: data.storagePath || null,
      prompt: data.prompt || null,
      provider: data.provider || null,
      file_size_bytes: typeof data.fileSizeBytes === "number" ? data.fileSizeBytes : null,
      file_url: data.fileUrl || null,
      file_name: data.fileName || null,
      file_format: data.fileFormat || null,
      mime_type: data.mimeType || null,
      preview_json: data.previewJson || null,
    })
    .select(MESSAGE_SELECT_COLUMNS)
    .maybeSingle();

  if (result.error && canDeduplicateByClientRequestId && result.error.code === "23505") {
    const duplicateResult = await getConversationMessageByClientRequestId(userDb, {
      conversationId: data.conversationId,
      clientRequestId: trimmedClientRequestId,
      role: data.role,
      ...(data.role === "assistant" && (normalizedMessageType === "image" || normalizedMessageType === "file")
        ? { messageType: normalizedMessageType }
        : {}),
    });
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
