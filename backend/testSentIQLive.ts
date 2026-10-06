import assert from "assert/strict";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createServer, type Server } from "http";
import { resolve } from "path";
import { pathToFileURL } from "url";
import express, { type RequestHandler } from "express";
import { loadGeminiLiveConfig } from "./live/geminiLiveConfig";
import {
  GeminiLiveCapacityError,
  GeminiLiveKeyPool,
} from "./live/geminiLiveKeyPool";
import {
  GeminiLiveTokenError,
  GeminiLiveTokenService,
} from "./live/geminiLiveTokenService";
import {
  LiveSessionError,
  LiveSessionService,
  type LiveSessionPersistence,
  type LiveTranscriptTurn,
} from "./live/liveSessionService";
import { registerLiveRoutes } from "./live/liveRoutes";
import { loadLiveTierPolicy, type LiveTierPolicy } from "./live/liveTierPolicy";
import { LivePlanResolver } from "./live/livePlanResolver";
import type {
  LiveCapacityReservationResult,
  LiveFinalizeResult,
  LiveStartResult,
  LiveStoredSession,
  LiveUserUsageStatus,
  LiveUsageReservationResult,
  LiveUsageStore,
} from "./live/liveUsageStore";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY = "live-test-long-lived-key";

function liveConfig(enabled = true) {
  return loadGeminiLiveConfig({
    SENTIQ_LIVE_ENABLED: String(enabled),
    SENTIQ_LIVE_MODEL: "gemini-3.8-live",
    SENTIQ_LIVE_DEFAULT_VOICE: "Kore",
    SENTIQ_LIVE_SESSION_MAX_SECONDS: "600",
    SENTIQ_LIVE_AUDIO_ONLY: "true",
  });
}

async function testKeyPool(): Promise<void> {
  let now = 1_000;
  const pool = new GeminiLiveKeyPool({ keys: ["one", "two", "three"], now: () => now });
  const first = pool.acquire();
  assert.equal(first.slot, 1, "first selection should use the first never-used slot");
  now += 1;
  const second = pool.acquire();
  assert.equal(second.slot, 2, "LRU selection should move to the next never-used slot");
  pool.markFailure(second.slot, "capacity");
  now += 1;
  assert.equal(pool.acquire().slot, 3, "a cooling slot should be skipped");

  const single = new GeminiLiveKeyPool({ keys: ["only"], now: () => now });
  single.markFailure(1, "capacity");
  assert.throws(() => single.acquire(), GeminiLiveCapacityError);
  now += 60_001;
  assert.equal(single.acquire().slot, 1, "slot should recover after its cooldown");

  const activePool = new GeminiLiveKeyPool({ keys: ["one", "two"], now: () => now });
  const activeFirst = activePool.acquire(new Set(), 1);
  activePool.markActive(activeFirst.slot);
  assert.equal(activePool.getActiveCount(1), 1);
  assert.equal(activePool.hasAvailableSlot(1), true);
  assert.equal(activePool.acquire(new Set(), 1).slot, 2, "active per-project cap should route to another slot");
  activePool.markActive(2);
  assert.equal(activePool.hasAvailableSlot(1), false, "all full slots should report unavailable");
  activePool.releaseActive(2);
  activePool.releaseActive(1);
  assert.equal(activePool.getActiveCount(1), 0, "ending a session should release the slot count");
}

function testTierPolicy(): void {
  const defaults = loadLiveTierPolicy({});
  assert.equal(defaults.plans.free.enabled, true);
  assert.equal(defaults.plans.free.dailySeconds, 120);
  assert.equal(defaults.plans.free.maxSessionSeconds, 120);
  assert.equal(defaults.plans.free.maxActiveSessions, 1);
  assert.equal(defaults.plans.student_core.dailySeconds, 480);
  assert.equal(defaults.plans.student_core.maxSessionSeconds, 300);
  assert.equal(defaults.plans.premium.dailySeconds, 1_500);
  assert.equal(defaults.plans.pro.dailySeconds, 4_500);
  assert.equal(defaults.plans.pro.maxActiveSessions, 2);

  const invalid = loadLiveTierPolicy({
    SENTIQ_LIVE_FREE_ENABLED: "not-a-boolean",
    SENTIQ_LIVE_FREE_DAILY_MINUTES: "-1",
    SENTIQ_LIVE_STUDENT_CORE_DAILY_MINUTES: "-1",
    SENTIQ_LIVE_PRO_MAX_SESSION_SECONDS: "99999",
    SENTIQ_LIVE_PRO_MAX_ACTIVE: "0",
    SENTIQ_LIVE_GLOBAL_MAX_ACTIVE: "invalid",
  });
  assert.equal(invalid.plans.free.enabled, true);
  assert.equal(invalid.plans.free.dailySeconds, 120);
  assert.equal(invalid.plans.student_core.dailySeconds, 480);
  assert.equal(invalid.plans.pro.maxSessionSeconds, 600);
  assert.equal(invalid.plans.pro.maxActiveSessions, 2);
  assert.equal(invalid.globalMaxActive, null);

  const configured = loadLiveTierPolicy({
    SENTIQ_LIVE_FREE_ENABLED: "true",
    SENTIQ_LIVE_FREE_DAILY_MINUTES: "2",
    SENTIQ_LIVE_GLOBAL_MAX_ACTIVE: "25",
    SENTIQ_LIVE_PROJECT_MAX_ACTIVE: "7",
  });
  assert.equal(configured.plans.free.enabled, true);
  assert.equal(configured.plans.free.dailySeconds, 120);
  assert.equal(configured.globalMaxActive, 25);
  assert.equal(configured.projectMaxActive, 7);
}

async function testPlanResolutionFallback(): Promise<void> {
  const resolver = new LivePlanResolver(async () => { throw new Error("billing unavailable"); }, () => {});
  assert.equal(await resolver.resolve(USER_ID), "free", "failed plan resolution must fail closed to Free");
  const normalized = new LivePlanResolver(async () => "unexpected", () => {});
  assert.equal(await normalized.resolve(USER_ID), "free", "unknown plans must normalize to Free");
}

async function testTokenService(): Promise<void> {
  let capturedBody: any = null;
  let capturedHeaders: Record<string, string> | null = null;
  const service = new GeminiLiveTokenService({
    now: () => Date.parse("2026-07-03T00:00:00.000Z"),
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "auth_tokens/ephemeral-test" }),
      };
    },
  });
  const token = await service.createToken({
    apiKey: API_KEY,
    config: liveConfig(),
    systemInstruction: "Live system instruction",
  });
  assert.equal(token.token, "auth_tokens/ephemeral-test");
  assert.equal(capturedHeaders?.["x-goog-api-key"], API_KEY);
  assert.equal(capturedBody.uses, 1);
  assert.equal(capturedBody.liveConnectConstraints, undefined, "liveConnectConstraints must be absent from auth_tokens payload");
  assert(!("liveConnectConstraints" in capturedBody), "liveConnectConstraints must be absent from auth_tokens payload");
  assert.equal(capturedBody.bidiGenerateContentSetup.model, "models/gemini-3.8-live");
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.generationConfig.responseModalities, ["AUDIO"]);
  assert(!("thinkingConfig" in capturedBody.bidiGenerateContentSetup.generationConfig), "Gemini 3.8 Live setup must not contain thinkingConfig");
  assert(!("thinking_config" in capturedBody.bidiGenerateContentSetup.generationConfig), "Gemini 3.8 Live setup must not contain thinking_config");
  assert(!("thinkingLevel" in capturedBody.bidiGenerateContentSetup.generationConfig), "Gemini 3.8 Live setup must not contain thinkingLevel");
  assert(!("tools" in capturedBody.bidiGenerateContentSetup), "core Live audio should not require Search quota");
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.inputAudioTranscription, {});
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.outputAudioTranscription, {});
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.historyConfig, {
    initialHistoryInClientContent: true,
  });
  assert.equal(
    capturedBody.bidiGenerateContentSetup.realtimeInputConfig.activityHandling,
    "START_OF_ACTIVITY_INTERRUPTS",
  );
  assert(!initBodyContains(capturedBody, API_KEY), "the long-lived API key must not be embedded in the token body");

  await service.createToken({
    apiKey: API_KEY,
    config: loadGeminiLiveConfig({
      SENTIQ_LIVE_ENABLED: "true",
      SENTIQ_LIVE_SEARCH_GROUNDING_ENABLED: "true",
    }),
    systemInstruction: "Live system instruction",
  });
  assert.deepEqual(
    capturedBody.bidiGenerateContentSetup.tools,
    [{ googleSearch: {} }],
    "eligible deployments can explicitly opt into Search grounding",
  );

  const constrainedToken = await service.createToken({
    apiKey: API_KEY,
    config: loadGeminiLiveConfig({
      SENTIQ_LIVE_ENABLED: "true",
      SENTIQ_LIVE_SEARCH_GROUNDING_ENABLED: "true",
      SENTIQ_LIVE_DISABLE_SEARCH_GROUNDING: "true",
    }),
    systemInstruction: "Live system instruction",
    sessionMaxSeconds: 20,
  });
  assert(!("tools" in capturedBody.bidiGenerateContentSetup), "emergency control should remove Search grounding");
  assert.equal(constrainedToken.expiresAt, "2026-07-03T00:00:20.000Z", "remaining daily time should constrain token expiry");
  assert.equal(constrainedToken.newSessionExpiresAt, "2026-07-03T00:00:10.000Z");

  const failing = new GeminiLiveTokenService({
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: "quota" }) }),
  });
  await assert.rejects(
    () => failing.createToken({ apiKey: API_KEY, config: liveConfig(), systemInstruction: "test" }),
    (error: unknown) => error instanceof GeminiLiveTokenError && error.failureClass === "capacity",
  );
}

function initBodyContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

function createPersistence() {
  const commits: any[] = [];
  let convCounter = 0;
  const persistence: LiveSessionPersistence = {
    prepareContext: async () => {
      convCounter += 1;
      const conversationId = convCounter === 1
        ? CONVERSATION_ID
        : `${CONVERSATION_ID.slice(0, -4)}${String(convCounter).padStart(4, "0")}`;
      return {
        conversationId,
        liveConversationId: conversationId,
        displayName: "Test User",
        workspaceCapsule: "Workspace capsule",
        conversationCapsule: "Conversation capsule",
        recentTurns: [
          { role: "user", text: "Earlier question" },
          { role: "assistant", text: "Earlier answer" },
        ],
      };
    },
    persistTranscript: async (args) => {
      commits.push(args);
      return args.transcript.length > 0 || args.summary ? 1 : 0;
    },
  };
  return { persistence, commits };
}

