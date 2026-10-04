import type { BillingPlanCode } from "../billing/entitlementTypes";
import { getControlDatabase, getDataShardDatabases, getOrAssignUserDatabase } from "../dbRouter";

export type LiveUsageDenialReason =
  | "daily_time"
  | "active_limit"
  | "duplicate_session"
  | "invalid_request";

export type LiveUsageReservationResult = {
  allowed: boolean;
  denialReason?: LiveUsageDenialReason;
  reservedSeconds: number;
  sessionsStarted: number;
  secondsUsed: number;
  secondsReserved: number;
  activeSessions: number;
  resetAt: string | null;
};

export type LiveCapacityReservationResult = {
  allowed: boolean;
  denialReason?: "global_capacity" | "project_capacity";
};

export type LiveFinalizeResult = {
  found: boolean;
  finalized: boolean;
  status: string;
  usedSeconds: number;
  reservedSeconds: number;
};

export type LiveUserUsageStatus = {
  sessionsStarted: number;
  secondsUsed: number;
  secondsReserved: number;
  activeSessions: number;
};

export type LiveStoredSession = {
  sessionId: string;
  planCode: BillingPlanCode;
  status: string;
  startedAt: string;
  audioStartedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  reservedSeconds: number;
  usedSeconds: number;
  keySlot: number | null;
  sourceConversationId?: string | null;
  liveConversationId?: string | null;
  transcriptCommitted?: boolean;
  transcriptCommittedAt?: string | null;
  metadata: Record<string, unknown>;
};

export type LiveStartResult = {
  found: boolean;
  started: boolean;
  alreadyStarted: boolean;
  status: string;
  audioStartedAt: string | null;
  expiresAt: string | null;
};

