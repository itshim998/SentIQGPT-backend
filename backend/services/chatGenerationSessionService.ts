const DB_TIMEOUT_MS = 8000;
async function withDbTimeout<T = any>(promise: Promise<T>, timeoutMs = DB_TIMEOUT_MS, opName = "DB operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${opName} timed out after ${timeoutMs}ms`);
      (err as any).code = "db_timeout";
      reject(err);
    }, timeoutMs);
    timer?.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ChatGenerationSession = { id: string; user_id: string | null; anonymous_id: string | null; status: "open" | "closed"; created_at: string; last_heartbeat_at: string; closed_at: string | null };
function normalizeAnonymousId(value: unknown): string | null { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized || null; }
function normalizeSession(row: any): ChatGenerationSession { return { id: String(row.id), user_id: row.user_id ?? null, anonymous_id: row.anonymous_id ?? null, status: row.status === "closed" ? "closed" : "open", created_at: String(row.created_at), last_heartbeat_at: String(row.last_heartbeat_at), closed_at: row.closed_at ?? null }; }
export async function openChatGenerationSession(userDb: any, userId: string | null, anonymousId: string | null) { try { const result = await withDbTimeout(userDb.rpc("open_chat_generation_session", { p_user_id: userId || null, p_anonymous_id: normalizeAnonymousId(anonymousId) }), DB_TIMEOUT_MS, "open_chat_generation_session"); const row = Array.isArray(result.data) ? result.data[0] : result.data; return { data: row ? normalizeSession(row) : null, error: result.error }; } catch (error) { return { data: null, error }; } }
export async function claimChatGenerationRequest(userDb: any, sessionId: string, userId: string, clientRequestId: string) { try { const result = await withDbTimeout(userDb.rpc("claim_chat_generation_session_request", { p_session_id: sessionId, p_user_id: userId, p_client_request_id: clientRequestId }), DB_TIMEOUT_MS, "claim_chat_generation_session_request"); return { data: Array.isArray(result.data) ? result.data[0] : result.data, error: result.error }; } catch (error) { return { data: null, error }; } }
export async function heartbeatChatGenerationSession(userDb: any, sessionId: string, userId: string | null, anonymousId: string | null) { try { const result = await withDbTimeout(userDb.rpc("heartbeat_chat_generation_session", { p_session_id: sessionId, p_user_id: userId || null, p_anonymous_id: normalizeAnonymousId(anonymousId) }), DB_TIMEOUT_MS, "heartbeat_chat_generation_session"); const row = Array.isArray(result.data) ? result.data[0] : result.data; return { data: row ? normalizeSession(row) : null, error: result.error }; } catch (error) { return { data: null, error }; } }
export async function closeChatGenerationSession(userDb: any, sessionId: string, userId: string | null, anonymousId: string | null) { try { const result = await withDbTimeout(userDb.rpc("close_chat_generation_session", { p_session_id: sessionId, p_user_id: userId || null, p_anonymous_id: normalizeAnonymousId(anonymousId) }), DB_TIMEOUT_MS, "close_chat_generation_session"); const row = Array.isArray(result.data) ? result.data[0] : result.data; return { data: row ? normalizeSession(row) : null, error: result.error }; } catch (error) { return { data: null, error }; } }
export async function expireStaleChatGenerationSessions(userDb: any, leaseSeconds = 45) { try { const result = await withDbTimeout(userDb.rpc("expire_stale_chat_generation_sessions", { p_lease_seconds: leaseSeconds }), DB_TIMEOUT_MS, "expire_stale_chat_generation_sessions"); return { data: Array.isArray(result.data) ? result.data : [], error: result.error }; } catch (error) { return { data: [], error }; } }
