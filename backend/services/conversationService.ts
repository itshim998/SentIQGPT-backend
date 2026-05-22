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
  message_count?: number;
  first_user_message?: string | null;
  last_message_at?: string | null;
};

export type ConversationAliasRow = {
  old_conversation_id: string;
  canonical_conversation_id: string;
  user_id: string;
  reason?: string | null;
  created_at?: string | null;
};

export type ConversationTurnResolutionRow = {
  conversation_id: string;
  title: string | null;
  created_at: string;
  last_activity_at?: string | null;
  created: boolean;
};

export type DuplicateConversationMergeRow = {
  canonical_conversation_id: string;
  duplicate_conversation_id: string;
  messages_moved: number;
  messages_deleted: number;
  images_moved: number;
  generated_files_moved: number;
  memories_moved: number;
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
  generated_file_id?: string | null;
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
  id?: string;
};

export type ResolveConversationForTurnInput = {
  userId: string;
  clientRequestId: string;
  conversationId?: string | null;
  title?: string;
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
  generatedFileId?: string;
  previewJson?: any;
};

export type ConversationMessageClientRequestLookup = {
  conversationId: string;
  clientRequestId: string;
  role: "user" | "assistant";
  messageType?: string;
};

const MESSAGE_SELECT_COLUMNS =
  "id, role, content, created_at, client_request_id, message_type, image_url, storage_path, prompt, provider, file_size_bytes, file_url, file_name, file_format, mime_type, generated_file_id, preview_json";

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
    .insert({
      ...(data.id ? { id: data.id } : {}),
      user_id: data.userId,
      title: data.title,
    })
    .select("id, title, created_at, last_activity_at")
    .single();

  if (result.error && data.id && result.error.code === "23505") {
    const existing = await getConversationById(userDb, data.id);
    if (existing.error) {
      return {
        data: null as ConversationListRow | null,
        error: existing.error,
      };
    }
    if (!existing.data || existing.data.user_id !== data.userId) {
      return {
        data: null as ConversationListRow | null,
        error: {
          message: "Conversation id already exists.",
          code: "conversation_id_conflict",
        },
      };
    }
    const { user_id: _userId, ...conversation } = existing.data;
    return {
      data: conversation as ConversationListRow,
      error: null,
    };
  }

  return {
    data: result.data as ConversationListRow | null,
    error: result.error,
  };
}

export async function resolveConversationForTurn(userDb: any, data: ResolveConversationForTurnInput) {
  const result = await userDb.rpc("resolve_conversation_for_turn", {
    p_user_id: data.userId,
    p_client_request_id: data.clientRequestId,
    p_requested_conversation_id: data.conversationId || null,
    p_title: data.title || "New Chat",
  });

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return {
    data: (row ?? null) as ConversationTurnResolutionRow | null,
    error: result.error,
  };
}

export async function getConversationAlias(userDb: any, userId: string, conversationId: string) {
  const result = await userDb
    .from("conversation_aliases")
    .select("old_conversation_id, canonical_conversation_id, user_id, reason, created_at")
    .eq("old_conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  return {
    data: (result.data ?? null) as ConversationAliasRow | null,
    error: result.error,
  };
}

export async function mergeDuplicateConversation(
  userDb: any,
  data: {
    userId: string;
    canonicalConversationId: string;
    duplicateConversationId: string;
    reason?: string;
  },
) {
  const result = await userDb.rpc("merge_duplicate_conversation", {
    p_user_id: data.userId,
    p_canonical_conversation_id: data.canonicalConversationId,
    p_duplicate_conversation_id: data.duplicateConversationId,
    p_reason: data.reason || "duplicate_merge",
  });

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return {
    data: (row ?? null) as DuplicateConversationMergeRow | null,
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
  const result = await userDb.rpc("list_user_conversations", { p_user_id: userId });

  if (result.error) {
    return {
      data: [] as ConversationListRow[],
      error: result.error,
    };
  }

  return {
    data: ((result.data ?? []) as ConversationListRow[]).map((conversation) => {
      const rawMessageCount = Number(conversation.message_count ?? 0);
      return {
        ...conversation,
        message_count: Number.isFinite(rawMessageCount) ? rawMessageCount : 0,
        first_user_message: conversation.first_user_message || null,
        last_message_at: conversation.last_message_at || null,
      };
    }),
    error: null,
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
    trimmedClientRequestId && (data.role === "user" || data.role === "assistant"),
  );

  if (canDeduplicateByClientRequestId) {
    const existingResult = await getConversationMessageByClientRequestId(userDb, {
      conversationId: data.conversationId,
      clientRequestId: trimmedClientRequestId,
      role: data.role,
      ...(data.role === "assistant" && normalizedMessageType !== "text"
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
      generated_file_id: data.generatedFileId || null,
      preview_json: data.previewJson || null,
    })
    .select(MESSAGE_SELECT_COLUMNS)
    .maybeSingle();

  if (result.error && canDeduplicateByClientRequestId && result.error.code === "23505") {
    const duplicateResult = await getConversationMessageByClientRequestId(userDb, {
      conversationId: data.conversationId,
      clientRequestId: trimmedClientRequestId,
      role: data.role,
      ...(data.role === "assistant" && normalizedMessageType !== "text"
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