export interface LiveUsageStore {
  getUserStatus(userId: string): Promise<LiveUserUsageStatus>;
  getSession(args: { userId: string; sessionId: string }): Promise<LiveStoredSession | null>;
  markSessionStarted(args: {
    userId: string;
    sessionId: string;
    graceSeconds: number;
  }): Promise<LiveStartResult>;
  hasCapacity(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<boolean>;
  checkCapacityDetailed?(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<{ allowed: boolean; reason?: "global_capacity" | "per_key_capacity" }>;
  getActiveKeySlotCounts(slots: number[]): Promise<Map<number, number>>;
  reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: BillingPlanCode;
    dailySeconds: number;
    maxActiveSessions: number;
    reserveSeconds: number;
    graceSeconds: number;
  }): Promise<LiveUsageReservationResult>;
  activateSession(args: {
    userId: string;
    sessionId: string;
    keySlot: number;
    sourceConversationId?: string;
    liveConversationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean>;
  cancelReservation(args: { userId: string; sessionId: string; reason: string }): Promise<boolean>;
  finalizeSession(args: {
    userId: string;
    sessionId: string;
    usedSeconds: number;
    status: "ended" | "timeout";
    metadata?: Record<string, unknown>;
  }): Promise<LiveFinalizeResult>;
  commitLiveSessionTranscript(args: {
    userId: string;
    sessionId: string;
    conversationId: string;
    segments: Array<{ sequence: number; role: string; text: string }>;
    summary?: string;
  }): Promise<{ success: boolean; alreadyCommitted: boolean; conversationId: string }>;
  cleanupStaleSessions(userId: string): Promise<number>;
  cleanupAllStaleSessions(): Promise<number>;
  reserveCapacity(args: {
    sessionId: string;
    keySlot: number;
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    expiresAt: string;
  }): Promise<LiveCapacityReservationResult>;
  releaseCapacity(sessionId: string): Promise<boolean>;
  extendCapacity(sessionId: string, expiresAt: string): Promise<boolean>;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return objectValue(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function rpcError(operation: string, error: any): Error {
  return new Error(`${operation} failed: ${error?.code || "database_error"}`);
}

export class SupabaseLiveUsageStore implements LiveUsageStore {
  private readonly sessionDatabases = new Map<string, any>();

  private async userDatabase(userId: string, sessionId?: string): Promise<any> {
    if (sessionId && this.sessionDatabases.has(sessionId)) return this.sessionDatabases.get(sessionId);
    const userDb = await getOrAssignUserDatabase(userId);
    if (sessionId) this.sessionDatabases.set(sessionId, userDb);
    return userDb;
  }

  async getUserStatus(userId: string): Promise<LiveUserUsageStatus> {
    const userDb = await this.userDatabase(userId);
    const usageDate = new Date().toISOString().slice(0, 10);
    const [usageResult, activeResult] = await Promise.all([
      userDb
        .from("live_daily_usage")
        .select("sessions_started,seconds_used,seconds_reserved")
        .eq("owner_user_id", userId)
        .eq("usage_date", usageDate)
        .maybeSingle(),
      userDb
        .from("live_sessions")
        .select("session_id", { count: "exact", head: true })
        .eq("owner_user_id", userId)
        .in("status", ["provisioning", "active"])
        .gt("expires_at", new Date().toISOString()),
    ]);
    if (usageResult.error) throw rpcError("Live usage status", usageResult.error);
    if (activeResult.error) throw rpcError("Live active-session status", activeResult.error);
    return {
      sessionsStarted: numberValue(usageResult.data?.sessions_started),
      secondsUsed: numberValue(usageResult.data?.seconds_used),
      secondsReserved: numberValue(usageResult.data?.seconds_reserved),
      activeSessions: numberValue(activeResult.count),
    };
  }

  async getSession(args: { userId: string; sessionId: string }): Promise<LiveStoredSession | null> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb
      .from("live_sessions")
      .select("session_id,plan,status,started_at,audio_started_at,ended_at,expires_at,reserved_seconds,used_seconds,key_slot,source_conversation_id,live_conversation_id,transcript_committed,transcript_committed_at,metadata")
      .eq("session_id", args.sessionId)
      .eq("owner_user_id", args.userId)
      .maybeSingle();
    if (error) throw rpcError("Live session lookup", error);
    if (!data) return null;
    return {
      sessionId: String(data.session_id || ""),
      planCode: data.plan as BillingPlanCode,
      status: typeof data.status === "string" ? data.status : "unknown",
      startedAt: typeof data.started_at === "string" ? data.started_at : "",
      audioStartedAt: typeof data.audio_started_at === "string" ? data.audio_started_at : null,
      endedAt: typeof data.ended_at === "string" ? data.ended_at : null,
      expiresAt: typeof data.expires_at === "string" ? data.expires_at : "",
      reservedSeconds: numberValue(data.reserved_seconds),
      usedSeconds: numberValue(data.used_seconds),
      keySlot: data.key_slot === null || data.key_slot === undefined ? null : numberValue(data.key_slot),
      sourceConversationId: typeof data.source_conversation_id === "string" ? data.source_conversation_id : null,
      liveConversationId: typeof data.live_conversation_id === "string" ? data.live_conversation_id : null,
      transcriptCommitted: Boolean(data.transcript_committed),
      transcriptCommittedAt: typeof data.transcript_committed_at === "string" ? data.transcript_committed_at : null,
      metadata: objectValue(data.metadata),
    };
  }

  async markSessionStarted(args: {
    userId: string;
    sessionId: string;
    graceSeconds: number;
  }): Promise<LiveStartResult> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("mark_live_session_started", {
      p_owner_user_id: args.userId,
      p_session_id: args.sessionId,
      p_grace_seconds: args.graceSeconds,
    });
    if (error) throw rpcError("Live session start", error);
    const row = objectValue(data);
    return {
      found: row.found === true,
      started: row.started === true,
      alreadyStarted: row.already_started === true,
      status: typeof row.status === "string" ? row.status : "active",
      audioStartedAt: typeof row.audio_started_at === "string" ? row.audio_started_at : null,
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    };
  }

  async checkCapacityDetailed(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<{ allowed: boolean; reason?: "global_capacity" | "per_key_capacity" }> {
    if (!args.globalMaxActive && !args.projectMaxActive) return { allowed: true };
    const database = getControlDatabase();
    const activeAfter = new Date().toISOString();
    if (args.globalMaxActive) {
      const { count, error } = await database
        .from("live_capacity_leases")
        .select("session_id", { count: "exact", head: true })
        .gt("expires_at", activeAfter);
      if (error) throw rpcError("Live global capacity status", error);
      if (numberValue(count) >= args.globalMaxActive) {
        return { allowed: false, reason: "global_capacity" };
      }
    }
    if (!args.projectMaxActive) return { allowed: true };
    const counts = await Promise.all(args.keySlots.map(async (slot) => {
      const { count, error } = await database
        .from("live_capacity_leases")
        .select("session_id", { count: "exact", head: true })
        .eq("key_slot", slot)
        .gt("expires_at", activeAfter);
      if (error) throw rpcError("Live project capacity status", error);
      return numberValue(count);
    }));
    const hasPerKeySlot = counts.some((count) => count < args.projectMaxActive!);
    if (!hasPerKeySlot) {
      return { allowed: false, reason: "per_key_capacity" };
    }
    return { allowed: true };
  }

  async hasCapacity(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<boolean> {
    const result = await this.checkCapacityDetailed(args);
    return result.allowed;
  }

  async getActiveKeySlotCounts(slots: number[]): Promise<Map<number, number>> {
    const database = getControlDatabase();
    const activeAfter = new Date().toISOString();
    const counts = new Map<number, number>();
    for (const slot of slots) counts.set(slot, 0);
    const { data, error } = await database
      .from("live_capacity_leases")
      .select("key_slot")
      .gt("expires_at", activeAfter);
    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const slot = numberValue(row.key_slot);
        if (counts.has(slot)) {
          counts.set(slot, (counts.get(slot) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  async reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: BillingPlanCode;
    dailySeconds: number;
    maxActiveSessions: number;
    reserveSeconds: number;
    graceSeconds: number;
  }): Promise<LiveUsageReservationResult> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("reserve_live_session", {
      p_owner_user_id: args.userId,
      p_session_id: args.sessionId,
      p_plan: args.planCode,
      p_daily_seconds: args.dailySeconds,
      // Legacy RPC parameter. Live allowance is time-based, so completed calls
      // must not exhaust an independent start-count quota while time remains.
      p_daily_sessions: 2_147_483_647,
      p_max_active: args.maxActiveSessions,
      p_reserve_seconds: args.reserveSeconds,
      p_grace_seconds: args.graceSeconds,
    });
    if (error) throw rpcError("Live session reservation", error);
    const row = objectValue(data);
    return {
      allowed: row.allowed === true,
      denialReason: typeof row.denial_reason === "string"
        ? row.denial_reason as LiveUsageDenialReason
        : undefined,
      reservedSeconds: numberValue(row.reserved_seconds),
      sessionsStarted: numberValue(row.sessions_started),
      secondsUsed: numberValue(row.seconds_used),
      secondsReserved: numberValue(row.seconds_reserved),
      activeSessions: numberValue(row.active_sessions),
      resetAt: typeof row.reset_at === "string" ? row.reset_at : null,
    };
  }

  async activateSession(args: {
    userId: string;
    sessionId: string;
    keySlot: number;
    sourceConversationId?: string;
    liveConversationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("activate_live_session", {
      p_owner_user_id: args.userId,
      p_session_id: args.sessionId,
      p_key_slot: args.keySlot,
      p_metadata: args.metadata ?? {},
    });
    if (error) throw rpcError("Live session activation", error);
    if (args.sourceConversationId || args.liveConversationId) {
      const updates: Record<string, any> = {};
      if (args.sourceConversationId) updates.source_conversation_id = args.sourceConversationId;
      if (args.liveConversationId) updates.live_conversation_id = args.liveConversationId;
      await userDb.from("live_sessions").update(updates).eq("session_id", args.sessionId);
    }
    return data === true;
  }

  async cancelReservation(args: { userId: string; sessionId: string; reason: string }): Promise<boolean> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("cancel_live_session_reservation", {
      p_owner_user_id: args.userId,
      p_session_id: args.sessionId,
      p_reason: args.reason,
    });
    this.sessionDatabases.delete(args.sessionId);
    if (error) throw rpcError("Live session cancellation", error);
    return data === true;
  }

  async finalizeSession(args: {
    userId: string;
    sessionId: string;
    usedSeconds: number;
    status: "ended" | "timeout";
    metadata?: Record<string, unknown>;
  }): Promise<LiveFinalizeResult> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("finalize_live_session", {
      p_owner_user_id: args.userId,
      p_session_id: args.sessionId,
      p_used_seconds: args.usedSeconds,
      p_status: args.status,
      p_metadata: args.metadata ?? {},
    });
    this.sessionDatabases.delete(args.sessionId);
    if (error) throw rpcError("Live session finalization", error);
    const row = objectValue(data);
    return {
      found: row.found === true,
      finalized: row.finalized === true,
      status: typeof row.status === "string" ? row.status : "unknown",
      usedSeconds: numberValue(row.used_seconds),
      reservedSeconds: numberValue(row.reserved_seconds),
    };
  }

  async commitLiveSessionTranscript(args: {
    userId: string;
    sessionId: string;
    conversationId: string;
    segments: Array<{ sequence: number; role: string; text: string }>;
    summary?: string;
  }): Promise<{ success: boolean; alreadyCommitted: boolean; conversationId: string }> {
    const userDb = await this.userDatabase(args.userId, args.sessionId);
    const { data, error } = await userDb.rpc("commit_live_session_transcript", {
      p_session_id: args.sessionId,
      p_owner_user_id: args.userId,
      p_conversation_id: args.conversationId,
      p_segments: args.segments,
      p_summary: args.summary ?? null,
    });
    if (error) throw rpcError("Live transcript commit", error);
    const row = objectValue(data);
    return {
      success: row.success === true,
      alreadyCommitted: row.already_committed === true,
      conversationId: String(row.conversation_id || args.conversationId),
    };
  }

  async cleanupStaleSessions(userId: string): Promise<number> {
    const userDb = await this.userDatabase(userId);
    const { data, error } = await userDb.rpc("cleanup_stale_live_sessions", {
      p_owner_user_id: userId,
    });
    if (error) throw rpcError("Live stale-session cleanup", error);
    return numberValue(data);
  }

  async cleanupAllStaleSessions(): Promise<number> {
    const results = await Promise.all(getDataShardDatabases().map(async (database) => {
      const { data, error } = await database.rpc("cleanup_stale_live_sessions", {
        p_owner_user_id: null,
      });
      if (error) throw rpcError("Live global stale-session cleanup", error);
      return numberValue(data);
    }));
    return results.reduce((sum, count) => sum + count, 0);
  }

  async reserveCapacity(args: {
    sessionId: string;
    keySlot: number;
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    expiresAt: string;
  }): Promise<LiveCapacityReservationResult> {
    const { data, error } = await getControlDatabase().rpc("reserve_live_capacity", {
      p_session_id: args.sessionId,
      p_key_slot: args.keySlot,
      p_global_max_active: args.globalMaxActive,
      p_project_max_active: args.projectMaxActive,
      p_expires_at: args.expiresAt,
    });
    if (error) throw rpcError("Live capacity reservation", error);
    const row = objectValue(data);
    return {
      allowed: row.allowed === true,
      denialReason: row.denial_reason === "global_capacity" || row.denial_reason === "project_capacity"
        ? row.denial_reason
        : undefined,
    };
  }

  async releaseCapacity(sessionId: string): Promise<boolean> {
    const { data, error } = await getControlDatabase().rpc("release_live_capacity", {
      p_session_id: sessionId,
    });
    if (error) throw rpcError("Live capacity release", error);
    return data === true;
  }

  async extendCapacity(sessionId: string, expiresAt: string): Promise<boolean> {
    const { data, error } = await getControlDatabase()
      .from("live_capacity_leases")
      .update({ expires_at: expiresAt })
      .eq("session_id", sessionId)
      .gt("expires_at", new Date().toISOString())
      .select("session_id")
      .maybeSingle();
    if (error) throw rpcError("Live capacity extension", error);
    return Boolean(data?.session_id);
  }
}