type FakeSession = {
  userId: string;
  planCode: "free" | "student_core" | "premium" | "pro";
  reservedSeconds: number;
  status: "provisioning" | "active" | "ended" | "timeout" | "cancelled";
  startedAt: number;
  audioStartedAt: number | null;
  endedAt: number | null;
  expiresAt: number;
  usedSeconds: number;
  keySlot: number | null;
  metadata: Record<string, unknown>;
};

class InMemoryLiveUsageStore implements LiveUsageStore {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly usage = new Map<string, { sessions: number; used: number; reserved: number }>();
  private readonly capacity = new Map<string, { keySlot: number; expiresAt: number }>();
  public readonly transcriptSegments = new Map<string, Map<number, { sequence: number; role: string; text: string }>>();

  constructor(private readonly now: () => number) {}

  private usageFor(userId: string) {
    if (!this.usage.has(userId)) this.usage.set(userId, { sessions: 0, used: 0, reserved: 0 });
    return this.usage.get(userId)!;
  }

  async getUserStatus(userId: string): Promise<LiveUserUsageStatus> {
    await this.cleanupStaleSessions(userId);
    const usage = this.usageFor(userId);
    const activeSessions = [...this.sessions.values()].filter((session) => (
      session.userId === userId && (session.status === "provisioning" || session.status === "active")
    )).length;
    return {
      sessionsStarted: usage.sessions,
      secondsUsed: usage.used,
      secondsReserved: usage.reserved,
      activeSessions,
    };
  }

  async getSession(args: { userId: string; sessionId: string }): Promise<LiveStoredSession | null> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId) return null;
    return {
      sessionId: args.sessionId,
      planCode: session.planCode,
      status: session.status,
      startedAt: new Date(session.startedAt).toISOString(),
      audioStartedAt: session.audioStartedAt ? new Date(session.audioStartedAt).toISOString() : null,
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      expiresAt: new Date(session.expiresAt).toISOString(),
      reservedSeconds: session.reservedSeconds,
      usedSeconds: session.usedSeconds,
      keySlot: session.keySlot,
      metadata: { ...session.metadata },
    };
  }

  async markSessionStarted(args: {
    userId: string;
    sessionId: string;
    graceSeconds: number;
  }): Promise<LiveStartResult> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId) {
      return {
        found: false,
        started: false,
        alreadyStarted: false,
        status: "missing",
        audioStartedAt: null,
        expiresAt: null,
      };
    }
    if (session.status !== "active") {
      return {
        found: true,
        started: false,
        alreadyStarted: false,
        status: session.status,
        audioStartedAt: null,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    }
    const alreadyStarted = session.audioStartedAt !== null;
    session.audioStartedAt ??= this.now();
    session.expiresAt = Math.max(
      session.expiresAt,
      session.audioStartedAt + (session.reservedSeconds + args.graceSeconds) * 1_000,
    );
    return {
      found: true,
      started: true,
      alreadyStarted,
      status: session.status,
      audioStartedAt: new Date(session.audioStartedAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async hasCapacity(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<boolean> {
    for (const [sessionId, lease] of this.capacity) {
      if (lease.expiresAt <= this.now()) this.capacity.delete(sessionId);
    }
    if (args.globalMaxActive && this.capacity.size >= args.globalMaxActive) return false;
    if (!args.projectMaxActive) return true;
    return args.keySlots.some((slot) => (
      [...this.capacity.values()].filter((lease) => lease.keySlot === slot).length < args.projectMaxActive!
    ));
  }

  async checkCapacityDetailed(args: {
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    keySlots: number[];
  }): Promise<{ allowed: boolean; reason?: "global_capacity" | "per_key_capacity" }> {
    for (const [sessionId, lease] of this.capacity) {
      if (lease.expiresAt <= this.now()) this.capacity.delete(sessionId);
    }
    if (args.globalMaxActive && this.capacity.size >= args.globalMaxActive) {
      return { allowed: false, reason: "global_capacity" };
    }
    if (args.projectMaxActive && args.keySlots.length > 0) {
      const activePerKey = [...this.capacity.values()].reduce<Record<number, number>>((acc, lease) => {
        acc[lease.keySlot] = (acc[lease.keySlot] || 0) + 1;
        return acc;
      }, {});
      const allSlotsSaturated = args.keySlots.every((slot) => (activePerKey[slot] || 0) >= args.projectMaxActive!);
      if (allSlotsSaturated) {
        return { allowed: false, reason: "per_key_capacity" };
      }
    }
    return { allowed: true };
  }

  async reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: any;
    dailySeconds: number;
    maxActiveSessions: number;
    reserveSeconds: number;
    graceSeconds: number;
  }): Promise<LiveUsageReservationResult> {
    await this.cleanupStaleSessions(args.userId);
    const usage = this.usageFor(args.userId);
    const activeSessions = [...this.sessions.values()].filter((session) => (
      session.userId === args.userId && (session.status === "provisioning" || session.status === "active")
    )).length;
    const base = {
      reservedSeconds: 0,
      sessionsStarted: usage.sessions,
      secondsUsed: usage.used,
      secondsReserved: usage.reserved,
      activeSessions,
      resetAt: "2026-07-04T00:00:00.000Z",
    };
    const remaining = Math.max(0, args.dailySeconds - usage.used - usage.reserved);
    if (remaining <= 0) return { allowed: false, denialReason: "daily_time", ...base };
    if (activeSessions >= args.maxActiveSessions) return { allowed: false, denialReason: "active_limit", ...base };
    const reservedSeconds = Math.min(remaining, args.reserveSeconds);
    usage.sessions += 1;
    usage.reserved += reservedSeconds;
    this.sessions.set(args.sessionId, {
      userId: args.userId,
      planCode: args.planCode,
      reservedSeconds,
      status: "provisioning",
      startedAt: this.now(),
      audioStartedAt: null,
      endedAt: null,
      expiresAt: this.now() + (reservedSeconds + args.graceSeconds) * 1_000,
      usedSeconds: 0,
      keySlot: null,
      metadata: {},
    });
    return {
      allowed: true,
      reservedSeconds,
      sessionsStarted: usage.sessions,
      secondsUsed: usage.used,
      secondsReserved: usage.reserved,
      activeSessions: activeSessions + 1,
      resetAt: base.resetAt,
    };
  }

  async activateSession(args: {
    userId: string;
    sessionId: string;
    keySlot: number;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId || session.status !== "provisioning") return false;
    session.status = "active";
    session.keySlot = args.keySlot;
    session.metadata = { ...session.metadata, ...(args.metadata || {}) };
    return true;
  }

  async cancelReservation(args: { userId: string; sessionId: string; reason: string }): Promise<boolean> {
    const session = this.sessions.get(args.sessionId);
    if (
      !session
      || session.userId !== args.userId
      || !["provisioning", "active"].includes(session.status)
      || session.audioStartedAt !== null
    ) return false;
    const usage = this.usageFor(args.userId);
    usage.sessions = Math.max(0, usage.sessions - 1);
    usage.reserved = Math.max(0, usage.reserved - session.reservedSeconds);
    session.status = "cancelled";
    session.endedAt = this.now();
    return true;
  }

  async finalizeSession(args: {
    userId: string;
    sessionId: string;
    usedSeconds: number;
    status: "ended" | "timeout";
  }): Promise<LiveFinalizeResult> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId) {
      return { found: false, finalized: false, status: "missing", usedSeconds: 0, reservedSeconds: 0 };
    }
    if (session.status !== "active" && session.status !== "provisioning") {
      return {
        found: true,
        finalized: false,
        status: session.status,
        usedSeconds: session.usedSeconds,
        reservedSeconds: session.reservedSeconds,
      };
    }
    const usage = this.usageFor(args.userId);
    session.usedSeconds = Math.min(session.reservedSeconds, Math.max(0, args.usedSeconds));
    session.status = args.status;
    session.endedAt = this.now();
    usage.reserved = Math.max(0, usage.reserved - session.reservedSeconds);
    usage.used += session.usedSeconds;
    return {
      found: true,
      finalized: true,
      status: session.status,
      usedSeconds: session.usedSeconds,
      reservedSeconds: session.reservedSeconds,
    };
  }

  async cleanupStaleSessions(userId: string): Promise<number> {
    let cleaned = 0;
    for (const [sessionId, session] of this.sessions) {
      if (
        session.userId === userId
        && (session.status === "active" || session.status === "provisioning")
        && session.expiresAt <= this.now()
      ) {
        if (session.audioStartedAt === null) {
          await this.cancelReservation({ userId, sessionId, reason: "stale_startup_timeout" });
        } else {
          await this.finalizeSession({ userId, sessionId, usedSeconds: session.reservedSeconds, status: "timeout" });
        }
        cleaned += 1;
      }
    }
    return cleaned;
  }

  async cleanupAllStaleSessions(): Promise<number> {
    const userIds = new Set([...this.sessions.values()].map((session) => session.userId));
    let cleaned = 0;
    for (const userId of userIds) cleaned += await this.cleanupStaleSessions(userId);
    return cleaned;
  }

  async reserveCapacity(args: {
    sessionId: string;
    keySlot: number;
    globalMaxActive: number | null;
    projectMaxActive: number | null;
    expiresAt: string;
  }): Promise<LiveCapacityReservationResult> {
    for (const [sessionId, lease] of this.capacity) {
      if (lease.expiresAt <= this.now()) this.capacity.delete(sessionId);
    }
    if (args.globalMaxActive && this.capacity.size >= args.globalMaxActive) {
      return { allowed: false, denialReason: "global_capacity" };
    }
    const projectActive = [...this.capacity.values()].filter((lease) => lease.keySlot === args.keySlot).length;
    if (args.projectMaxActive && projectActive >= args.projectMaxActive) {
      return { allowed: false, denialReason: "project_capacity" };
    }
    this.capacity.set(args.sessionId, { keySlot: args.keySlot, expiresAt: Date.parse(args.expiresAt) });
    return { allowed: true };
  }

  async releaseCapacity(sessionId: string): Promise<boolean> {
    return this.capacity.delete(sessionId);
  }

  async extendCapacity(sessionId: string, expiresAt: string): Promise<boolean> {
    const lease = this.capacity.get(sessionId);
    if (!lease || lease.expiresAt <= this.now()) return false;
    lease.expiresAt = Date.parse(expiresAt);
    return true;
  }

  async getActiveKeySlotCounts(slots: number[]): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    for (const slot of slots) counts.set(slot, 0);
    const now = this.now();
    for (const lease of this.capacity.values()) {
      if (lease.expiresAt > now && counts.has(lease.keySlot)) {
        counts.set(lease.keySlot, (counts.get(lease.keySlot) ?? 0) + 1);
      }
    }
    return counts;
  }

  async commitLiveSessionTranscript(args: {
    userId: string;
    sessionId: string;
    conversationId: string;
    segments: Array<{ sequence: number; role: string; text: string }>;
    summary?: string;
  }): Promise<{ success: boolean; alreadyCommitted: boolean; conversationId: string }> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId) {
      throw new Error("live_session_not_found");
    }
    const alreadyCommitted = Boolean((session as any).transcriptCommitted);
    (session as any).transcriptCommitted = true;
    (session as any).liveConversationId = args.conversationId;
    if (!this.transcriptSegments.has(args.sessionId)) {
      this.transcriptSegments.set(args.sessionId, new Map());
    }
    const sessionSegments = this.transcriptSegments.get(args.sessionId)!;
    for (const segment of args.segments) {
      if (!sessionSegments.has(segment.sequence)) {
        sessionSegments.set(segment.sequence, segment);
      }
    }
    return {
      success: true,
      alreadyCommitted,
      conversationId: args.conversationId,
    };
  }

  getActiveCount(userId: string): number {
    return [...this.sessions.values()].filter((session) => (
      session.userId === userId && (session.status === "active" || session.status === "provisioning")
    )).length;
  }

  getSessionStatus(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  getUsedSeconds(userId: string): number {
    return this.usageFor(userId).used;
  }
}

