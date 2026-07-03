import assert from "assert/strict";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createServer, type Server } from "http";
import { resolve } from "path";
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
} from "./live/liveSessionService";
import { registerLiveRoutes } from "./live/liveRoutes";
import { loadLiveTierPolicy, type LiveTierPolicy } from "./live/liveTierPolicy";
import { LivePlanResolver } from "./live/livePlanResolver";
import type {
  LiveCapacityReservationResult,
  LiveFinalizeResult,
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
    SENTIQ_LIVE_MODEL: "gemini-3.1-flash-live-preview",
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
  assert.equal(defaults.plans.free.dailySessions, 1);
  assert.equal(defaults.plans.free.maxSessionSeconds, 120);
  assert.equal(defaults.plans.free.maxActiveSessions, 1);
  assert.equal(defaults.plans.student_core.dailySeconds, 480);
  assert.equal(defaults.plans.student_core.dailySessions, 3);
  assert.equal(defaults.plans.student_core.maxSessionSeconds, 300);
  assert.equal(defaults.plans.premium.dailySeconds, 1_500);
  assert.equal(defaults.plans.premium.dailySessions, 8);
  assert.equal(defaults.plans.pro.dailySeconds, 4_500);
  assert.equal(defaults.plans.pro.maxActiveSessions, 2);

  const invalid = loadLiveTierPolicy({
    SENTIQ_LIVE_STUDENT_CORE_DAILY_MINUTES: "-1",
    SENTIQ_LIVE_PREMIUM_DAILY_SESSIONS: "NaN",
    SENTIQ_LIVE_PRO_MAX_SESSION_SECONDS: "99999",
    SENTIQ_LIVE_PRO_MAX_ACTIVE: "0",
    SENTIQ_LIVE_GLOBAL_MAX_ACTIVE: "invalid",
  });
  assert.equal(invalid.plans.student_core.dailySeconds, 480);
  assert.equal(invalid.plans.premium.dailySessions, 8);
  assert.equal(invalid.plans.pro.maxSessionSeconds, 600);
  assert.equal(invalid.plans.pro.maxActiveSessions, 2);
  assert.equal(invalid.globalMaxActive, null);

  const configured = loadLiveTierPolicy({
    SENTIQ_LIVE_FREE_ENABLED: "true",
    SENTIQ_LIVE_FREE_DAILY_MINUTES: "2",
    SENTIQ_LIVE_FREE_DAILY_SESSIONS: "1",
    SENTIQ_LIVE_GLOBAL_MAX_ACTIVE: "25",
    SENTIQ_LIVE_PROJECT_MAX_ACTIVE: "7",
  });
  assert.equal(configured.plans.free.enabled, true);
  assert.equal(configured.plans.free.dailySeconds, 120);
  assert.equal(configured.plans.free.dailySessions, 1);
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
  assert.equal(capturedBody.bidiGenerateContentSetup.model, "models/gemini-3.1-flash-live-preview");
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.generationConfig.responseModalities, ["AUDIO"]);
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.tools, [{ googleSearch: {} }]);
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.inputAudioTranscription, {});
  assert.deepEqual(capturedBody.bidiGenerateContentSetup.outputAudioTranscription, {});
  assert(!initBodyContains(capturedBody, API_KEY), "the long-lived API key must not be embedded in the token body");

  const constrainedToken = await service.createToken({
    apiKey: API_KEY,
    config: loadGeminiLiveConfig({
      SENTIQ_LIVE_ENABLED: "true",
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
  const persistence: LiveSessionPersistence = {
    prepareContext: async () => ({
      conversationId: CONVERSATION_ID,
      displayName: "Test User",
      workspaceCapsule: "Workspace capsule",
      conversationCapsule: "Conversation capsule",
      recentTurns: [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
    }),
    persistTranscript: async (args) => {
      commits.push(args);
      return args.transcript.length > 0 || args.summary ? 1 : 0;
    },
  };
  return { persistence, commits };
}

type FakeSession = {
  userId: string;
  reservedSeconds: number;
  status: "provisioning" | "active" | "ended" | "timeout" | "cancelled";
  expiresAt: number;
  usedSeconds: number;
};

class InMemoryLiveUsageStore implements LiveUsageStore {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly usage = new Map<string, { sessions: number; used: number; reserved: number }>();
  private readonly capacity = new Map<string, { keySlot: number; expiresAt: number }>();

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

  async reserveSession(args: {
    userId: string;
    sessionId: string;
    planCode: any;
    dailySeconds: number;
    dailySessions: number;
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
    if (usage.sessions >= args.dailySessions) return { allowed: false, denialReason: "daily_sessions", ...base };
    const remaining = Math.max(0, args.dailySeconds - usage.used - usage.reserved);
    if (remaining <= 0) return { allowed: false, denialReason: "daily_time", ...base };
    if (activeSessions >= args.maxActiveSessions) return { allowed: false, denialReason: "active_limit", ...base };
    const reservedSeconds = Math.min(remaining, args.reserveSeconds);
    usage.sessions += 1;
    usage.reserved += reservedSeconds;
    this.sessions.set(args.sessionId, {
      userId: args.userId,
      reservedSeconds,
      status: "provisioning",
      expiresAt: this.now() + (reservedSeconds + args.graceSeconds) * 1_000,
      usedSeconds: 0,
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

  async activateSession(args: { userId: string; sessionId: string; keySlot: number }): Promise<boolean> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId || session.status !== "provisioning") return false;
    session.status = "active";
    return true;
  }

  async cancelReservation(args: { userId: string; sessionId: string; reason: string }): Promise<boolean> {
    const session = this.sessions.get(args.sessionId);
    if (!session || session.userId !== args.userId || !["provisioning", "active"].includes(session.status)) return false;
    const usage = this.usageFor(args.userId);
    usage.sessions = Math.max(0, usage.sessions - 1);
    usage.reserved = Math.max(0, usage.reserved - session.reservedSeconds);
    session.status = "cancelled";
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
        await this.finalizeSession({ userId, sessionId, usedSeconds: session.reservedSeconds, status: "timeout" });
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
} = {}) {
  const { persistence, commits } = createPersistence();
  const now = args.now ?? Date.now;
  const usageStore = args.usageStore ?? new InMemoryLiveUsageStore(now);
  const keyPool = new GeminiLiveKeyPool({ keys: args.key === "" ? [] : [args.key || API_KEY], now });
  let idCounter = 0;
  const service = new LiveSessionService({
    config: liveConfig(args.enabled ?? true),
    tierPolicy: args.tierPolicy ?? loadLiveTierPolicy({}),
    planResolver: new LivePlanResolver(async () => args.planCode ?? "premium", () => {}),
    usageStore,
    keyPool,
    tokenService: new GeminiLiveTokenService({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ name: "auth_tokens/route-ephemeral" }),
      }),
    }),
    persistence,
    now,
    newId: () => {
      const suffix = String(333_333_333_333 + idCounter).padStart(12, "0");
      idCounter += 1;
      return `33333333-3333-4333-8333-${suffix}`;
    },
    logger: () => {},
    cleanupIntervalMs: 60 * 60_000,
  });
  return { service, commits, usageStore, keyPool };
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
  const { service, commits, usageStore } = createService();
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
    assert.equal(status.maxSessionSeconds, 600);
    assert.equal(status.activeSession, null);
    assert.deepEqual(
      Object.keys(status).sort(),
      ["activeSession", "available", "enabled", "maxSessionSeconds", "reason", "remainingSecondsToday"].sort(),
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
    assert(!JSON.stringify(tokenPayload).includes(API_KEY), "session-token response must not leak the long-lived API key");
    assert(Array.isArray(tokenPayload.initialHistory) && tokenPayload.initialHistory.length >= 2);

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

    const duplicateCommit = await fetch(`${baseUrl}/api/live/session/${SESSION_ID}/commit`, {
      method: "POST",
      headers: { authorization: "Bearer test-user", "content-type": "application/json" },
      body: JSON.stringify({ transcript: [] }),
    }).then((response) => response.json()) as any;
    assert.equal(duplicateCommit.alreadyCommitted, true);
    assert.equal(commits.length, 1, "duplicate commit should be idempotent");

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
    SENTIQ_LIVE_STUDENT_CORE_DAILY_SESSIONS: "3",
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
  now += 60_000;
  await service.endSession({ userId: USER_ID, sessionId: first.sessionId, reason: "client_end" });
  assert.equal(usageStore.getActiveCount(USER_ID), 0, "ending should release the per-user active count");
  assert.equal(usageStore.getUsedSeconds(USER_ID), 60);
  const afterRelease = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(usageStore.getActiveCount(USER_ID), 1, "a new session should open after the previous session ends");
  await service.endSession({ userId: USER_ID, sessionId: afterRelease.sessionId });

  const timePolicy = loadLiveTierPolicy({
    SENTIQ_LIVE_STUDENT_CORE_DAILY_MINUTES: "1",
    SENTIQ_LIVE_STUDENT_CORE_DAILY_SESSIONS: "3",
    SENTIQ_LIVE_STUDENT_CORE_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STUDENT_CORE_MAX_ACTIVE: "1",
  });
  const timeLimited = createService({ planCode: "student_core", now: nowFn, tierPolicy: timePolicy });
  const fullMinute = await timeLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  now += 60_000;
  await timeLimited.service.endSession({ userId: USER_ID, sessionId: fullMinute.sessionId });
  await assert.rejects(
    () => timeLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_daily_time_exhausted",
  );

  const sessionPolicy = loadLiveTierPolicy({
    SENTIQ_LIVE_PREMIUM_DAILY_MINUTES: "30",
    SENTIQ_LIVE_PREMIUM_DAILY_SESSIONS: "1",
    SENTIQ_LIVE_PREMIUM_MAX_SESSION_SECONDS: "60",
  });
  const sessionLimited = createService({ planCode: "premium", now: nowFn, tierPolicy: sessionPolicy });
  const only = await sessionLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  now += 1_000;
  await sessionLimited.service.endSession({ userId: USER_ID, sessionId: only.sessionId });
  await assert.rejects(
    () => sessionLimited.service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_daily_sessions_exhausted",
  );
}

async function testStaleCleanup(): Promise<void> {
  let now = Date.parse("2026-07-03T09:00:00.000Z");
  const nowFn = () => now;
  const policy = loadLiveTierPolicy({
    SENTIQ_LIVE_PREMIUM_DAILY_MINUTES: "2",
    SENTIQ_LIVE_PREMIUM_DAILY_SESSIONS: "3",
    SENTIQ_LIVE_PREMIUM_MAX_SESSION_SECONDS: "60",
    SENTIQ_LIVE_STALE_GRACE_SECONDS: "5",
  });
  const { service, usageStore, keyPool } = createService({ planCode: "premium", now: nowFn, tierPolicy: policy });
  const first = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(keyPool.getActiveCount(1), 1);
  now += 66_000;
  assert.equal(await service.cleanupStaleSessions(), 1);
  assert.equal(usageStore.getSessionStatus(first.sessionId), "timeout");
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
  assert.equal(keyPool.getActiveCount(1), 0, "stale cleanup should release the project slot");
  const second = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(second.sessionMaxSeconds, 60, "remaining daily time should be reserved for the next session");
}

async function testFreeTierDefaultAllocation(): Promise<void> {
  const { service, usageStore } = createService({ planCode: "free" });
  const before = await service.getStatus(USER_ID);
  assert.equal(before.available, true);
  assert.equal(before.remainingSecondsToday, 120);
  assert.equal(before.maxSessionSeconds, 120);
  const session = await service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID });
  assert.equal(session.sessionMaxSeconds, 120);
  await assert.rejects(
    () => service.createSession({ userId: USER_ID, conversationId: CONVERSATION_ID }),
    (error: unknown) => error instanceof LiveSessionError && error.code === "live_daily_sessions_exhausted",
  );
  await service.endSession({ userId: USER_ID, sessionId: session.sessionId });
  assert.equal(usageStore.getActiveCount(USER_ID), 0);
  const after = await service.getStatus(USER_ID);
  assert.equal(after.available, false);
  assert.equal(after.reason, "daily_limit_reached");
  assert.equal(after.activeSession, null);

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
  const liveStyles = readFileSync(resolve(root, "frontend/styles/modules/16-live-beta.css"), "utf8");
  assert(html.includes('id="live-beta-btn"'));
  assert(html.includes('id="live-beta-mute"'));
  assert(html.includes('id="live-beta-end"'));
  assert(html.includes('id="live-beta-transcript-toggle"'));
  assert(html.includes('id="live-beta-remaining"'));
  assert(html.includes('id="live-beta-retry"'));
  assert(main.includes('import "./features/live/live-controller.js"'));
  assert(controller.includes("navigator.mediaDevices.getUserMedia"));
  assert(controller.includes('mimeType: "audio/pcm;rate=16000"'));
  assert(controller.includes("outputSampleRate || 24_000"));
  assert(controller.includes("content?.interrupted"));
  assert(controller.includes("audioStreamEnd: true"));
  assert(controller.includes("const status = await refreshAvailability()"));
  assert(controller.indexOf("const status = await refreshAvailability()") < controller.indexOf("API.createLiveSessionToken"));
  assert(controller.includes('setPanelState("thinking", "Thinking"'));
  assert(controller.includes('setPanelState("speaking", "Speaking"'));
  assert(controller.includes('setPanelState("muted", "Muted"') || controller.includes('muted ? "muted"'));
  assert(controller.includes('setPanelState("ended", "Ending"'));
  for (const state of ["listening", "thinking", "speaking", "muted", "error", "ended"]) {
    assert(
      liveStyles.includes(`[data-state="${state}"]`),
      `Live overlay styles must render the ${state} state`,
    );
  }
  assert(composerState.includes("Live voice is not available on your current plan."));
  assert(composerState.includes("You’ve used today’s Live voice time."));
  assert(composerState.includes("Live voice is busy. Try again soon."));
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
    assert.equal(resolveLiveComposerAction({ ...base, hasAttachments: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ ...base, specialModeActive: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ ...base, responseLocked: true }).showLive, false);
    assert.equal(resolveLiveComposerAction({ enabled: true, reason: "sign_in_required" }).disabled, false);
    const denied = resolveLiveComposerAction({ enabled: true, reason: "daily_limit_reached" });
    assert.equal(denied.showLive, true);
    assert.equal(denied.disabled, true);
    assert.equal(denied.message, "You’ve used today’s Live voice time.");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", composerTest], { stdio: "pipe" });
}

function testMigrationFoundation(): void {
  const root = resolve(__dirname, "..");
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
}

async function main(): Promise<void> {
  testTierPolicy();
  await testPlanResolutionFallback();
  await testKeyPool();
  await testTokenService();
  await testRoutes();
  await testDailyAndActiveLimits();
  await testStaleCleanup();
  await testFreeTierDefaultAllocation();
  await testDisabledBehavior();
  testFrontendFoundation();
  testMigrationFoundation();
  console.log("PASS | SentIQ Live Phase 1, Phase 2, and Phase 3 focused tests passed.");
}

main().catch((error) => {
  console.error("FAIL | SentIQ Live focused tests failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
