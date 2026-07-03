import type { BillingPlanCode } from "../billing/entitlementTypes";
import { getControlDatabase, getDataShardDatabases, getOrAssignUserDatabase } from "../dbRouter";

export type LiveUsageDenialReason =
  | "daily_sessions"
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

export interface LiveUsageStore {
  getUserStatus(userId: string): Promise<LiveUserUsageStatus>;
  hasCapacity(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<boolean>;
  reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: BillingPlanCode;
    dailySeconds: number;
    dailySessions: number;
    maxActiveSessions: number;
    reserveSeconds: number;
    graceSeconds: number;
  }): Promise<LiveUsageReservationResult>;
  activateSession(args: {
    userId: string;
    sessionId: string;
    keySlot: number;
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

  async hasCapacity(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<boolean> {
    if (!args.globalMaxActive && !args.projectMaxActive) return true;
    const database = getControlDatabase();
    const activeAfter = new Date().toISOString();
    if (args.globalMaxActive) {
      const { count, error } = await database
        .from("live_capacity_leases")
        .select("session_id", { count: "exact", head: true })
        .gt("expires_at", activeAfter);
      if (error) throw rpcError("Live global capacity status", error);
      if (numberValue(count) >= args.globalMaxActive) return false;
    }
    if (!args.projectMaxActive) return true;
    const counts = await Promise.all(args.keySlots.map(async (slot) => {
      const { count, error } = await database
        .from("live_capacity_leases")
        .select("session_id", { count: "exact", head: true })
        .eq("key_slot", slot)
        .gt("expires_at", activeAfter);
      if (error) throw rpcError("Live project capacity status", error);
      return numberValue(count);
    }));
    return counts.some((count) => count < args.projectMaxActive!);
  }

  async reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: BillingPlanCode;
    dailySeconds: number;
    dailySessions: number;
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
      p_daily_sessions: args.dailySessions,
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
}