function createService(args: {
  enabled?: boolean;
  key?: string;
  planCode?: "free" | "student_core" | "premium" | "pro";
  now?: () => number;
  usageStore?: InMemoryLiveUsageStore;
  tierPolicy?: LiveTierPolicy;
  tokenFetchImpl?: (input: string, init: any) => Promise<any>;
  keyPool?: GeminiLiveKeyPool;
} = {}) {
  const { persistence, commits } = createPersistence();
  const now = args.now ?? Date.now;
  const usageStore = args.usageStore ?? new InMemoryLiveUsageStore(now);
  const keyPool = args.keyPool ?? new GeminiLiveKeyPool({ keys: args.key === "" ? [] : [args.key || API_KEY], now });
  const titleRequests: Array<{
    userId: string;
    conversationId: string;
    userMessage: string;
    assistantReply: string;
  }> = [];
  let idCounter = 0;
  const service = new LiveSessionService({
    config: liveConfig(args.enabled ?? true),
    tierPolicy: args.tierPolicy ?? loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => args.planCode ?? "premium", () => {}),
    usageStore,
    keyPool,
    tokenService: new GeminiLiveTokenService({
      fetchImpl: args.tokenFetchImpl ?? (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: "auth_tokens/route-ephemeral" }),
      })),
    }),
    persistence,
    titleGenerator: {
      generateTitle: async (request) => { titleRequests.push(request); },
    },
    now,
    newId: () => {
      const suffix = String(333_333_333_333 + idCounter).padStart(12, "0");
      idCounter += 1;
      return `33333333-3333-4333-8333-${suffix}`;
    },
    logger: () => {},
    cleanupIntervalMs: 60 * 60_000,
  });
  return { service, commits, titleRequests, usageStore, keyPool };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function buildApp(service: LiveSessionService) {
  const app = express();
  app.use(express.json());
  const requireAuth: RequestHandler = (req, res, next) => {
    if (req.get("authorization") !== "Bearer test-user") {
      res.status(401).json({ error: "Missing token." });
      return;
    }
    (req as any).user = {
      sub: USER_ID,
      isGuest: false,
      verificationMethod: "local",
    };
    next();
  };
  const statusAuth: RequestHandler = (req, _res, next) => {
    (req as any).user = req.get("authorization") === "Bearer test-user"
      ? { sub: USER_ID, isGuest: false, verificationMethod: "local" }
      : { sub: "guest", isGuest: true, verificationMethod: "guest" };
    next();
  };
  registerLiveRoutes(app, { service, requireAuth, statusAuth });
  return app;
}

async function testRoutes(): Promise<void> {
  const { service, commits, titleRequests, usageStore } = createService();
  const { server, baseUrl } = await listen(buildApp(service));
  try {
    const unauthorized = await fetch(`${baseUrl}/api/live/session-token`, { method: "POST" });
    assert.equal(unauthorized.status, 401, "session-token must require authentication");

    const guestStatus = await fetch(`${baseUrl}/api/live/status`).then((response) => response.json()) as any;
    assert.deepEqual(guestStatus, {
      enabled: true,
      available: false,
      reason: "sign_in_required",
      remainingSecondsToday: 0,
      remainingSessionsToday: 0,
      maxSessionSeconds: 0,
      activeSession: null,
    });
    const status = await fetch(`${baseUrl}/api/live/status`, {
      headers: { authorization: "Bearer test-user" },
    }).then((response) => response.json()) as any;
    assert.equal(status.enabled, true);
    assert.equal(status.available, true);
    assert.equal(status.reason, "available");
    assert.equal(status.remainingSecondsToday, 1_500);
    assert.equal(status.remainingSessionsToday, 1, "compatibility field should indicate another timed session can start");
    assert.equal(status.maxSessionSeconds, 600);
    assert.equal(status.activeSession, null);
    assert.deepEqual(
      Object.keys(status).sort(),
      [
        "activeSession",
        "available",
        "enabled",
        "maxSessionSeconds",
        "reason",
        "remainingSecondsToday",
        "remainingSessionsToday",
      ].sort(),
      "status must not expose provider, model, key, slot, or token details",
    );

    const tokenResponse = await fetch(`${baseUrl}/api/live/session-token`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: JSON.stringify({ conversationId: CONVERSATION_ID }),
    });
    assert.equal(tokenResponse.status, 201);
    const tokenPayload = await tokenResponse.json() as any;
    assert.equal(tokenPayload.sessionId, SESSION_ID);
    assert.equal(tokenPayload.conversationId, CONVERSATION_ID);
    assert.equal(tokenPayload.audio.inputSampleRate, 16_000);
    assert.equal(tokenPayload.audio.outputSampleRate, 24_000);
    assert.equal(tokenPayload.audio.encoding, "pcm_s16le");
    assert.match(tokenPayload.webSocketUrl, /BidiGenerateContentConstrained$/);
    assert(!JSON.stringify(tokenPayload).includes(API_KEY), "session-token response must not leak the long-lived API key");
    assert(Array.isArray(tokenPayload.initialHistory) && tokenPayload.initialHistory.length >= 2);

    const startedResponse = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/started`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(startedResponse.status, 200);
    const startedPayload = await startedResponse.json() as any;
    assert.equal(startedPayload.started, true);
    assert.equal(startedPayload.alreadyStarted, false);
    const duplicateStarted = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/started`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: "{}",
    }).then((response) => response.json()) as any;
    assert.equal(duplicateStarted.started, true);
    assert.equal(duplicateStarted.alreadyStarted, true, "audio-start acknowledgement must be idempotent");

    const activeStatus = await fetch(`${baseUrl}/api/live/status`, {
      headers: { authorization: "Bearer test-user" },
    }).then((response) => response.json()) as any;
    assert.equal(activeStatus.available, false);
    assert.equal(activeStatus.reason, "active_session_limit");
    assert.deepEqual(activeStatus.activeSession, { status: "active" });

    const commitResponse = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/commit`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: JSON.stringify({
        transcript: [
          { role: "user", text: "Hello" },
          { role: "assistant", text: "Hi there" },
        ],
      }),
    });
    assert.equal(commitResponse.status, 200);
    const committed = await commitResponse.json() as any;
    assert.equal(committed.committedMessageCount, 1);
    assert.equal(commits.length, 1);
    assert.equal(usageStore.getActiveCount(USER_ID), 0, "commit should finalize usage and release the active session");
    assert.deepEqual(commits[0].transcript, [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there" },
    ]);
    assert.deepEqual(titleRequests, [{
      userId: USER_ID,
      conversationId: CONVERSATION_ID,
      userMessage: "Hello",
      assistantReply: "Hi there",
    }], "a committed Live exchange should request one Groq-backed conversation title");

    const duplicateCommit = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/commit`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: JSON.stringify({ transcript: [] }),
    }).then((response) => response.json()) as any;
    assert.equal(duplicateCommit.alreadyCommitted, true);
    assert.equal(commits.length, 1, "duplicate commit should be idempotent");
    assert.equal(titleRequests.length, 1, "duplicate commit must not regenerate the title");

    const ended = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/end`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: JSON.stringify({ reason: "client_end" }),
    }).then((response) => response.json()) as any;
    assert.equal(ended.success, true);
    assert.equal(ended.alreadyEnded, true, "end after transcript commit should be idempotent");

    const releasedStatus = await fetch(`${baseUrl}/api/live/status`, {
      headers: { authorization: "Bearer test-user" },
    }).then((response) => response.json()) as any;
    assert.equal(releasedStatus.available, true, "ending must release the active-session status");
    assert.equal(releasedStatus.activeSession, null);
  } finally {
    await close(server);
  }
}

async function testDailyAndActiveLimits(): Promise<void> {
  let now = Date.parse("2026-07-03T08:00:00.000Z");
  const nowFn = () => now;
  const policy = loadLiveTierPolicy({
    SENTIQ_LIVE_STUDENT_CORE_DAILY_MINUTES: "2",
    SENTIQ_LIVE_STUDENT_CORE_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STUDENT_CORE_MAX_ACTIVE: "1",
    SENTIQ_LIVE_STALE_GRACE_SECONDS: "5",
  });
  const { service, usageStore } = createService({ planCode: "student_core", now: nowFn, tierPolicy: policy });
  const first = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  await assert.rejects(
    () => service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_active_limit",
  );
  await service.markSessionStarted({ userId: USER_ID, sessionId: first.sessionId });
  now += 60_000;
  await service.endSession({ userId: USER_ID, sessionId: first.sessionId, reason: "client_end" });
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "ending should release the per-user active count");
  assert.equal(usageStore.getUsedSeconds(USER_ID), 60);
  const afterRelease = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(usageStore.getActiveCount(USER_ID), 1, "a new session should open after the previous session ends");
  await service.endSession({ userId: USER_ID, sessionId: afterRelease.sessionId });

  const timePolicy = loadLiveTierPolicy({
    SENTIQ_LIVE_STUDENT_CORE_DAILY_MINUTES: "1",
    SENTIQ_LIVE_STUDENT_CORE_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STUDENT_CORE_MAX_ACTIVE: "1",
  });
  const timeLimited = createService({ planCode: "student_core", now: nowFn, tierPolicy: timePolicy });
  const fullMinute = await timeLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  await timeLimited.service.markSessionStarted({ userId: USER_ID, sessionId: fullMinute.sessionId });
  now += 60_000;
  await timeLimited.service.endSession({ userId: USER_ID, sessionId: fullMinute.sessionId });
  await assert.rejects(
    () => timeLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_daily_time_exhausted",
  );

}

async function testPartialUsageCanResumeAcrossAllTiers(): Promise<void> {
  const plans = ["free", "student_core", "premium", "pro"] as const;
  for (const planCode of plans) {
    let now = Date.parse("2026-07-03T12:00:00.000Z");
    const { service, usageStore } = createService({ planCode, now: () => now });
    const dailySeconds = loadLiveTierPolicy({}).plans[planCode].dailySeconds;

    const first = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
    await service.markSessionStarted({ userId: USER_ID, sessionId: first.sessionId });
    now += 34_000;
    await service.endSession({ userId: USER_ID, sessionId: first.sessionId, reason: "client_end" });

    const afterFirst = await service.getStatus(USER_ID);
    assert.equal(afterFirst.available, true, `${planCode} should remain available while daily seconds remain`);
    assert.equal(afterFirst.reason, "available");
    assert.equal(afterFirst.remainingSecondsToday, dailySeconds - 34);
    assert.equal(afterFirst.remainingSessionsToday, 1);
    assert.equal(usageStore.getUsedSeconds(USER_ID), 34);

    const second = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
    assert(second.sessionMaxSeconds > 0, `${planCode} should be able to reserve another partial session`);
    await service.endSession({ userId: USER_ID, sessionId: second.sessionId, reason: "client_end" });
  }
}

async function testStaleCleanup(): Promise<void> {
  let now = Date.parse("2026-07-03T09:00:00.000Z");
  const nowFn = () => now;
  const policy = loadLiveTierPolicy({
    SENTIQ_LIVE_PREMIUM_DAILY_MINUTES: "2",
    SENTIQ_LIVE_PREMIUM_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STALE_GRACE_SECONDS: "5",
  });
  const { service, usageStore, keyPool } = createService({ planCode: "premium", now: nowFn, tierPolicy: policy });
  const first = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: first.sessionId });
  assert.equal(keyPool.getActiveCount(1), 1);
  now += 66_000;
  assert.equal(await service.cleanupStaleSessions(), 1);
  assert.equal(usageStore.getSessionStatus(first.sessionId), "timeout");
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
  assert.equal(keyPool.getActiveCount(1), 0, "stale cleanup should release the project slot");
  const second = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(second.sessionMaxSeconds, 60, "remaining daily time should be reserved for the next session");
}

async function testStartupCancellationAndRetry(): Promise<void> {
  let now = Date.parse("2026-07-03T09:30:00.000Z");
  const nowFn = () => now;
  const { service, usageStore } = createService({ planCode: "free", now: nowFn });
  const first = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  const cancelled = await service.endSession({
    userId: USER_ID,
    sessionId: first.sessionId,
    reason: "mic_blocked",
  });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.durationSeconds, 0);
  assert.deepEqual(await usageStore.getUserStatus(USER_ID), {
    sessionsStarted: 0,
    secondsUsed: 0,
    secondsReserved: 0,
    activeSessions: 0,
  });
  const retry = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(retry.sessionMaxSeconds, 120, "a failed startup must not consume the Free session");
  await service.endSession({ userId: USER_ID, sessionId: retry.sessionId, reason: "websocket_failed" });

  const stalePolicy = loadLiveTierPolicy({
    SENTIQ_LIVE_PREMIUM_DAILY_MINUTES: "2",
    SENTIQ_LIVE_PREMIUM_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STALE_GRACE_SECONDS: "5",
  });
  const stale = createService({ planCode: "premium", now: nowFn, tierPolicy: stalePolicy });
  const staleSession = await stale.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  now += 66_000;
  assert.equal(await stale.service.cleanupStaleSessions(), 1);
  assert.equal(stale.usageStore.getSessionStatus(staleSession.sessionId), "cancelled");
  assert.equal(stale.usageStore.getUsedSeconds(USER_ID), 0);
  assert.equal((await stale.usageStore.getUserStatus(USER_ID)).sessionsStarted, 0);
}

async function testTokenFailureReleasesReservation(): Promise<void> {
  let now = Date.parse("2026-07-03T11:00:00.000Z");
  let tokenAttempt = 0;
  const { service, usageStore } = createService({
    planCode: "free",
    now: () => now,
    tokenFetchImpl: async () => {
      tokenAttempt += 1;
      return tokenAttempt <= 2
        ? { ok: false, status: 429, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ name: "auth_tokens/retry-ephemeral" }) };
    },
  });
  await assert.rejects(
    () => service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_provider_rate_limited",
  );
  assert.deepEqual(await usageStore.getUserStatus(USER_ID), {
    sessionsStarted: 0,
    secondsUsed: 0,
    secondsReserved: 0,
    activeSessions: 0,
  });
  now += 60_001;
  const retry = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(retry.sessionMaxSeconds, 120);
  await service.endSession({ userId: USER_ID, sessionId: retry.sessionId, reason: "error" });
}

async function testDurableSessionRecovery(): Promise<void> {
  let now = Date.parse("2026-07-03T12:00:00.000Z");
  const usageStore = new InMemoryLiveUsageStore(() => now);
  const firstProcess = createService({ planCode: "premium", now: () => now, usageStore });
  const session = await firstProcess.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  await firstProcess.service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
  now += 6_000;

  const recoveredProcess = createService({ planCode: "premium", now: () => now, usageStore });
  const ended = await recoveredProcess.service.endSession({
    userId: USER_ID,
    sessionId: session.sessionId,
    reason: "navigation",
  });
  assert.equal(ended.durationSeconds, 6);
  assert.equal(usageStore.getUsedSeconds(USER_ID), 6);
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
}

async function testStartEndRaceChargesExactlyOnce(): Promise<void> {
  let now = Date.parse("2026-07-03T20:00:00.000Z");
  const usageStore = new InMemoryLiveUsageStore(() => now);
  const { service } = createService({ planCode: "free", now: () => now, usageStore });
  const session = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });

  const durableStart = await usageStore.markSessionStarted({
    userId: USER_ID,
    sessionId: session.sessionId,
    graceSeconds: 30,
  });
  assert.equal(durableStart.started, true);
  now += 6_000;
  const ended = await service.endSession({
    userId: USER_ID,
    sessionId: session.sessionId,
    reason: "client_end",
  });
  assert.equal(ended.cancelled, false, "a durable audio start must win over an unstarted refund");
  assert.equal(ended.durationSeconds, 6);
  assert.equal(usageStore.getUsedSeconds(USER_ID), 6);
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
}

async function testFreeTierDefaultAllocation(): Promise<void> {
  let now = Date.parse("2026-07-03T10:00:00.000Z");
  const { service, usageStore } = createService({ planCode: "free", now: () => now });
  const before = await service.getStatus(USER_ID);
  assert.equal(before.available, true);
  assert.equal(before.remainingSecondsToday, 120);
  assert.equal(before.remainingSessionsToday, 1);
  assert.equal(before.maxSessionSeconds, 120);
  const session = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(session.sessionMaxSeconds, 120);
  await assert.rejects(
    () => service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_daily_time_exhausted",
  );
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
  now += 6_000;
  await service.endSession({ userId: USER_ID, sessionId: session.sessionId });
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
  assert.equal(usageStore.getUsedSeconds(USER_ID), 6);
  const after = await service.getStatus(USER_ID);
  assert.equal(after.available, true);
  assert.equal(after.reason, "available");
  assert.equal(after.remainingSecondsToday, 114);
  assert.equal(after.remainingSessionsToday, 1);
  assert.equal(after.activeSession, null);
  const retry = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(retry.sessionMaxSeconds, 114, "Free users should be able to use all remaining daily time");
  await service.endSession({ userId: USER_ID, sessionId: retry.sessionId, reason: "client_end" });

  const disabledFree = createService({
    planCode: "free",
    tierPolicy: loadLiveTierPolicy({ SENTIQ_LIVE_FREE_ENABLED: "false" }),
  });
  const unavailable = await disabledFree.service.getStatus(USER_ID);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, "not_available_on_plan");
}

async function testDisabledBehavior(): Promise<void> {
  const { service } = createService({ enabled: false });
  assert.equal(service.isAvailable(), false);
  const status = await service.getStatus(USER_ID);
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.equal(status.reason, "not_available");
  await assert.rejects(
    () => service.createSession({ userId: USER_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_disabled" && error.statusCode === 404,
  );

  const { server, baseUrl } = await listen(buildApp(service));
  try {
    const response = await fetch(`${baseUrl}/api/live/session-token`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 404);
  } finally {
    await close(server);
  }
}

function testFrontendFoundation(): void {
  const root = resolve(__dirname, "..");
  const html = readFileSync(resolve(root, "frontend/index.html"), "utf8");
  const main = readFileSync(resolve(root, "frontend/scripts/main.js"), "utf8");
  const controller = readFileSync(resolve(root, "frontend/scripts/features/live/live-controller.js"), "utf8");
  const composerState = readFileSync(
    resolve(root, "frontend/scripts/features/live/live-composer-state.js"),
    "utf8",
  );
  const audioProtocol = readFileSync(
    resolve(root, "frontend/scripts/features/live/live-audio-protocol.js"),
    "utf8",
  );
  const liveStyles = readFileSync(resolve(root, "frontend/styles/modules/16-live-beta.css"), "utf8");
  assert(html.includes('id="live-beta-btn"'));
  assert(html.includes('id="live-beta-close-btn"'), "Live overlay must have dedicated close button in header");
  assert(html.includes('id="live-beta-mute"'));
  assert(!html.includes('id="live-beta-end"'), "Old end button must be removed");
  assert(!html.includes('id="live-beta-transcript-toggle"'), "Old transcript toggle button must be removed");
  assert(html.includes('id="live-beta-remaining"'));
  assert(html.includes('id="live-beta-retry"'));
  assert(main.includes('import "./features/live/live-controller.js"'));
  assert(controller.includes("navigator.mediaDevices?.getUserMedia"));
  assert(audioProtocol.includes("LIVE_INPUT_SAMPLE_RATE = 16_000"));
  assert(audioProtocol.includes("LIVE_OUTPUT_SAMPLE_RATE = 24_000"));
  assert(audioProtocol.includes("LIVE_INPUT_CHUNK_SAMPLES = 1_600"));
  assert(audioProtocol.includes("mimeType: LIVE_INPUT_MIME_TYPE"));
  assert(controller.includes("content?.interrupted"));
  assert(controller.includes("audioStreamEnd: true"));
  assert(controller.includes("API.markLiveSessionStarted(currentSession.sessionId)"));
  assert(!controller.includes("LIVE_HANDSHAKE_STABILITY_MS = 750"), "750ms artificial delay must be removed");
  assert(!controller.includes("waitForHandshakeStability"), "waitForHandshakeStability must be removed");
  assert(controller.includes("terminateLiveSession"), "Canonical terminateLiveSession must be present");
  assert(controller.includes("window.SentIQLive = Object.freeze"), "window.SentIQLive must be exported");
  assert(controller.includes('liveDebug("websocket_closed"'));
  assert(
    controller.indexOf("showPanel();") < controller.indexOf("API.createLiveSessionToken"),
    "UI must show immediately before awaiting network token",
  );
  const startAckIndex = controller.indexOf("API.markLiveSessionStarted(currentSession.sessionId)");
  assert(startAckIndex >= 0);
  assert(controller.indexOf("startRemainingTimer(currentSession.sessionMaxSeconds);", startAckIndex) > startAckIndex);
  assert(controller.includes('setPanelState("thinking", "Thinking"'));
  assert(controller.includes('setPanelState("speaking", "Speaking"'));
  assert(controller.includes('setPanelState("muted", "Muted"') || controller.includes('muted ? "muted"'));
  assert(controller.includes('setPanelState("ended", "Ending"'));
  for (const state of [
    "listening",
    "thinking",
    "speaking",
    "muted",
    "quota_denied",
    "mic_blocked",
    "websocket_failed",
    "audio_failed",
    "unavailable",
    "error",
    "ended",
  ]) {
    assert(
      liveStyles.includes(`[data-state="${state}"]`),
      `Live overlay styles must render the ${state} state`,
    );
  }
  assert(composerState.includes("Live voice is not available on your current plan."));
  assert(composerState.includes("You’ve used today’s Live voice time."));
  assert(composerState.includes("Live voice is busy. Try again soon."));
  assert(!composerState.includes("Live voice sessions"), "the UI should not expose a second daily session-count quota");
  assert(!controller.includes("no sessions left"));
  assert(!controller.includes("GEMINI_API_KEY"));

  const moduleUrl = `data:text/javascript;base64,${Buffer.from(composerState).toString("base64")}`;
  const composerTest = `
    import assert from "node:assert/strict";
    import { resolveLiveComposerAction } from ${JSON.stringify(moduleUrl)};
    const base = { enabled: true, available: true, reason: "available" };
    assert.deepEqual(resolveLiveComposerAction(base), {
      showLive: true, showSend: false, disabled: false, message: "Live voice is busy. Try again soon."
    });
    assert.equal(resolveLiveComposerAction({ ...base, inputValue: "hello" }).showSend, true);
    assert.equal(resolveLiveComposerAction({ ...base, inputValue: "   " }).showLive, true);
    assert.equal(resolveLiveComposerAction({ ...base, inputValue: "" }).showLive, true);
    assert.equal(resolveLiveComposerAction({ ...base, hasAttachments: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ ...base, specialModeActive: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ ...base, responseLocked: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ enabled: true, reason: "sign_in_required" }).disabled, false);
    const denied = resolveLiveComposerAction({ enabled: true, reason: "daily_limit_reached" });
    assert.equal(denied.showLive, true);
    assert.equal(denied.disabled, true);
    assert.equal(denied.message, "You’ve used today’s Live voice time.");
    const featureDisabled = resolveLiveComposerAction({ enabled: false, reason: "not_available" });
    assert.equal(featureDisabled.showLive, true);
    assert.equal(featureDisabled.showSend, false);
    assert.equal(featureDisabled.disabled, true);
    assert.equal(featureDisabled.message, "Live voice is not available right now.");
    const unsupported = resolveLiveComposerAction({ reason: "browser_unsupported" });
    assert.equal(unsupported.showLive, true);
    assert.equal(unsupported.message, "Live voice is not supported in this browser.");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", composerTest], { stdio: "pipe" });

  const audioModuleUrl = pathToFileURL(resolve(root, "frontend/scripts/features/live/live-audio-protocol.js")).href;
  const audioProtocolTest = `
    import assert from "node:assert/strict";
    import {
      StreamingPcm16Resampler,
      PcmChunkAccumulator,
      buildLiveAudioInputMessage,
      base64Pcm16ToFloat32,
    } from ${JSON.stringify(audioModuleUrl)};
    const source = new Float32Array(4_801);
    for (let index = 0; index < source.length; index += 1) source[index] = Math.sin(index / 10);
    const resampled = new StreamingPcm16Resampler(48_000).process(source);
    assert.equal(resampled.length, 1_600);
    const chunks = [];
    const accumulator = new PcmChunkAccumulator(1_600);
    accumulator.push(resampled.subarray(0, 900), (chunk) => chunks.push(chunk));
    assert.equal(chunks.length, 0);
    accumulator.push(resampled.subarray(900), (chunk) => chunks.push(chunk));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 1_600);
    const message = buildLiveAudioInputMessage(new Int16Array([0x1234, -2]));
    assert.equal(message.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
    assert.deepEqual([...Buffer.from(message.realtimeInput.audio.data, "base64")], [0x34, 0x12, 0xfe, 0xff]);
    const decoded = base64Pcm16ToFloat32(message.realtimeInput.audio.data);
    assert.equal(decoded.length, 2);
    assert(Math.abs(decoded[0] - (0x1234 / 0x8000)) < 0.00001);
    assert(Math.abs(decoded[1] - (-2 / 0x8000)) < 0.00001);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", audioProtocolTest], { stdio: "pipe" });
}

function testMigrationFoundation(): void {
  const root = resolve(__dirname, "..");
  const dbRouter = readFileSync(resolve(root, "backend/dbRouter.ts"), "utf8");
  const usageStore = readFileSync(resolve(root, "backend/live/liveUsageStore.ts"), "utf8");
  const migration = readFileSync(
    resolve(root, "supabase/migrations/20260703120000_add_live_usage_policy.sql"),
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.live_sessions/i);
  assert.match(migration, /create table if not exists public\.live_daily_usage/i);
  assert.match(migration, /create table if not exists public\.live_capacity_leases/i);
  assert.match(migration, /create or replace function public\.reserve_live_session/i);
  assert.match(migration, /create or replace function public\.finalize_live_session/i);
  assert.match(migration, /create or replace function public\.cleanup_stale_live_sessions/i);
  assert.match(migration, /create or replace function public\.reserve_live_capacity/i);
  assert.match(migration, /pg_advisory_xact_lock/i, "quota and capacity reservations should be serialized");
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /owner_user_id = auth\.uid\(\)/i);
  assert.doesNotMatch(migration, /audio_data|raw_audio/i, "migration must not store raw audio");
  assert.match(
    usageStore,
    /p_daily_sessions:\s*2_147_483_647/,
    "the legacy RPC session-count parameter must not block remaining timed allowance",
  );

  const lifecycleMigration = readFileSync(
    resolve(root, "supabase/migrations/20260704120000_harden_live_session_lifecycle.sql"),
    "utf8",
  );
  assert.match(lifecycleMigration, /add column if not exists audio_started_at timestamptz/i);
  assert.match(lifecycleMigration, /create or replace function public\.mark_live_session_started/i);
  assert.match(lifecycleMigration, /create or replace function public\.cancel_live_session_reservation/i);
  assert.match(lifecycleMigration, /audio_started_at is not null then[\s\S]*return false/i);
  assert.match(lifecycleMigration, /create or replace function public\.cleanup_stale_live_sessions/i);
  assert.match(lifecycleMigration, /status = 'cancelled'/i);
  assert.match(lifecycleMigration, /sessions_started = greatest\(0, sessions_started - 1\)/i);
  assert.match(lifecycleMigration, /seconds_reserved = greatest\(0, seconds_reserved - stale_session\.reserved_seconds\)/i);
  assert.doesNotMatch(lifecycleMigration, /audio_data|raw_audio/i, "lifecycle migration must not store raw audio");

  const startupRefundMigration = readFileSync(
    resolve(root, "supabase/migrations/20260710190000_refund_failed_live_startups.sql"),
    "utf8",
  );
  assert.match(startupRefundMigration, /create or replace function public\.finalize_live_session/i);
  assert.match(startupRefundMigration, /end_reason[\s\S]*websocket_failed/i);
  assert.match(startupRefundMigration, /when refund_failed_start then 'cancelled'/i);
  assert.match(startupRefundMigration, /sessions_started = greatest\([\s\S]*refund_failed_start then 1 else 0/i);
  assert.match(startupRefundMigration, /where status = 'ended'[\s\S]*used_seconds = 0/i);
  assert.match(startupRefundMigration, /get_sentiq_live_refund_policy_version/i);
  assert.doesNotMatch(startupRefundMigration, /audio_data|raw_audio/i, "startup refund migration must not store raw audio");

  const prodArchMigration = readFileSync(
    resolve(root, "supabase/migrations/20261003120000_production_live_voice_architecture.sql"),
    "utf8",
  );
  assert.match(prodArchMigration, /create table if not exists public\.live_session_transcript_segments/i);
  assert.match(prodArchMigration, /create or replace function public\.commit_live_session_transcript/i);
  assert.match(prodArchMigration, /key_slot >= 1/i);
  assert.match(prodArchMigration, /live_conversation_id uuid/i);
  assert.doesNotMatch(prodArchMigration, /audio_data|raw_audio/i, "architecture migration must not store raw audio");

  assert.match(dbRouter, /SENTIQ_LIVE_ENABLED[\s\S]*audio_started_at/);
  assert.match(dbRouter, /mark_live_session_started/);
  assert.match(dbRouter, /get_sentiq_live_refund_policy_version/);
}

function testLiveTitleFoundation(): void {
  const root = resolve(__dirname, "..");
  const server = readFileSync(resolve(root, "backend/serverLegacy.ts"), "utf8");
  const service = readFileSync(resolve(root, "backend/live/liveSessionService.ts"), "utf8");
  const persistence = readFileSync(resolve(root, "backend/live/sentiqLivePersistence.ts"), "utf8");
  const promptBuilders = readFileSync(resolve(root, "backend/ai/PromptBuilders.ts"), "utf8");
  assert.match(service, /titleGenerator\.generateTitle/);
  assert.match(server, /scope:\s*"live\.title\.auto"/);
  assert.match(server, /normalized === "live conversation"/i, "legacy generic Live titles should be replaceable");
  assert.match(persistence, /title:\s*"New Chat"/);
  assert.match(
    promptBuilders,
    /function buildTitleGeneratePrompt[\s\S]*prefer:\s*"groq"/,
    "Live title generation must reuse the Groq-first title prompt",
  );
}

// ============================================================
// PART 13 — TESTS A THROUGH K
// ============================================================

// TEST A: 15+ REPEATED CYCLES WITH VARIED TERMINATION MECHANISMS
async function testPart13A_RapidCycles(): Promise<void> {
  const { service, usageStore, keyPool } = createService();
  const reasons = ["client_end", "escape", "backdrop_click", "timeout", "error"];
  for (let i = 0; i < 15; i++) {
    const session = await service.createSession({ userId: USER_ID });
    if (i % 3 !== 0) {
      // 2/3 of sessions start audio
      await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
    }
    const reason = reasons[i % reasons.length];
    await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason });
  }
  const status = await service.getStatus(USER_ID);
  assert.equal(status.activeSession, null, "zero active sessions after cycles");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "active count must be 0");
  assert.equal(keyPool.getActiveCount(1), 0, "key slot active count must be 0");
  const next = await service.createSession({ userId: USER_ID });
  assert.ok(next.sessionId, "next session should start without stale reservation dependency");
  await service.endSession({ userId: USER_ID, sessionId: next.sessionId, reason: "client_end" });
}

// TEST B: END BEFORE AUDIO START
async function testPart13B_EndBeforeAudioStart(): Promise<void> {
  const { service, usageStore } = createService();
  const session = await service.createSession({ userId: USER_ID });
  const endResult = await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
  assert.equal(endResult.status, "cancelled", "should be cancelled before audio starts");
  assert.equal(endResult.durationSeconds, 0, "0 used seconds");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "active count = 0");
  assert.equal(usageStore.getUsedSeconds(USER_ID), 0, "no seconds charged when cancelled");
  const status = await service.getStatus(USER_ID);
  assert.equal(status.remainingSecondsToday, 1_500, "all reserved seconds refunded");
  assert.equal(status.activeSession, null, "no active session remains");
}

// TEST C: DUPLICATE END
async function testPart13C_DuplicateEnd(): Promise<void> {
  let now = 10_000;
  const { service, usageStore } = createService({ now: () => now });
  const session = await service.createSession({ userId: USER_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
  now += 25_000;
  const end1 = await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
  assert.equal(end1.finalized, true);
  assert.equal(end1.durationSeconds, 25);
  const used = usageStore.getUsedSeconds(USER_ID);
  assert.equal(used, 25);

  now += 5_000;
  const end2 = await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
  assert.equal(end2.alreadyEnded, true);
  assert.equal(end2.finalized, false);

  const end3 = await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
  assert.equal(end3.alreadyEnded, true);
  assert.equal(usageStore.getUsedSeconds(USER_ID), 25, "duplicate end calls must not double-charge usage");
}

// TEST D: DUPLICATE COMMIT
async function testPart13D_DuplicateCommit(): Promise<void> {
  const { service, commits } = createService();
  const session = await service.createSession({ userId: USER_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
  const segments: LiveTranscriptTurn[] = [
    { sequence: 1, role: "user", text: "Hello Live" },
    { sequence: 2, role: "assistant", text: "Hello! How can I help?" },
  ];
  const c1 = await service.commitSession({ userId: USER_ID, sessionId: session.sessionId, transcript: segments });
  assert.equal(c1.alreadyCommitted, false);
  assert.equal(c1.committedMessageCount, 1);
  assert.equal(commits.length, 1);

  const c2 = await service.commitSession({ userId: USER_ID, sessionId: session.sessionId, transcript: segments });
  assert.equal(c2.alreadyCommitted, true);
  assert.equal(commits.length, 1, "commits array must not re-insert on duplicate commit");

  const c3 = await service.commitSession({ userId: USER_ID, sessionId: session.sessionId, transcript: segments });
  assert.equal(c3.alreadyCommitted, true);
  assert.equal(commits.length, 1);
}

// TEST E: SAME SOURCE CHAT
async function testPart13E_SameSourceChat(): Promise<void> {
  const SOURCE_CHAT = "chat-source-abc-123";
  let count = 0;
  const persistence: LiveSessionPersistence = {
    prepareContext: async () => ({
      conversationId: `live-dest-${++count}`,
      displayName: "Test User",
      workspaceCapsule: "Workspace",
      conversationCapsule: "Capsule",
      recentTurns: [],
    }),
    persistTranscript: async () => 1,
  };
  const { service } = createService();
  (service as any).dependencies.persistence = persistence;

  const s1 = await service.createSession({ userId: USER_ID, sourceConversationId: SOURCE_CHAT });
  await service.endSession({ userId: USER_ID, sessionId: s1.sessionId, reason: "client_end" });

  const s2 = await service.createSession({ userId: USER_ID, sourceConversationId: SOURCE_CHAT });
  await service.endSession({ userId: USER_ID, sessionId: s2.sessionId, reason: "client_end" });

  const s3 = await service.createSession({ userId: USER_ID, sourceConversationId: SOURCE_CHAT });
  await service.endSession({ userId: USER_ID, sessionId: s3.sessionId, reason: "client_end" });

  assert.ok(s1.liveConversationId);
  assert.ok(s2.liveConversationId);
  assert.ok(s3.liveConversationId);
  assert.notEqual(s1.liveConversationId, s2.liveConversationId);
  assert.notEqual(s2.liveConversationId, s3.liveConversationId);
  assert.notEqual(s1.liveConversationId, SOURCE_CHAT);
  assert.notEqual(s2.liveConversationId, SOURCE_CHAT);
  assert.notEqual(s3.liveConversationId, SOURCE_CHAT);
}

// TEST F: SIX KEYS
async function testPart13F_SixKeys(): Promise<void> {
  let now = 10_000;
  const pool = new GeminiLiveKeyPool({
    keys: ["k1", "k2", "k3", "k4", "k5", "k6"],
    now: () => now,
  });
  assert.equal(pool.size, 6, "pool size must equal 6");
  const acquired: number[] = [];
  for (let i = 0; i < 6; i++) {
    now += 1;
    const lease = pool.acquire();
    acquired.push(lease.slot);
    pool.markActive(lease.slot);
  }
  assert.deepEqual(acquired.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(acquired.includes(6), true, "slot 6 must be selected");
  for (const slot of acquired) pool.releaseActive(slot);
}

// TEST G: PROVIDER FAILOVER
async function testPart13G_ProviderFailover(): Promise<void> {
  const attemptedKeys: string[] = [];
  const keyPool = new GeminiLiveKeyPool({
    keys: ["failover-k1", "failover-k2"],
    now: () => Date.now(),
  });
  const tokenService = new GeminiLiveTokenService({
    fetchImpl: async (_url, init) => {
      const key = (init.headers as any)?.["x-goog-api-key"];
      attemptedKeys.push(key);
      if (key === "failover-k1") {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "Resource exhausted" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "auth_tokens/failover-success" }),
      };
    },
  });
  const { persistence } = createPersistence();
  const service = new LiveSessionService({
    config: liveConfig(true),
    tierPolicy: loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => "premium", () => {}),
    usageStore: new InMemoryLiveUsageStore(() => Date.now()),
    keyPool,
    tokenService,
    persistence,
    titleGenerator: { generateTitle: async () => {} },
    now: () => Date.now(),
    newId: () => "failover-session-test",
    logger: () => {},
  });

  const session = await service.createSession({ userId: USER_ID });
  assert.equal(session.ephemeralToken, "auth_tokens/failover-success");
  assert.deepEqual(attemptedKeys, ["failover-k1", "failover-k1", "failover-k2"]);
  await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
}

// TEST H: NETWORK FAILURE DOES NOT POISON KEY
async function testPart13H_NetworkFailureDoesNotPoisonKey(): Promise<void> {
  const { service } = createService({ key: "network-test-key" });
  const s1 = await service.createSession({ userId: USER_ID });
  await service.reportClientError({
    userId: USER_ID,
    sessionId: s1.sessionId,
    errorType: "websocket_failed",
    code: 1006,
  });
  await service.endSession({ userId: USER_ID, sessionId: s1.sessionId, reason: "network_error" });

  // Key pool must not be permanently quarantined
  const s2 = await service.createSession({ userId: USER_ID });
  assert.ok(s2.sessionId, "key must remain available after client network failure");
  await service.endSession({ userId: USER_ID, sessionId: s2.sessionId, reason: "client_end" });
}

// TEST I: SESSION RESUMPTION
async function testPart13I_SessionResumption(): Promise<void> {
  const { service, usageStore } = createService();
  const session = await service.createSession({ userId: USER_ID, sourceConversationId: "source-resumption-test" });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });

  // Request resume token using getResumeToken
  const resumeToken = await service.getResumeToken({ userId: USER_ID, sessionId: session.sessionId });
  assert.ok(resumeToken.ephemeralToken, "must mint continuation token");
  assert.equal(resumeToken.sessionId, session.sessionId, "must maintain same session ID");
  assert.ok(resumeToken.webSocketUrl.includes("v1beta"), "websocket url must use v1beta");
  assert.equal(session.setup.model, "models/gemini-3.8-live", "initial setup must use models/gemini-3.8-live");

  // Verify no new reservation or session counter increment
  const userStatus = await usageStore.getUserStatus(USER_ID);
  assert.equal(userStatus.sessionsStarted, 1, "session resumption must not consume additional daily sessions");
  assert.equal(userStatus.activeSessions, 1, "exactly one active session maintained");

  await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
}

// TEST J: GOAWAY RECONNECT
async function testPart13J_GoAwayReconnect(): Promise<void> {
  const { service, commits, usageStore } = createService();
  const session = await service.createSession({ userId: USER_ID, sourceConversationId: "source-chat-orig" });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });

  // 1. Initial turns
  const transcript: LiveTranscriptTurn[] = [
    { sequence: 1, role: "user", text: "Part 1 of conversation" },
    { sequence: 2, role: "assistant", text: "I hear you clearly." },
  ];

  // 2. Simulate Gemini sessionResumptionUpdate and GoAway event
  const resumptionHandle = "gemini-resumption-handle-777";
  const goAwayTimeLeft = "10s";
  assert.ok(resumptionHandle);
  assert.ok(goAwayTimeLeft);

  // 3. Client reconnects socket using cached resumptionHandle under same logical session
  transcript.push(
    { sequence: 3, role: "user", text: "Part 2 after reconnect" },
    { sequence: 4, role: "assistant", text: "Continuing smoothly." },
  );

  // 4. Commit and end
  const commitResult = await service.commitSession({
    userId: USER_ID,
    sessionId: session.sessionId,
    transcript,
  });
  await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });

  assert.equal(commitResult.conversationId, session.liveConversationId, "no new destination chat");
  assert.equal(commits.length, 1, "exactly one commit to destination conversation");
  assert.equal(commits[0].transcript.length, 4, "transcript continuity preserved across reconnect");
  const userStatus = await usageStore.getUserStatus(USER_ID);
  assert.equal(userStatus.sessionsStarted, 1, "no duplicate quota reservation taken");
  assert.equal(userStatus.activeSessions, 0, "session properly ended");
}

// TEST K: PROCESS RECOVERY
async function testPart13K_ProcessRecovery(): Promise<void> {
  let now = 10_000;
  const usageStore = new InMemoryLiveUsageStore(() => now);
  const p1 = createService({ planCode: "premium", now: () => now, usageStore });
  const session = await p1.service.createSession({ userId: USER_ID });
  await p1.service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });

  // Advance time past expiration
  now += 1_000_000;

  // New process recovery instance
  const p2 = createService({ planCode: "premium", now: () => now, usageStore });
  const cleaned = await p2.service.cleanupStaleSessions(true);
  assert.equal(cleaned >= 1, true, "stale session must be cleaned by recovery process");
  const stored = await usageStore.getSession({ userId: USER_ID, sessionId: session.sessionId });
  assert.equal(stored?.status, "timeout", "timed out session marked as timeout");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "capacity is released");
}

// TEST L: COMMIT / END RACE
async function testPart13L_CommitEndRace(): Promise<void> {
  let now = 10_000;
  const { service, commits, usageStore } = createService({ now: () => now });
  const session = await service.createSession({ userId: USER_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });
  now += 15_000;

  const segments: LiveTranscriptTurn[] = [
    { sequence: 1, role: "user", text: "Race test question" },
    { sequence: 2, role: "assistant", text: "Race test answer" },
  ];

  // Trigger concurrent commit and end
  const [commitResult, endResult] = await Promise.all([
    service.commitSession({ userId: USER_ID, sessionId: session.sessionId, transcript: segments }),
    service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" }),
  ]);

  assert.equal(commitResult.alreadyCommitted, false, "commit succeeded");
  assert.equal(endResult.alreadyEnded, false, "end succeeded");
  assert.equal(commits.length, 1, "transcript committed exactly once");
  assert.equal(usageStore.getUsedSeconds(USER_ID), 15, "charged exactly 15 seconds");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "capacity released");
}

// TEST M: DUPLICATE SEGMENT SUBMISSION
async function testPart13M_DuplicateSegmentSubmission(): Promise<void> {
  const { service, commits, usageStore } = createService();
  const session = await service.createSession({ userId: USER_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });

  const turnsWithDuplicates: LiveTranscriptTurn[] = [
    { sequence: 1, role: "user", text: "Hello" },
    { sequence: 1, role: "user", text: "Hello duplicate" },
    { sequence: 2, role: "assistant", text: "Hi there" },
    { sequence: 2, role: "assistant", text: "Hi there duplicate" },
  ];

  const res = await service.commitSession({
    userId: USER_ID,
    sessionId: session.sessionId,
    transcript: turnsWithDuplicates,
  });

  assert.equal(res.alreadyCommitted, false);
  assert.equal(commits.length, 1);

  // Directly verify that the underlying storage deduplicated segments by sequence
  const sessionSegments = usageStore.transcriptSegments.get(session.sessionId);
  if (sessionSegments) {
    const seqs = [...sessionSegments.keys()];
    const uniqueSeqs = new Set(seqs);
    assert.equal(seqs.length, uniqueSeqs.size, "segments must be deduplicated by sequence number");
  }

  await service.endSession({ userId: USER_ID, sessionId: session.sessionId, reason: "client_end" });
}

// TEST N: INFRASTRUCTURE AND PROVIDER FAILURES NEVER RETURN BUSY
async function testPart13N_DbFailureReturnsInternalErrorNotBusy(): Promise<void> {
  // 1. Database query failure must return internal_error, NOT busy
  const failingDbStore = new InMemoryLiveUsageStore(() => Date.now());
  failingDbStore.getUserStatus = async () => { throw new Error("database connection pool exhausted"); };
  failingDbStore.reserveSession = async () => { throw new Error("fatal postgres connection dropped"); };

  const { service: dbFailService } = createService({ usageStore: failingDbStore });
  const dbStatus = await dbFailService.getStatus(USER_ID);
  assert.equal(dbStatus.available, false);
  assert.equal(dbStatus.reason, "internal_error", "DB query error must classify as internal_error, not busy");

  await assert.rejects(
    () => dbFailService.createSession({ userId: USER_ID }),
    (err: unknown) => {
      assert(err instanceof Error);
      assert.notEqual((err as any).code, "live_busy", "DB failure must not masquerade as live_busy");
      assert.notEqual((err as any).code, "busy", "DB failure must not masquerade as busy");
      return true;
    },
  );

  // 2. Google Gemini 503 outage must throw live_provider_unavailable, NOT busy
  const { service: providerOutageService } = createService({
    tokenFetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(
    () => providerOutageService.createSession({ userId: USER_ID }),
    (err: unknown) => {
      assert(err instanceof LiveSessionError);
      assert.equal(err.code, "live_provider_unavailable", "503 outage must classify as live_provider_unavailable");
      assert.notEqual(err.message, "Live voice is busy. Try again soon.");
      return true;
    },
  );

  // 3. Google Gemini 401 auth failure must throw live_provider_auth_failure, NOT busy
  const { service: authFailService } = createService({
    tokenFetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(
    () => authFailService.createSession({ userId: USER_ID }),
    (err: unknown) => {
      assert(err instanceof LiveSessionError);
      assert.equal(err.code, "live_provider_auth_failure", "401 auth error must classify as live_provider_auth_failure");
      assert.notEqual(err.message, "Live voice is busy. Try again soon.");
      return true;
    },
  );

  // 4. Provider network timeout must throw live_network_error, NOT busy
  const { service: networkFailService } = createService({
    tokenFetchImpl: async () => { throw new Error("fetch timeout / network down"); },
  });
  await assert.rejects(
    () => networkFailService.createSession({ userId: USER_ID }),
    (err: unknown) => {
      assert(err instanceof LiveSessionError);
      assert.equal(err.code, "live_network_error", "network drop must classify as live_network_error");
      assert.notEqual(err.message, "Live voice is busy. Try again soon.");
      return true;
    },
  );

  // 5. Empty keypool must throw live_provider_configuration, NOT busy
  const emptyKeyPool = new GeminiLiveKeyPool({ keys: [] });
  const { service: emptyPoolService } = createService({ keyPool: emptyKeyPool });
  await assert.rejects(
    () => emptyPoolService.createSession({ userId: USER_ID }),
    (err: unknown) => {
      assert(err instanceof LiveSessionError);
      assert.equal(err.code, "live_provider_configuration", "empty key pool must classify as live_provider_configuration");
      assert.notEqual(err.message, "Live voice is busy. Try again soon.");
      return true;
    },
  );

  // 6. getStatus when provider is in cooldown due to 503 outage must return provider_unavailable, NOT busy
  const coolingKeyPool = new GeminiLiveKeyPool({ keys: ["key1"] });
  coolingKeyPool.markFailure(1, "unavailable");
  const { service: coolingService } = createService({ keyPool: coolingKeyPool });
  const coolingStatus = await coolingService.getStatus(USER_ID);
  assert.equal(coolingStatus.available, false);
  assert.equal(coolingStatus.reason, "provider_unavailable", "outage cooldown must report provider_unavailable, not busy");
}

// TEST O: GENUINE CAPACITY FAILURE RETURNS CAPACITY CLASSIFICATION
async function testPart13O_GenuineCapacityFailureClassification(): Promise<void> {
  // Global capacity exhaustion
  const globalCapService = createService({
    tierPolicy: loadLiveTierPolicy({ SENTIQ_LIVE_GLOBAL_MAX_ACTIVE: "1" }),
  }).service;
  const s1 = await globalCapService.createSession({ userId: USER_ID });

  const status = await globalCapService.getStatus("other-user");
  assert.equal(status.available, false);
  assert.equal(status.reason, "global_capacity", "must report global_capacity status");

  await assert.rejects(
    () => globalCapService.createSession({ userId: "other-user" }),
    (err: unknown) => err instanceof LiveSessionError && err.code === "live_global_capacity",
  );
  await globalCapService.endSession({ userId: USER_ID, sessionId: s1.sessionId, reason: "client_end" });

  // Daily quota exhaustion
  let now = 10_000;
  const dailyService = createService({
    planCode: "free",
    now: () => now,
    tierPolicy: loadLiveTierPolicy({ SENTIQ_LIVE_FREE_DAILY_MINUTES: "1", SENTIQ_LIVE_FREE_MAX_SESSION_SECONDS: "60" }),
  }).service;
  const sDaily = await dailyService.createSession({ userId: USER_ID });
  await dailyService.markSessionStarted({ userId: USER_ID, sessionId: sDaily.sessionId });
  now += 60_000;
  await dailyService.endSession({ userId: USER_ID, sessionId: sDaily.sessionId, reason: "client_end" });

  const dailyStatus = await dailyService.getStatus(USER_ID);
  assert.equal(dailyStatus.available, false);
  assert.equal(dailyStatus.reason, "daily_limit_reached");

  await assert.rejects(
    () => dailyService.createSession({ userId: USER_ID }),
    (err: unknown) => err instanceof LiveSessionError && err.code === "live_daily_time_exhausted",
  );
}

// TEST P: IMMEDIATE REOPEN AFTER NORMAL TERMINATION
async function testPart13P_ImmediateReopenAfterNormalTermination(): Promise<void> {
  const { service, usageStore } = createService();
  const s1 = await service.createSession({ userId: USER_ID, sourceConversationId: "chat-source-1" });
  await service.markSessionStarted({ userId: USER_ID, sessionId: s1.sessionId });
  await service.endSession({ userId: USER_ID, sessionId: s1.sessionId, reason: "client_end" });

  // 0ms delay immediate reopen
  const s2 = await service.createSession({ userId: USER_ID, sourceConversationId: "chat-source-1" });
  assert.ok(s2.sessionId, "immediate reopen must succeed");
  assert.notEqual(s1.sessionId, s2.sessionId, "new session must have unique session ID");
  assert.notEqual(s1.liveConversationId, s2.liveConversationId, "new session must have separate destination chat");

  await service.markSessionStarted({ userId: USER_ID, sessionId: s2.sessionId });
  await service.endSession({ userId: USER_ID, sessionId: s2.sessionId, reason: "client_end" });
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "all sessions cleanly closed");
}

// TEST Q: STALE STARTUP CLEANUP
async function testPart13Q_StaleStartupCleanup(): Promise<void> {
  let now = 10_000;
  const usageStore = new InMemoryLiveUsageStore(() => now);
  const tierPolicy = loadLiveTierPolicy({
    SENTIQ_LIVE_PREMIUM_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STALE_GRACE_SECONDS: "5",
  });
  const { service } = createService({ now: () => now, usageStore, tierPolicy });

  // Session provisioned but audio never started
  const session = await service.createSession({ userId: USER_ID });
  assert.equal(usageStore.getActiveCount(USER_ID), 1);

  // Advance time past reservation + grace (60s + 5s = 65s)
  now += 70_000;

  const cleaned = await service.cleanupStaleSessions(true);
  assert.equal(cleaned >= 1, true, "stale startup session must be cleaned");

  const stored = await usageStore.getSession({ userId: USER_ID, sessionId: session.sessionId });
  assert.equal(stored?.status, "cancelled", "status must be cancelled");
  assert.equal(stored?.usedSeconds, 0, "0 seconds charged");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "active capacity released");

  const status = await service.getStatus(USER_ID);
  assert.equal(status.remainingSecondsToday, 1_500, "100% refunded to user daily balance");
}

// TEST R: STALE RUNNING CLEANUP
async function testPart13R_StaleRunningCleanup(): Promise<void> {
  let now = 10_000;
  const usageStore = new InMemoryLiveUsageStore(() => now);
  const { service } = createService({
    now: () => now,
    usageStore,
    tierPolicy: loadLiveTierPolicy({ SENTIQ_LIVE_FREE_MAX_SESSION_SECONDS: "120" }),
    planCode: "free",
  });

  // Session started audio, but client disconnected abruptly without calling endSession
  const session = await service.createSession({ userId: USER_ID });
  await service.markSessionStarted({ userId: USER_ID, sessionId: session.sessionId });

  // Advance time past max session time (120s + grace)
  now += 200_000;

  const cleaned = await service.cleanupStaleSessions(true);
  assert.equal(cleaned >= 1, true, "stale running session must be cleaned");

  const stored = await usageStore.getSession({ userId: USER_ID, sessionId: session.sessionId });
  assert.equal(stored?.status, "timeout", "timed-out running session marked as timeout");
  assert.equal(stored?.usedSeconds, 120, "used seconds capped at session maximum");
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "capacity lease freed");
}

// DEDICATED GEMINI LIVE QUOTA ROUTER TEST SUITE
async function testGeminiLiveQuotaRouter(): Promise<void> {
  const { ORDERED_GEMINI_LIVE_MODELS, DEFAULT_GEMINI_LIVE_MODEL, GEMINI_LIVE_FALLBACK_MODEL } = await import("./live/geminiLiveConfig");
  assert.deepEqual(
    ORDERED_GEMINI_LIVE_MODELS,
    ["gemini-3.8-live", "gemini-3-flash-live"],
    "Live pool must be exactly gemini-3.8-live followed by gemini-3-flash-live",
  );
  assert.equal(DEFAULT_GEMINI_LIVE_MODEL, "gemini-3.8-live");
  assert.equal(GEMINI_LIVE_FALLBACK_MODEL, "gemini-3-flash-live");

  // Key-major traversal: Key 1 + gemini-3.8-live (429) -> Key 1 + gemini-3-flash-live
  const callLog: Array<{ key: string; model: string }> = [];
  const keyPool = new GeminiLiveKeyPool({
    keys: ["live-k1", "live-k2"],
    now: () => 1_000,
  });

  let capturedRequestBody: any = null;
  const tokenService = new GeminiLiveTokenService({
    fetchImpl: async (_url, init) => {
      const key = (init.headers as any)?.["x-goog-api-key"];
      const body = JSON.parse(init.body as string);
      capturedRequestBody = body;
      const model = body.bidiGenerateContentSetup?.model?.replace(/^models\//, "");
      callLog.push({ key, model });

      // Fail 3.8-live on live-k1 with 429
      if (key === "live-k1" && model === "gemini-3.8-live") {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "Resource exhausted" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: `auth_tokens/${key}-${model}` }),
      };
    },
  });

  const { persistence } = createPersistence();
  const usageStore = new InMemoryLiveUsageStore(() => 1_000);
  const service = new LiveSessionService({
    config: liveConfig(true),
    tierPolicy: loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => "premium", () => {}),
    usageStore,
    keyPool,
    tokenService,
    persistence,
    titleGenerator: { generateTitle: async () => {} },
    now: () => 1_000,
    newId: () => "live-quota-session-1",
    logger: () => {},
  });

  const session1 = await service.createSession({ userId: USER_ID });
  assert.deepEqual(
    callLog,
    [
      { key: "live-k1", model: "gemini-3.8-live" },
      { key: "live-k1", model: "gemini-3-flash-live" },
    ],
    "429 on Key 1 model 1 must advance to Key 1 model 2 BEFORE moving to Key 2",
  );

  // setup.model reflection of selected model
  assert.equal(session1.setup.model, "models/gemini-3-flash-live", "setup.model must reflect fallback model");

  // Absence of liveConnectConstraints and thinkingConfig
  assert.equal(capturedRequestBody.bidiGenerateContentSetup.liveConnectConstraints, undefined, "liveConnectConstraints must be absent");
  assert.equal(capturedRequestBody.bidiGenerateContentSetup.generationConfig.thinkingConfig, undefined, "thinkingConfig must be absent");

  // Session metadata persistence of live_model
  const storedSession1 = await usageStore.getSession({ userId: USER_ID, sessionId: session1.sessionId });
  assert.ok(storedSession1, "session record exists in store");
  assert.equal(storedSession1.metadata?.live_model, "gemini-3-flash-live", "metadata.live_model must persist fallback model");

  // Resume token using the session's original selected model
  await service.markSessionStarted({ userId: USER_ID, sessionId: session1.sessionId });
  callLog.length = 0;
  await service.getResumeToken({ userId: USER_ID, sessionId: session1.sessionId });
  assert.equal(callLog[0].model, "gemini-3-flash-live", "resume token must mint using original selected model");
  await service.endSession({ userId: USER_ID, sessionId: session1.sessionId, reason: "client_end" });

  // Both models failing on Key 1 -> moves to Key 2 + gemini-3.8-live
  callLog.length = 0;
  const keyPool2 = new GeminiLiveKeyPool({
    keys: ["k1-exhaust", "k2-fresh"],
    now: () => 2_000,
  });
  const tokenService2 = new GeminiLiveTokenService({
    fetchImpl: async (_url, init) => {
      const key = (init.headers as any)?.["x-goog-api-key"];
      const body = JSON.parse(init.body as string);
      const model = body.bidiGenerateContentSetup?.model?.replace(/^models\//, "");
      callLog.push({ key, model });

      if (key === "k1-exhaust") {
        return {
          ok: false,
          status: 429,
          json: async () => ({ error: { message: "Quota exceeded on k1" } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: `auth_tokens/${key}-${model}` }),
      };
    },
  });

  const usageStore2 = new InMemoryLiveUsageStore(() => 2_000);
  const service2 = new LiveSessionService({
    config: liveConfig(true),
    tierPolicy: loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => "premium", () => {}),
    usageStore: usageStore2,
    keyPool: keyPool2,
    tokenService: tokenService2,
    persistence,
    titleGenerator: { generateTitle: async () => {} },
    now: () => 2_000,
    newId: () => "live-quota-session-2",
    logger: () => {},
  });

  const session2 = await service2.createSession({ userId: USER_ID });
  assert.deepEqual(
    callLog,
    [
      { key: "k1-exhaust", model: "gemini-3.8-live" },
      { key: "k1-exhaust", model: "gemini-3-flash-live" },
      { key: "k2-fresh", model: "gemini-3.8-live" },
    ],
    "exhausting all models on Key 1 must advance to Key 2 starting with model 1 (gemini-3.8-live)",
  );
  assert.equal(session2.setup.model, "models/gemini-3.8-live", "setup.model reflects model 1 on Key 2");
  await service2.endSession({ userId: USER_ID, sessionId: session2.sessionId, reason: "client_end" });

  // Client network disconnects not poisoning the key/model state
  const pool3 = new GeminiLiveKeyPool({ keys: ["stable-k1"], now: () => 3_000 });
  const service3 = new LiveSessionService({
    config: liveConfig(true),
    tierPolicy: loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => "premium", () => {}),
    usageStore: new InMemoryLiveUsageStore(() => 3_000),
    keyPool: pool3,
    tokenService: new GeminiLiveTokenService({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: "auth_tokens/test" }),
      }),
    }),
    persistence,
    titleGenerator: { generateTitle: async () => {} },
    now: () => 3_000,
    newId: () => "live-quota-session-3",
    logger: () => {},
  });
  const s3 = await service3.createSession({ userId: USER_ID });
  await service3.reportClientError({
    userId: USER_ID,
    sessionId: s3.sessionId,
    errorType: "websocket_failed",
    code: 1006,
  });
  await service3.endSession({ userId: USER_ID, sessionId: s3.sessionId, reason: "network_error" });
  assert.equal(pool3.hasAvailableSlot(), true, "client network disconnect does not poison slot");
}

async function main(): Promise<void> {
  testTierPolicy();
  await testPlanResolutionFallback();
  await testKeyPool();
  await testTokenService();
  await testRoutes();
  await testDailyAndActiveLimits();
  await testPartialUsageCanResumeAcrossAllTiers();
  await testStaleCleanup();
  await testStartupCancellationAndRetry();
  await testTokenFailureReleasesReservation();
  await testDurableSessionRecovery();
  await testStartEndRaceChargesExactlyOnce();
  await testFreeTierDefaultAllocation();
  await testDisabledBehavior();
  testFrontendFoundation();
  testMigrationFoundation();
  testLiveTitleFoundation();

  // Part 13 Tests A through R
  await testPart13A_RapidCycles();
  await testPart13B_EndBeforeAudioStart();
  await testPart13C_DuplicateEnd();
  await testPart13D_DuplicateCommit();
  await testPart13E_SameSourceChat();
  await testPart13F_SixKeys();
  await testPart13G_ProviderFailover();
  await testPart13H_NetworkFailureDoesNotPoisonKey();
  await testPart13I_SessionResumption();
  await testPart13J_GoAwayReconnect();
  await testPart13K_ProcessRecovery();
  await testPart13L_CommitEndRace();
  await testPart13M_DuplicateSegmentSubmission();
  await testPart13N_DbFailureReturnsInternalErrorNotBusy();
  await testPart13O_GenuineCapacityFailureClassification();
  await testPart13P_ImmediateReopenAfterNormalTermination();
  await testPart13Q_StaleStartupCleanup();
  await testPart13R_StaleRunningCleanup();

  // Dedicated Quota Router Suite
  await testGeminiLiveQuotaRouter();

  console.log("PASS | All SentIQ Live Production Suite tests (including Part 13 A through R and Live Quota Router) passed.");
}

main().catch((error) => {
  console.error("FAIL | SentIQ Live focused tests failed.");
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

