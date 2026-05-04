import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import multer from "multer";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";
import { randomUUID } from "crypto";

// Load .env
const envPathCandidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];
const resolvedEnvPath = envPathCandidates.find((p) => existsSync(p));
if (resolvedEnvPath) {
  dotenv.config({ path: resolvedEnvPath });
} else {
  dotenv.config();
}

// AI handlers
import { handleChat } from "./ai/ChatHandler";
import { processMessageForMemory, compressMemories } from "./ai/MemoryProcessor";
import { extractTextFromFile, validateFileUpload } from "./ai/FileIngestionHandler";
import { routeImageGeneration } from "./tools/imageGeneration/imageRouter";
import { routeChartGeneration } from "./tools/chartGeneration/chartRouter";
import { isChartRequest } from "./tools/chartGeneration/chartDetector";
import { uploadChatImage, getChatImages } from "./tools/imageGeneration/imageStorageService";
import {
  buildChatPrompt,
  callLLMAdapter,
  callLLMAdapterDetailed,
  callLLMAdapterStream,
  buildTitleGeneratePrompt,
  strictParseJsonObject,
} from "./ai/PromptBuilders";
import { buildContext, buildContextFast } from "./context/contextBuilder";
import {
  getControlDatabase,
  getImageStorageDatabase,
  getImageStorageDatabaseId,
  getUserDatabase,
  getOrAssignUserDatabase,
  initializeControlUserSession,
  ShardCapacityError,
  verifyShardMigrations,
} from "./dbRouter";
import {
  createConversation,
  deleteConversation,
  getConversationById,
  getConversationMessages,
  getUserConversations,
  insertConversationMessage,
  updateConversationTitle,
  type ConversationListRow,
  type ConversationMessageRow,
  type ConversationRow,
} from "./services/conversationService";
import {
  decrementUserMemoryUsage,
  deleteMemory,
  getMemoryById,
  getUserMemoryUsageBytes,
  getUserMemories,
  incrementUserMemoryUsage,
  insertMemory,
  type MemoryRow,
  type MemoryScope,
} from "./services/memoryService";
import {
  getMirroredUserProfile,
  saveMirroredUserProfile,
  validateDisplayName,
} from "./services/profileService";
import {
  buildImagePromptMessageContent,
  findExistingAssistantImageMessage,
  persistGeneratedImageResult,
} from "./services/generatedImagePersistenceService";

// v2 Orchestrator
import { orchestrate } from "./orchestrator/aiOrchestrator";

import { detectCodeQuery, isBufferedReasoningQuery, isMathQuery, selectModelForPrompt } from "./orchestrator/modelRouter";
import { detectExplicitMemoryWriteIntent, classifyQueryType, shouldForceWebSearch } from "./orchestrator/queryClassifier";
import { isTavilyAvailable } from "./tools/webSearch/providers/tavilyProvider";
import { isWebSearchMode, normalizeWebSearchMode } from "./tools/webSearch/webSearchMode";

// Middleware
import { generalRateLimiter, aiRateLimiter, uploadRateLimiter } from "./middleware/rateLimiter";
import { auditMiddleware, getRecentAuditEntries } from "./middleware/audit";
import { imageQuotaMiddleware, getImageQuotaKey, getQuotaInfo, isImageRequest } from "./middleware/imageQuota";
import { AuthError, getRequestUser, resolveRequestUser, verifyJWT } from "./middleware/auth";
import { HttpError, buildHttpErrorResponse } from "./httpErrors";

// Validation
import {
  ChatRequestSchema,
  MemoryClassifyRequestSchema,
  MemoryCompressRequestSchema,
  ImageGenerateRequestSchema,
  ChartGenerateRequestSchema,
  ProfileUpdateRequestSchema,
  SelectionContextSchema,
  detectPromptInjection,
} from "./validation/schemas";
import { ZodError } from "zod";
import { collapseAdjacentDuplicateMessages } from "./context/messageDeduper";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const JSON_BODY_LIMIT = process.env.SENTIQ_JSON_BODY_LIMIT?.trim() || "6mb";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TITLE_MAX_CHARS = 120;
const TITLE_FALLBACK_MAX_CHARS = 50;
const TITLE_GENERATION_TIMEOUT_MS = parseInt(process.env.SENTIQ_TITLE_TIMEOUT_MS || "12000", 10);

app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal");

function getExplicitWebSearchMode(value: unknown): "basic" | undefined {
  if (!isWebSearchMode(value)) return undefined;
  return normalizeWebSearchMode(value) === "basic" ? "basic" : undefined;
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}

// ---- CORS ----
const DEFAULT_ORIGINS = [
  "https://sentiqgpt.sentiqlabs.com",
  "https://www.sentiqgpt.sentiqlabs.com",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:5173",
];

const ALLOWED_ORIGINS: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

console.log("[SentIQGPT v1] CORS allowed origins:", ALLOWED_ORIGINS);

const corsOptions: cors.CorsOptions = {
  origin(
    requestOrigin: string | undefined,
    callback: (err: Error | null, allow?: boolean | string) => void,
  ) {
    // Allow requests with no origin (server-to-server, curl, etc.)
    if (!requestOrigin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(requestOrigin)) {
      return callback(null, requestOrigin);
    }
    // Reject silently — return false instead of throwing, so Express
    // still sends headers and the browser gets a clean CORS rejection.
    console.warn(`[CORS] Blocked request from origin: ${requestOrigin}`);
    callback(null, false);
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: JSON_BODY_LIMIT }));

// ---- Security headers ----
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,  // Allow cross-origin API responses
    crossOriginOpenerPolicy: false,    // Allow cross-origin window context
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }),
);

// ---- No-cache headers ----
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// ---- Middleware stack ----
app.use(generalRateLimiter);
app.use(auditMiddleware);

// ---- Multer for file uploads ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Helpers ----
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function formatZodError(err: ZodError): string {
  return err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
}

function gateThinking(
  thinking: string | undefined,
  options: { route?: string; modelOverride?: string; isReasoning?: boolean },
): string | undefined {
  if (options.route === "math_reasoning" || options.isReasoning) {
    return thinking;
  }
  return undefined;
}

type SseWriter = {
  write: (payload: string) => Promise<void>;
  close: () => void;
  getPendingBytes: () => number;
};

type SseWriterOptions = {
  maxBufferedBytes?: number;
};

function createSseWriter(res: Response, options?: SseWriterOptions): SseWriter {
  const maxBufferedBytes = options?.maxBufferedBytes ?? 512 * 1024;
  const queue: string[] = [];
  let queuedBytes = 0;
  let pumping = false;
  let closed = false;

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    while (queue.length > 0) {
      const data = queue.shift();
      if (!data) break;
      queuedBytes -= data.length;
      if (closed || res.writableEnded) break;
      const ok = res.write(data);
      if (!ok) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    pumping = false;
  };

  const write = async (payload: string) => {
    if (closed || res.writableEnded) return;
    const data = `data: ${payload}\n\n`;
    if (queuedBytes + data.length > maxBufferedBytes) {
      throw new Error(`SSE buffer limit exceeded (${maxBufferedBytes} bytes)`);
    }
    queue.push(data);
    queuedBytes += data.length;
    await pump();
  };

  const close = () => {
    closed = true;
    if (!res.writableEnded) {
      res.end();
    }
  };

  return {
    write,
    close,
    getPendingBytes: () => queuedBytes,
  };
}

function estimateTokensFromText(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

type StreamMetrics = {
  label: string;
  requestStart: number;
  model?: string;
  fastPath?: boolean;
  firstChunkAt?: number;
  lastChunkAt?: number;
  chunkCount: number;
  approxTokens: number;
  totalChunkGapMs: number;
  maxChunkGapMs: number;
  minChunkGapMs: number;
};

function createStreamMetrics(
  label: string,
  requestStart: number,
  meta?: { model?: string; fastPath?: boolean },
): StreamMetrics {
  return {
    label,
    requestStart,
    model: meta?.model,
    fastPath: meta?.fastPath,
    chunkCount: 0,
    approxTokens: 0,
    totalChunkGapMs: 0,
    maxChunkGapMs: 0,
    minChunkGapMs: Number.POSITIVE_INFINITY,
  };
}

function recordStreamChunk(metrics: StreamMetrics, text: string): void {
  const now = Date.now();
  if (!metrics.firstChunkAt) {
    metrics.firstChunkAt = now;
  }
  if (metrics.lastChunkAt) {
    const gap = now - metrics.lastChunkAt;
    metrics.totalChunkGapMs += gap;
    metrics.maxChunkGapMs = Math.max(metrics.maxChunkGapMs, gap);
    metrics.minChunkGapMs = Math.min(metrics.minChunkGapMs, gap);
  }
  metrics.lastChunkAt = now;
  metrics.chunkCount += 1;
  metrics.approxTokens += estimateTokensFromText(text);
}

function logStreamMetrics(metrics: StreamMetrics, reason: string): void {
  const ttftMs = metrics.firstChunkAt ? metrics.firstChunkAt - metrics.requestStart : -1;
  const streamDurationMs =
    metrics.firstChunkAt && metrics.lastChunkAt
      ? metrics.lastChunkAt - metrics.firstChunkAt
      : 0;
  const tokensPerSec = streamDurationMs > 0
    ? Math.round(metrics.approxTokens / (streamDurationMs / 1000))
    : metrics.approxTokens;
  const avgGapMs = metrics.chunkCount > 1
    ? Math.round(metrics.totalChunkGapMs / (metrics.chunkCount - 1))
    : 0;
  const minGapMs = metrics.minChunkGapMs === Number.POSITIVE_INFINITY
    ? 0
    : metrics.minChunkGapMs;
  console.log(
    `[StreamMetrics] label=${metrics.label} model=${metrics.model ?? "unknown"}` +
    ` fastPath=${metrics.fastPath ?? false} ttft_ms=${ttftMs} tokens=${metrics.approxTokens}` +
    ` tps=${tokensPerSec} chunks=${metrics.chunkCount} avg_chunk_gap_ms=${avgGapMs}` +
    ` max_chunk_gap_ms=${metrics.maxChunkGapMs} min_chunk_gap_ms=${minGapMs} reason=${reason}`,
  );
}

const GUEST_MODEL_OVERRIDE = "gemini-search";

// ═══════════════════════════════════════════════════════════════════════════════
// CAPACITY LIMITS (enforced per user to keep DBs under 95% usage)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maximum memory storage per user in bytes (25 KB).
 * Memories exceeding this are rejected.
 */
const MAX_MEMORY_BYTES_PER_USER = 25 * 1024; // 25 KB
const MEMORY_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-001";

async function getVerifiedUserId(req: Request): Promise<string> {
  const user = await resolveRequestUser(req, { allowGuest: false });
  return user.sub;
}

async function getRequestIdentity(req: Request): Promise<{ userId: string; isGuest: boolean }> {
  const user = await resolveRequestUser(req, { allowGuest: true });
  return { userId: user.sub, isGuest: user.isGuest };
}

function logProfileEvent(
  event: string,
  details: Record<string, string | boolean | null | undefined>,
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== null && typeof value !== "undefined" && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(`[SentIQGPT][profile] ${event}${suffix ? ` ${suffix}` : ""}`);
}

async function resolveTrustedProfileContext(
  userId?: string,
  userDb?: any,
): Promise<{ displayName: string } | undefined> {
  const normalizedUserId = userId?.trim();
  if (!normalizedUserId || normalizedUserId === "guest") {
    return undefined;
  }

  try {
    const profile = await getMirroredUserProfile({
      userId: normalizedUserId,
      controlDb: getControlDatabase(),
      userDb,
      logger: logProfileEvent,
    });

    return profile.displayName
      ? { displayName: profile.displayName }
      : undefined;
  } catch (error) {
    logProfileEvent("resolve.failed", {
      userId: normalizedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function ensureNamedWorkspaceProfile(
  userId: string,
  scope: string,
  userDb?: any,
): Promise<{ displayName: string } | undefined> {
  await initializeControlUserSession(userId);
  const profile = await getMirroredUserProfile({
    userId,
    controlDb: getControlDatabase(),
    userDb,
    logger: logProfileEvent,
  });

  if (profile.requiresName) {
    logProfileEvent("gate.blocked", { userId, scope });
    throw new HttpError(403, "Add your name to continue.", {
      code: "profile_name_required",
      requires_name: true,
    });
  }

  return profile.displayName ? { displayName: profile.displayName } : undefined;
}

type DbErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

function formatDbError(error: DbErrorLike): string {
  if (!error) return "unknown";
  const parts = [
    error.code ? `code=${error.code}` : null,
    error.message ? `message=${error.message}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown";
}

function logDbEvent(
  scope: string,
  userId: string,
  details: Record<string, string | number | null | undefined> = {},
): void {
  const detailString = Object.entries(details)
    .filter(([, value]) => value !== null && typeof value !== "undefined" && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const suffix = detailString ? ` ${detailString}` : "";
  console.log(`[SentIQGPT][db] ${scope} userId=${userId}${suffix}`);
}

function logDbFailure(
  scope: string,
  userId: string,
  error: DbErrorLike | Error,
  details: Record<string, string | number | null | undefined> = {},
): void {
  const detailString = Object.entries(details)
    .filter(([, value]) => value !== null && typeof value !== "undefined" && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const normalizedError = error instanceof Error
    ? error.message
    : formatDbError(error);
  const suffix = detailString ? ` ${detailString}` : "";
  console.error(`[SentIQGPT][db] ${scope}.failed userId=${userId}${suffix} error=${normalizedError}`);
}

function logMessagePersistenceGap(
  scope: string,
  userId: string,
  details: {
    conversationId?: string | null;
    userMessagePersisted: boolean;
    assistantMessagePersisted: boolean;
    assistantExpected: boolean;
    deferred?: boolean;
    created?: boolean;
    route?: string;
    clientDisconnected?: boolean;
    error?: string | null;
  },
): void {
  if (
    details.userMessagePersisted &&
    (!details.assistantExpected || details.assistantMessagePersisted)
  ) {
    return;
  }

  logDbEvent(`${scope}.message-gap`, userId, {
    conversationId: details.conversationId || undefined,
    user_persisted: details.userMessagePersisted ? "true" : "false",
    assistant_persisted: details.assistantMessagePersisted ? "true" : "false",
    assistant_expected: details.assistantExpected ? "true" : "false",
    deferred: details.deferred ? "true" : "false",
    created: details.created ? "true" : "false",
    route: details.route,
    client_disconnected: details.clientDisconnected ? "true" : "false",
    error: details.error ? details.error.slice(0, 160) : undefined,
  });
}

function normalizeTitleCandidate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}

function fallbackTitleFromMessage(message: string): string {
  return normalizeTitleCandidate(message.slice(0, TITLE_FALLBACK_MAX_CHARS));
}

function extractTitleFromRaw(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = strictParseJsonObject(trimmed);
    if (typeof parsed.title === "string") {
      return normalizeTitleCandidate(parsed.title);
    }
  } catch {
    // Fallback to regex or plain text.
  }

  const match = trimmed.match(/"title"\s*:\s*"([^\"]+)"/i);
  if (match && match[1]) {
    return normalizeTitleCandidate(match[1]);
  }

  return normalizeTitleCandidate(trimmed);
}

type TitleGenerationResult = {
  title: string;
  source: "llm" | "fallback";
  modelUsed?: string;
  fallbackReason?: string | null;
  error?: string | null;
};

async function generateTitleWithFallback(options: {
  userMessage: string;
  assistantReply: string;
  conversationId: string;
  userId: string;
  scope: string;
  prefer?: "gemini" | "groq";
  modelOverride?: string;
}): Promise<TitleGenerationResult> {
  const fallbackTitle = fallbackTitleFromMessage(options.userMessage);
  const baseCall = buildTitleGeneratePrompt({
    userMessage: options.userMessage.slice(0, 500),
    assistantReply: options.assistantReply.slice(0, 500),
    conversationId: options.conversationId,
    userId: options.userId,
  });
  const call = {
    ...baseCall,
    user_id: options.userId,
    timeout_ms: TITLE_GENERATION_TIMEOUT_MS,
  };
  if (typeof options.prefer !== "undefined") {
    call.prefer = options.prefer;
  }
  if (options.modelOverride) {
    call.model_override = options.modelOverride;
  }

  logDbEvent(`${options.scope}.title-generate.start`, options.userId, {
    conversationId: options.conversationId,
  });

  try {
    const result = await callLLMAdapterDetailed(call);
    const candidate = extractTitleFromRaw(result.text || "");
    const title = candidate || fallbackTitle;
    const source = candidate ? "llm" : "fallback";
    logDbEvent(`${options.scope}.title-generate.ok`, options.userId, {
      conversationId: options.conversationId,
      source,
      model_used: result.model_used || undefined,
      fallback: result.fallback ? "true" : "false",
    });
    return {
      title,
      source,
      modelUsed: result.model_used,
      fallbackReason: result.fallback_reason ?? null,
      error: result.error ?? null,
    };
  } catch (error) {
    logDbFailure(
      `${options.scope}.title-generate`,
      options.userId,
      error instanceof Error ? error : new Error(String(error)),
      { conversationId: options.conversationId },
    );
    return {
      title: fallbackTitle,
      source: "fallback",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readConversationTitleIfOwned(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<string | null> {
  const { data, error } = await getConversationById(userDb, conversationId);
  if (error) {
    logDbFailure(`${scope}.title-read`, userId, error, { conversationId });
    return null;
  }
  if (!data) {
    logDbEvent(`${scope}.title-read.not-found`, userId, { conversationId });
    return null;
  }
  if (data.user_id !== userId) {
    logDbFailure(
      `${scope}.title-read`,
      userId,
      new Error("Unauthorized conversation access"),
      { conversationId },
    );
    return null;
  }
  return typeof data.title === "string" ? data.title : null;
}

async function persistConversationTitleIfEligible(options: {
  userDb: any;
  userId: string;
  conversationId: string;
  title: string;
  scope: string;
  currentTitle?: string | null;
}): Promise<boolean> {
  const normalizedTitle = normalizeTitleCandidate(options.title);
  if (!normalizedTitle) return false;

  const currentTitle = typeof options.currentTitle === "string"
    ? options.currentTitle
    : await readConversationTitleIfOwned(options.userDb, options.userId, options.conversationId, options.scope);
  const normalizedCurrent = normalizeTitleCandidate(currentTitle || "");
  if (normalizedCurrent && normalizedCurrent !== "New Chat") {
    logDbEvent(`${options.scope}.title-persist.skip`, options.userId, {
      conversationId: options.conversationId,
    });
    return false;
  }

  const { error } = await updateConversationTitle(
    options.userDb,
    options.conversationId,
    options.userId,
    normalizedTitle,
  );
  if (error) {
    logDbFailure(`${options.scope}.title-persist`, options.userId, error, {
      conversationId: options.conversationId,
    });
    return false;
  }

  logDbEvent(`${options.scope}.title-persist.ok`, options.userId, {
    conversationId: options.conversationId,
  });
  return true;
}

async function maybeAutoTitleConversation(options: {
  userDb: any;
  userId: string;
  conversationId: string;
  userMessage: string;
  assistantReply: string;
  scope: string;
  currentTitle?: string | null;
}): Promise<void> {
  if (!options.userDb || !options.conversationId) return;
  const normalizedCurrent = normalizeTitleCandidate(options.currentTitle || "");
  if (normalizedCurrent && normalizedCurrent !== "New Chat") return;

  const generation = await generateTitleWithFallback({
    userMessage: options.userMessage,
    assistantReply: options.assistantReply,
    conversationId: options.conversationId,
    userId: options.userId,
    scope: options.scope,
  });

  await persistConversationTitleIfEligible({
    userDb: options.userDb,
    userId: options.userId,
    conversationId: options.conversationId,
    title: generation.title,
    scope: options.scope,
    currentTitle: options.currentTitle ?? null,
  });
}

function scheduleAutoTitleConversation(options: Parameters<typeof maybeAutoTitleConversation>[0]): void {
  void maybeAutoTitleConversation(options).catch((error) => {
    logDbFailure(
      `${options.scope}.background`,
      options.userId,
      error instanceof Error ? error : new Error(String(error)),
      { conversationId: options.conversationId },
    );
  });
}

async function resolveUserDatabaseOrThrow(userId: string, scope: string) {
  logDbEvent(`${scope}.resolve-db.start`, userId);
  try {
    const userDb = await getOrAssignUserDatabase(userId);
    logDbEvent(`${scope}.resolve-db.ok`, userId);
    return userDb;
  } catch (error) {
    if (error instanceof ShardCapacityError) {
      console.error(
        `[SentIQGPT][alert] shard-capacity.exhausted userId=${userId} scope=${scope}` +
        ` total_users=${error.totalUsers} threshold=${error.threshold}` +
        ` retry_after_seconds=${error.retryAfterSeconds} counts=${JSON.stringify(error.counts)}`,
      );
      throw new HttpError(503, "Service is temporarily at capacity. Please try again later.", {
        code: error.code,
        expose: true,
        headers: { "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    logDbFailure(`${scope}.resolve-db`, userId, error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

async function initializeUserSessionOrThrow(userDb: any, userId: string, scope: string): Promise<void> {
  logDbEvent(`${scope}.session-init.start`, userId);
  const startedAt = Date.now();
  const { error } = await userDb.rpc("initialize_user_session", { p_user_id: userId });
  if (error) {
    logDbFailure(`${scope}.session-init`, userId, error);
    throw new Error(error.message);
  }
  logDbEvent(`${scope}.session-init.ok`, userId, { duration_ms: Date.now() - startedAt });
}

async function getOwnedConversationOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<ConversationRow> {
  logDbEvent(`${scope}.conversation-owner.start`, userId, { conversationId });
  const { data, error } = await getConversationById(userDb, conversationId);

  if (error) {
    logDbFailure(`${scope}.conversation-owner`, userId, error, { conversationId });
    throw new HttpError(500, "Failed to resolve conversation.");
  }

  if (!data) {
    logDbEvent(`${scope}.conversation-owner.not-found`, userId, { conversationId });
    throw new HttpError(404, "Conversation not found.", { code: "conversation_not_found" });
  }

  if (data.user_id !== userId) {
    logDbFailure(
      `${scope}.conversation-owner`,
      userId,
      new Error("Unauthorized conversation access"),
      { conversationId },
    );
    throw new HttpError(403, "Unauthorized conversation access.", { code: "conversation_forbidden" });
  }

  logDbEvent(`${scope}.conversation-owner.ok`, userId, { conversationId });
  return data as ConversationRow;
}

async function createConversationOrThrow(
  userDb: any,
  userId: string,
  scope: string,
  title = "New Chat",
): Promise<ConversationListRow> {
  logDbEvent(`${scope}.conversation-create.start`, userId, { title });
  const startedAt = Date.now();
  const { data, error } = await createConversation(userDb, { userId, title });

  if (error) {
    logDbFailure(`${scope}.conversation-create`, userId, error, { title });
    throw new Error(error.message);
  }
  if (!data?.id) {
    logDbFailure(`${scope}.conversation-create`, userId, new Error("Failed to create conversation"));
    throw new Error("Failed to create conversation");
  }

  logDbEvent(`${scope}.conversation-create.ok`, userId, {
    conversationId: data.id,
    duration_ms: Date.now() - startedAt,
  });
  return data as ConversationListRow;
}

async function insertConversationMessageOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  scope: string,
  options: { clientRequestId?: string } = {},
): Promise<void> {
  logDbEvent(`${scope}.message-insert.start`, userId, {
    conversationId,
    role,
    clientRequestId: options.clientRequestId || null,
  });
  const { error, duplicate } = await insertConversationMessage(userDb, {
    conversationId,
    role,
    content,
    clientRequestId: options.clientRequestId,
  });
  if (error) {
    logDbFailure(`${scope}.message-insert`, userId, error, { conversationId, role });
    throw new Error(error.message);
  }
  logDbEvent(`${scope}.message-insert.ok`, userId, {
    conversationId,
    role,
    duplicate: duplicate === true ? "true" : "false",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY STORAGE LIMIT ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculates the approximate storage size of a user's memories in bytes.
 * Reads the persisted byte counter from the shard-local users row.
 */
async function calculateUserMemorySize(
  userDb: any,
  userId: string,
): Promise<number> {
  const { data: totalBytes, error } = await getUserMemoryUsageBytes(userDb, userId);
  if (error) {
    return 0;
  }
  return totalBytes;
}

/**
 * Checks if adding a new memory would exceed the user's memory storage limit.
 * Throws an error if limit would be exceeded.
 */
async function enforceMemoryLimit(
  userDb: any,
  userId: string,
  newMemorySummary: string,
  scope: string,
): Promise<void> {
  const currentBytes = await calculateUserMemorySize(userDb, userId);
  const newMemoryBytes = new TextEncoder().encode(newMemorySummary || "").length;
  const projectedBytes = currentBytes + newMemoryBytes;

  logDbEvent(`${scope}.memory-limit.check`, userId, {
    current_kb: (currentBytes / 1024).toFixed(2),
    new_kb: (newMemoryBytes / 1024).toFixed(2),
    projected_kb: (projectedBytes / 1024).toFixed(2),
    limit_kb: (MAX_MEMORY_BYTES_PER_USER / 1024).toFixed(2),
  });

  if (projectedBytes > MAX_MEMORY_BYTES_PER_USER) {
    const currentKb = (currentBytes / 1024).toFixed(2);
    const limitKb = (MAX_MEMORY_BYTES_PER_USER / 1024).toFixed(2);
    throw new Error(
      `Memory storage limit exceeded. Current: ${currentKb}KB, Limit: ${limitKb}KB. ` +
      `Delete some memories to add new ones.`
    );
  }
}

async function insertMemoryOrThrow(
  userDb: any,
  userId: string,
  memory: {
    type?: string;
    summary?: string;
    importance?: number;
    embedding?: readonly number[] | null;
    scope?: MemoryScope;
    chat_id?: string | null;
  },
  scope: string,
): Promise<MemoryRow> {
  const newMemoryBytes = new TextEncoder().encode(memory.summary ?? "").length;

  // Enforce memory storage limit before inserting
  await enforceMemoryLimit(userDb, userId, memory.summary ?? "", scope);

  logDbEvent(`${scope}.memory-insert.start`, userId, { type: memory.type || null });
  const { data, error } = await insertMemory(userDb, {
    userId,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance,
    embedding: memory.embedding,
    embedding_model: Array.isArray(memory.embedding) && memory.embedding.length > 0 ? MEMORY_EMBEDDING_MODEL : null,
    embedding_created_at: Array.isArray(memory.embedding) && memory.embedding.length > 0 ? new Date().toISOString() : null,
    scope: memory.scope,
    chat_id: memory.chat_id ?? null,
  });
  if (error) {
    logDbFailure(`${scope}.memory-insert`, userId, error, { type: memory.type || null });
    throw new Error(error.message);
  }
  if (!data?.id) {
    throw new Error("Failed to create memory");
  }

  const { error: usageError } = await incrementUserMemoryUsage(userDb, userId, newMemoryBytes);
  if (usageError) {
    await deleteMemory(userDb, data.id, userId).catch(() => undefined);
    throw new Error(usageError.message);
  }

  logDbEvent(`${scope}.memory-insert.ok`, userId, { type: memory.type || null });
  return data as MemoryRow;
}

async function listMemoriesOrThrow(
  userDb: any,
  userId: string,
  scope: string,
): Promise<MemoryRow[]> {
  logDbEvent(`${scope}.memory-list.start`, userId);
  const startedAt = Date.now();
  const { data, error } = await getUserMemories(userDb, userId);

  if (error) {
    logDbFailure(`${scope}.memory-list`, userId, error);
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.memory-list.ok`, userId, {
    count: data?.length || 0,
    duration_ms: Date.now() - startedAt,
  });
  return (data || []) as MemoryRow[];
}

async function deleteMemoryIfOwned(
  userDb: any,
  userId: string,
  memoryId: string,
  scope: string,
): Promise<void> {
  logDbEvent(`${scope}.memory-delete.start`, userId, { memoryId });
  const { data: memoryRow, error: memoryLookupError } = await getMemoryById(userDb, memoryId, userId);
  if (memoryLookupError) {
    logDbFailure(`${scope}.memory-delete.lookup`, userId, memoryLookupError, { memoryId });
    throw new Error(memoryLookupError.message);
  }

  const memoryBytes = new TextEncoder().encode(memoryRow?.summary ?? "").length;
  const { error } = await deleteMemory(userDb, memoryId, userId);

  if (error) {
    logDbFailure(`${scope}.memory-delete`, userId, error, { memoryId });
    throw new Error(error.message);
  }

  if (memoryBytes > 0) {
    const { error: usageError } = await decrementUserMemoryUsage(userDb, userId, memoryBytes);
    if (usageError) {
      logDbFailure(`${scope}.memory-delete.usage-repair-needed`, userId, usageError, {
        memoryId,
        memoryBytes,
      });
    }
  }

  logDbEvent(`${scope}.memory-delete.ok`, userId, { memoryId });
}

async function listConversationsOrThrow(userDb: any, userId: string, scope: string): Promise<ConversationListRow[]> {
  logDbEvent(`${scope}.conversation-list.start`, userId);
  const startedAt = Date.now();
  const { data, error } = await getUserConversations(userDb, userId);

  if (error) {
    logDbFailure(`${scope}.conversation-list`, userId, error);
    throw new Error(error.message);
  }
  const missingTitleCount = (data || []).filter((row) => {
    const normalized = normalizeTitleCandidate(row?.title || "");
    return !normalized || normalized === "New Chat";
  }).length;
  logDbEvent(`${scope}.conversation-list.ok`, userId, {
    count: data?.length || 0,
    missing_titles: missingTitleCount,
    duration_ms: Date.now() - startedAt,
  });
  return (data || []) as ConversationListRow[];
}

async function listConversationMessagesOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
  options: { skipOwnershipCheck?: boolean } = {},
): Promise<ConversationMessageRow[]> {
  if (!options.skipOwnershipCheck) {
    await getOwnedConversationOrThrow(userDb, userId, conversationId, scope);
  }
  logDbEvent(`${scope}.message-list.start`, userId, { conversationId });
  const startedAt = Date.now();
  const { data, error } = await getConversationMessages(userDb, conversationId);

  if (error) {
    logDbFailure(`${scope}.message-list`, userId, error, { conversationId });
    throw new Error(error.message);
  }
  const messages = (data || []) as ConversationMessageRow[];
  logDbEvent(`${scope}.message-list.ok`, userId, {
    conversationId,
    count: messages.length,
    duration_ms: Date.now() - startedAt,
  });
  return messages;
}

async function updateConversationTitleIfOwned(
  userDb: any,
  userId: string,
  conversationId: string,
  title: string,
  scope: string,
): Promise<void> {
  await getOwnedConversationOrThrow(userDb, userId, conversationId, scope);
  logDbEvent(`${scope}.conversation-title.start`, userId, { conversationId });
  const { error } = await updateConversationTitle(userDb, conversationId, userId, title);

  if (error) {
    logDbFailure(`${scope}.conversation-title`, userId, error, { conversationId });
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.conversation-title.ok`, userId, { conversationId });
}

async function deleteConversationIfOwned(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<void> {
  await getOwnedConversationOrThrow(userDb, userId, conversationId, scope);
  logDbEvent(`${scope}.conversation-delete.start`, userId, { conversationId });
  const { error } = await deleteConversation(userDb, conversationId, userId);

  if (error) {
    logDbFailure(`${scope}.conversation-delete`, userId, error, { conversationId });
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.conversation-delete.ok`, userId, { conversationId });
}

type FileAnalysisStatus = "processing" | "complete" | "error";

type FileAnalysisEvent = {
  type: "file_analysis";
  event: "processing" | "update" | "error";
  analysis_id: string;
  filename: string;
  file_type: "pdf" | "txt" | "image";
  status: FileAnalysisStatus;
  size_bytes: number;
  extracted_text?: string;
  error?: string;
  updated_at: number;
};

const fileAnalysisSubscribers: Map<string, SseWriter> = new Map();

function emitFileAnalysisEvent(event: FileAnalysisEvent): void {
  const payload = JSON.stringify(event);
  for (const [subscriberId, writer] of fileAnalysisSubscribers) {
    writer.write(payload).catch((err) => {
      console.warn(`[FileAnalysis] subscriber ${subscriberId} dropped: ${err instanceof Error ? err.message : err}`);
      writer.close();
      fileAnalysisSubscribers.delete(subscriberId);
    });
  }
}

// ---- File Session Manager ----
// Maintains the most recently uploaded file per IP to prevent old file references.
interface FileSession {
  filename: string;
  type: string;
  extractedText: string;
  uploadTime: number;
  analysisId?: string;
}
const fileSessionMap: Map<string, FileSession> = new Map();

function getFileSessionKey(req: Request, userId?: string, isGuest = false): string {
  if (userId && !isGuest && userId !== "guest") {
    return `user:${userId}`;
  }
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  return `guest:${clientIp}`;
}

// Clean up sessions older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [sessionKey, session] of fileSessionMap) {
    if (session.uploadTime < cutoff) fileSessionMap.delete(sessionKey);
  }
}, 10 * 60 * 1000);

// ===============================
// GET /health — Lightweight uptime ping (UptimeRobot / Render keep-alive)
// ===============================
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "SentIQGPT backend" });
});

// ===============================
// GET /api/health
// ===============================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    system: "SentIQGPT",
    version: "2.0.0",
    architecture: "orchestrated-dual-model",
    models: { reasoning: "gemini", cognition: "groq" },
    storage: "client-indexeddb",
    timestamp: new Date().toISOString(),
    features: [
      "chat",
      "persistent-memory",
      "file-upload",
      "image-generation",
      "chart-generation",
      "memory-compression",
      "tool-detection",
      "ai-orchestrator",
      "session-title-generation",
      "knowledge-query",
      "memory-update",
      "streaming",
    ],
  });
});

// ===============================
// GET /api/profile
// ===============================
app.get(
  "/api/profile",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);

    await initializeControlUserSession(userId);

    let assignedUserDb: any = null;
    try {
      assignedUserDb = await getUserDatabase(userId);
      if (assignedUserDb) {
        await initializeUserSessionOrThrow(assignedUserDb, userId, "profile.get");
      }
    } catch (error) {
      logProfileEvent("read.shard_unavailable", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      assignedUserDb = null;
    }

    const profile = await getMirroredUserProfile({
      userId,
      controlDb: getControlDatabase(),
      userDb: assignedUserDb,
      logger: logProfileEvent,
    });

    res.json({
      profile: {
        display_name: profile.displayName,
      },
      requires_name: profile.requiresName,
    });
  }),
);

// ===============================
// PATCH /api/profile
// ===============================
app.patch(
  "/api/profile",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const parsed = ProfileUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    let displayName: string;
    try {
      displayName = validateDisplayName(parsed.data.display_name);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid display name." });
      return;
    }

    await initializeControlUserSession(userId);
    const userDb = await resolveUserDatabaseOrThrow(userId, "profile.update");
    await initializeUserSessionOrThrow(userDb, userId, "profile.update");

    const savedProfile = await saveMirroredUserProfile({
      userId,
      displayName,
      controlDb: getControlDatabase(),
      userDb,
    });

    res.json({
      profile: {
        display_name: savedProfile.displayName,
      },
      requires_name: false,
    });
  }),
);

// ===============================
// GET /api/conversations
// ===============================
app.get(
  "/api/conversations",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.list");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.list");
    await ensureNamedWorkspaceProfile(userId, "conversations.list", userDb);
    const conversations = await listConversationsOrThrow(userDb, userId, "conversations.list");
    logDbEvent("conversations.list.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      count: conversations.length,
    });
    res.json({ conversations });
  }),
);

// ===============================
// POST /api/conversations
// ===============================
app.post(
  "/api/conversations",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const requestedTitle =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : "New Chat";
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.create");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.create");
    await ensureNamedWorkspaceProfile(userId, "conversations.create", userDb);
    const conversation = await createConversationOrThrow(userDb, userId, "conversations.create", requestedTitle);
    logDbEvent("conversations.create.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId: conversation.id,
    });
    res.json({ conversation });
  }),
);

// ===============================
// PATCH /api/conversations/:id/title
// ===============================
app.patch(
  "/api/conversations/:id/title",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const conversationId = req.params.id?.trim();
    const title =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : "";

    if (!conversationId) {
      res.status(400).json({ error: "Conversation id is required." });
      return;
    }
    if (!title) {
      res.status(400).json({ error: "Title is required." });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.title");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.title");
    await ensureNamedWorkspaceProfile(userId, "conversations.title", userDb);
    await updateConversationTitleIfOwned(userDb, userId, conversationId, title, "conversations.title");
    logDbEvent("conversations.title.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId,
    });
    res.json({ success: true, conversationId, title });
  }),
);

// ===============================
// GET /api/conversations/:id/messages
// ===============================
app.get(
  "/api/conversations/:id/messages",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const conversationId = req.params.id?.trim();
    if (!conversationId) {
      res.status(400).json({ error: "Conversation id is required." });
      return;
    }
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.messages");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.messages");
    await ensureNamedWorkspaceProfile(userId, "conversations.messages", userDb);
    
    // Fetch conversation details (including title) along with messages
    const conversation = await getOwnedConversationOrThrow(
      userDb,
      userId,
      conversationId,
      "conversations.messages",
    );
    
    const messages = await listConversationMessagesOrThrow(
      userDb,
      userId,
      conversationId,
      "conversations.messages",
      { skipOwnershipCheck: true },
    );
    logDbEvent("conversations.messages.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId,
      count: messages.length,
    });
    
    // Return both conversation metadata (with title) and messages
    res.json({
      conversation: {
        id: conversation.id,
        title: conversation.title || "New Chat",
        created_at: conversation.created_at,
      },
      message_count: messages.length,
      messages,
    });
  }),
);

// ===============================
// DELETE /api/conversations/:id
// ===============================
app.delete(
  "/api/conversations/:id",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const conversationId = req.params.id?.trim();
    if (!conversationId) {
      res.status(400).json({ error: "Conversation id is required." });
      return;
    }
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.delete");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.delete");
    await ensureNamedWorkspaceProfile(userId, "conversations.delete", userDb);
    await deleteConversationIfOwned(userDb, userId, conversationId, "conversations.delete");
    res.json({ success: true });
  }),
);

// ===============================
// GET /api/memories
// ===============================
app.get(
  "/api/memories",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const userDb = await resolveUserDatabaseOrThrow(userId, "memories.list");
    try {
      await initializeUserSessionOrThrow(userDb, userId, "memories.list");
    } catch (sessionError) {
      logDbFailure(
        "memories.list.session-init",
        userId,
        sessionError instanceof Error ? sessionError : new Error(String(sessionError)),
      );
    }
    await ensureNamedWorkspaceProfile(userId, "memories.list", userDb);
    const memories = await listMemoriesOrThrow(userDb, userId, "memories.list");
    res.json({ memories });
  }),
);

// ===============================
// DELETE /api/memories/:id
// ===============================
app.delete(
  "/api/memories/:id",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const memoryId = req.params.id?.trim();
    if (!memoryId) {
      res.status(400).json({ error: "Memory id is required." });
      return;
    }
    const userDb = await resolveUserDatabaseOrThrow(userId, "memories.delete");
    await initializeUserSessionOrThrow(userDb, userId, "memories.delete");
    await ensureNamedWorkspaceProfile(userId, "memories.delete", userDb);
    await deleteMemoryIfOwned(userDb, userId, memoryId, "memories.delete");
    res.json({ success: true });
  }),
);

// ===============================
// POST /api/chat — Main conversation endpoint (v2: orchestrated)
// ===============================
app.post(
  "/api/chat",
  verifyJWT({ allowGuest: true }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const normalizedRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );
    const { sub: userId, isGuest } = getRequestUser(req);
    const webSearchMode = getExplicitWebSearchMode(parsed.data.context?.web_search_mode);
    const hasExplicitWebSearchMode = Boolean(webSearchMode);
    const isReasoningQuery = isBufferedReasoningQuery(parsed.data.message);
    const isMathReasoningQuery = !detectCodeQuery(parsed.data.message) && isMathQuery(parsed.data.message);
    const isLogicReasoningQuery = isReasoningQuery && !isMathReasoningQuery;

    // Prompt injection detection
    if (detectPromptInjection(parsed.data.message)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    // v2: Route through the AI orchestrator
    // Always include file_references when present — the frontend only sends
    // the current session file (scoped correctly), so no backend gating needed.
    const orcFileRefs = parsed.data.context?.file_references;
    const orcImageAttachments = parsed.data.context?.image_attachments;
    if (Array.isArray(orcFileRefs) && orcFileRefs.length > 0) {
      console.log(`[File] orchestrator: ${orcFileRefs.length} file(s) included in context`);
    }
    if (Array.isArray(orcImageAttachments) && orcImageAttachments.length > 0) {
      console.log(`[Image] orchestrator: ${orcImageAttachments.length} image attachment(s) included in context`);
    }

    if (isGuest && hasExplicitWebSearchMode) {
      const result = await orchestrate({
        userMessage: parsed.data.message,
        context: {
          recent_messages: normalizedRecentMessages,
          memories: [],
          file_references: orcFileRefs,
          image_attachments: orcImageAttachments,
          web_search_mode: webSearchMode,
          userId,
        },
      });

      res.json({
        route: result.route,
        answer: result.answer ?? result.reply,
        reply: result.reply,
        thinking: gateThinking(result.thinking, { route: result.route, isReasoning: isReasoningQuery }),
        disclaimer: result.disclaimer,
        image: result.image,
        chart: result.chart,
        memory: result.memory,
        web_search: result.web_search,
        confidence: result.confidence,
        model_used: result.model_used,
        searched: result.searched === true,
      });
      return;
    }

    if (isGuest) {
      const guestContext = await buildContext({
        recent_messages: normalizedRecentMessages,
        memories: [],
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        web_search_mode: webSearchMode,
        userMessage: parsed.data.message,
      }, undefined, userId);

      const guestResult = await handleChat({
        userMessage: parsed.data.message,
        recentMessages: guestContext.recentMessages,
        memories: [],
        fileReferences: guestContext.fileReferences,
        imageAttachments: guestContext.imageAttachments,
        conversationSummary: guestContext.conversationSummary,
        priorConversationEvidence: guestContext.priorConversationEvidence,
        isExplicitRecallQuery: guestContext.isExplicitRecallQuery,
        modelOverride: GUEST_MODEL_OVERRIDE,
        userId,
        reasoningMode: isReasoningQuery,
      });

      res.json({
        route: "chat",
        answer: guestResult.answer,
        reply: guestResult.reply,
        thinking: gateThinking(guestResult.thinking, { modelOverride: GUEST_MODEL_OVERRIDE, isReasoning: isReasoningQuery }),
        disclaimer: guestResult.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
        model_used: guestResult.model_used,
        searched: false,
      });
      return;
    }

    const sync = {
      persisted: true,
      deferred: false,
      conversationId: undefined as string | undefined,
    };

    let createdConversation = false;
    let activeConversationTitle: string | null = null;
    let userMessagePersisted = false;
    let assistantMessagePersisted = false;

    let userDb: any = null;
    let activeConversationId = parsed.data.conversationId || null;
    try {
      userDb = await resolveUserDatabaseOrThrow(userId, "chat");
      await initializeUserSessionOrThrow(userDb, userId, "chat");
    } catch (bootstrapError) {
      sync.persisted = false;
      sync.deferred = true;
      logDbFailure(
        "chat.bootstrap",
        userId,
        bootstrapError instanceof Error ? bootstrapError : new Error(String(bootstrapError)),
      );
      userDb = null;
    }

    const trustedProfile = await ensureNamedWorkspaceProfile(userId, "chat", userDb || undefined);

    if (userDb && activeConversationId) {
      try {
        const conversationRow = await getOwnedConversationOrThrow(
          userDb,
          userId,
          activeConversationId,
          "chat",
        );
        sync.conversationId = activeConversationId;
        activeConversationTitle = typeof conversationRow.title === "string" ? conversationRow.title : null;
      } catch (conversationLookupError) {
        sync.deferred = true;
        const normalizedLookupError =
          conversationLookupError instanceof Error
            ? conversationLookupError
            : new Error(String(conversationLookupError));
        if (normalizedLookupError instanceof HttpError && normalizedLookupError.statusCode === 404) {
          logDbEvent("chat.conversation.resolve.not-found", userId, { conversationId: activeConversationId });
        } else {
          sync.persisted = false;
          logDbFailure("chat.conversation.resolve", userId, normalizedLookupError, {
            conversationId: activeConversationId,
          });
        }
        activeConversationId = null;
      }
    }
    if (userDb && !activeConversationId) {
      try {
        const conversationRow = await createConversationOrThrow(userDb, userId, "chat");
        activeConversationId = conversationRow.id;
        sync.conversationId = activeConversationId;
        activeConversationTitle = conversationRow.title || null;
        createdConversation = true;
      } catch (conversationCreateError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.conversation.create",
          userId,
          conversationCreateError instanceof Error ? conversationCreateError : new Error(String(conversationCreateError)),
        );
        activeConversationId = null;
      }
    }
    if (userDb && activeConversationId) {
      try {
        await insertConversationMessageOrThrow(
          userDb,
          userId,
          activeConversationId,
          "user",
          parsed.data.message,
          "chat",
          { clientRequestId: parsed.data.clientRequestId },
        );
        userMessagePersisted = true;
      } catch (userMessagePersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.user-message.persist",
          userId,
          userMessagePersistError instanceof Error ? userMessagePersistError : new Error(String(userMessagePersistError)),
          { conversationId: activeConversationId },
        );
      }
    }

    if (isLogicReasoningQuery && !hasExplicitWebSearchMode) {
      const reasoningContext = await buildContext({
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        trustedProfile,
        web_search_mode: webSearchMode,
        userMessage: parsed.data.message,
        conversationId: activeConversationId || undefined,
      }, userDb, userId);

      const result = await handleChat({
        userMessage: parsed.data.message,
        recentMessages: reasoningContext.recentMessages,
        memories: reasoningContext.memories,
        fileReferences: reasoningContext.fileReferences,
        imageAttachments: reasoningContext.imageAttachments,
        conversationSummary: reasoningContext.conversationSummary,
        priorConversationEvidence: reasoningContext.priorConversationEvidence,
        isExplicitRecallQuery: reasoningContext.isExplicitRecallQuery,
        trustedProfile: reasoningContext.trustedProfile,
        userId,
        reasoningMode: true,
      });

      if (userDb && activeConversationId) {
        try {
          await insertConversationMessageOrThrow(
            userDb,
            userId,
            activeConversationId,
            "assistant",
            result.reply ?? "",
            "chat",
          );
          assistantMessagePersisted = true;
        } catch (assistantPersistError) {
          sync.persisted = false;
          sync.deferred = true;
          logDbFailure(
            "chat.assistant-message.persist",
            userId,
            assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
            { conversationId: activeConversationId },
          );
        }
      }

      if (
        userDb &&
        activeConversationId &&
        userMessagePersisted &&
        (createdConversation || !activeConversationTitle || activeConversationTitle === "New Chat")
      ) {
        scheduleAutoTitleConversation({
          userDb,
          userId,
          conversationId: activeConversationId,
          userMessage: parsed.data.message,
          assistantReply: result.reply ?? "",
          scope: "chat.title.auto",
          currentTitle: activeConversationTitle,
        });
      }

      if (activeConversationId) {
        logMessagePersistenceGap("chat", userId, {
          conversationId: activeConversationId,
          userMessagePersisted,
          assistantMessagePersisted,
          assistantExpected: Boolean(result.reply),
          deferred: sync.deferred,
          created: createdConversation,
          route: "reasoning",
        });
      }

      res.json({
        route: "chat",
        answer: result.answer,
        reply: result.reply,
        thinking: gateThinking(result.thinking, { isReasoning: true }),
        disclaimer: result.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
        model_used: result.model_used,
        searched: false,
        sync,
      });
      return;
    }

    const result = await orchestrate({
      userMessage: parsed.data.message,
      context: {
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        trustedProfile,
        web_search_mode: webSearchMode,
        userDb,
        userId,
        conversationId: activeConversationId || undefined,
      },
    });

    if (userDb && activeConversationId) {
      try {
        await insertConversationMessageOrThrow(
          userDb,
          userId,
          activeConversationId,
          "assistant",
          result.reply ?? "",
          "chat",
        );
        assistantMessagePersisted = true;
      } catch (assistantPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.assistant-message.persist",
          userId,
          assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
          { conversationId: activeConversationId },
        );
      }
    }

    let responseMemory = result.memory;
    if (userDb && result.memory && result.memory.stored === true) {
      try {
        const insertedMemory = await insertMemoryOrThrow(
          userDb,
          userId,
          {
            ...result.memory,
            scope: result.memory.type === "project" ? "chat" : "global",
            chat_id: result.memory.type === "project" ? activeConversationId : null,
          },
          "chat",
        );
        responseMemory = {
          ...result.memory,
          id: insertedMemory.id,
          scope: insertedMemory.scope === "chat" ? "chat" : "global",
          chat_id: insertedMemory.chat_id ?? null,
        };
      } catch (memoryPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.memory.persist",
          userId,
          memoryPersistError instanceof Error ? memoryPersistError : new Error(String(memoryPersistError)),
          { conversationId: activeConversationId },
        );
      }
    }

    if (
      userDb &&
      activeConversationId &&
      userMessagePersisted &&
      (createdConversation || !activeConversationTitle || activeConversationTitle === "New Chat")
    ) {
      scheduleAutoTitleConversation({
        userDb,
        userId,
        conversationId: activeConversationId,
        userMessage: parsed.data.message,
        assistantReply: result.reply ?? "",
        scope: "chat.title.auto",
        currentTitle: activeConversationTitle,
      });
    }

    if (activeConversationId) {
      logMessagePersistenceGap("chat", userId, {
        conversationId: activeConversationId,
        userMessagePersisted,
        assistantMessagePersisted,
        assistantExpected: Boolean(result.reply),
        deferred: sync.deferred,
        created: createdConversation,
        route: result.route,
      });
    }

    res.json({
      route: result.route,
      answer: result.answer ?? result.reply,
      reply: result.reply,
      thinking: gateThinking(result.thinking, { route: result.route, isReasoning: isReasoningQuery }),
      disclaimer: result.disclaimer,
      image: result.image,
      chart: result.chart,
      memory: responseMemory,
      web_search: result.web_search,
      confidence: result.confidence,
      model_used: result.model_used,
      searched: result.searched === true,
      sync,
    });
  }),
);

// ===============================
// POST /api/chat/stream — SSE streaming chat endpoint
// ===============================
app.post(
  "/api/chat/stream",
  verifyJWT({ allowGuest: true }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    let clientDisconnected = false;
    req.on("close", () => { clientDisconnected = true; });

    const sseWriter = createSseWriter(res, { maxBufferedBytes: 512 * 1024 });
    const writeSseEvent = async (payload: string) => {
      if (clientDisconnected) return;
      await sseWriter.write(payload);
    };
    const writeSseJson = async (payload: unknown) => {
      await writeSseEvent(JSON.stringify(payload));
    };
    const finishSse = () => {
      sseWriter.close();
    };

    const streamBufferedAnswer = async (
      answer: string,
      thinking?: string,
      showThinking = false,
      metrics?: StreamMetrics,
    ) => {
      const chunkSize = 128;

      for (let i = 0; i < answer.length; i += chunkSize) {
        if (clientDisconnected) break;
        const chunk = answer.slice(i, i + chunkSize);
        if (metrics) {
          recordStreamChunk(metrics, chunk);
        }
        await writeSseJson({ type: "token", text: chunk });
      }

      if (showThinking && thinking && thinking.trim()) {
        await writeSseJson({ type: "thinking", text: thinking.trim() });
      }
    };

    const sendStreamError = async (err: unknown, metrics?: StreamMetrics) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Stream] error: ${message}`);
      if (!clientDisconnected) {
        try {
          await writeSseJson({
            type: "error",
            error: message,
            partial: Boolean(metrics && metrics.chunkCount > 0),
            streamed_chunks: metrics?.chunkCount ?? 0,
            approx_tokens: metrics?.approxTokens ?? 0,
          });
          await writeSseEvent("[DONE]");
        } catch (writeErr) {
          console.error(`[Stream] failed to emit error event: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
        }
      }
      reportStreamMessageGap(true, "stream.error", message);
      if (metrics) {
        logStreamMetrics(metrics, "error");
      }
    };

    const startStreamHeartbeat = (intervalMs: number, tag: string) => {
      if (!intervalMs || intervalMs <= 0) return () => {};
      const timer = setInterval(() => {
        if (clientDisconnected) return;
        writeSseJson({ type: "heartbeat", tag, ts: Date.now() }).catch((err) => {
          console.warn(`[Stream] heartbeat failed: ${err instanceof Error ? err.message : err}`);
        });
      }, intervalMs);
      return () => clearInterval(timer);
    };

    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    if (detectPromptInjection(parsed.data.message)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    // ── Safety gate: chart requests MUST go through the orchestrator ──
    // The streaming path does not support tool execution (charts, images, etc.).
    // If the message is a chart request, redirect to the orchestrator and return
    // the result as a single SSE JSON payload so the frontend can render it.
    const normalizedRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );
    const { sub: userId, isGuest } = getRequestUser(req);
    const webSearchMode = getExplicitWebSearchMode(parsed.data.context?.web_search_mode);
    const hasExplicitWebSearchMode = Boolean(webSearchMode);
    const isBufferedReasoning = isBufferedReasoningQuery(parsed.data.message);
    const isMathReasoningQuery = !detectCodeQuery(parsed.data.message) && isMathQuery(parsed.data.message);
    if (isGuest && hasExplicitWebSearchMode) {
      const result = await orchestrate({
        userMessage: parsed.data.message,
        context: {
          recent_messages: normalizedRecentMessages,
          memories: [],
          file_references: parsed.data.context?.file_references,
          image_attachments: parsed.data.context?.image_attachments,
          web_search_mode: webSearchMode,
          userId,
        },
      });
      res.json({
        route: result.route,
        answer: result.answer ?? result.reply,
        reply: result.reply,
        thinking: gateThinking(result.thinking, { route: result.route, isReasoning: isBufferedReasoning }),
        disclaimer: result.disclaimer,
        image: result.image,
        chart: result.chart,
        memory: result.memory,
        web_search: result.web_search,
        confidence: result.confidence,
        model_used: result.model_used,
        searched: result.searched === true,
      });
      return;
    }

    if (isGuest) {
      const requestStart = Date.now();
      console.log(`[Latency] guest user query received`);

      if (isBufferedReasoning) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const streamMetrics = createStreamMetrics(
          "chat.stream.guest.reasoning",
          requestStart,
          { model: isMathReasoningQuery ? "orchestrator" : GUEST_MODEL_OVERRIDE },
        );

        try {
          if (isMathReasoningQuery) {
            const result = await orchestrate({
            userMessage: parsed.data.message,
            context: {
                recent_messages: normalizedRecentMessages,
                memories: [],
                file_references: parsed.data.context?.file_references,
                image_attachments: parsed.data.context?.image_attachments,
                web_search_mode: webSearchMode,
                userId,
              },
            });
            if (!clientDisconnected) {
              const thinking = gateThinking(result.thinking, { route: result.route, isReasoning: true });
              await streamBufferedAnswer(result.reply ?? "", thinking, true, streamMetrics);
              await writeSseEvent("[DONE]");
              logStreamMetrics(streamMetrics, "complete");
            }
            return;
          }

          const guestReasoningContext = await buildContext({
            recent_messages: normalizedRecentMessages,
            memories: [],
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            web_search_mode: webSearchMode,
            userMessage: parsed.data.message,
          }, undefined, userId);

          const result = await handleChat({
            userMessage: parsed.data.message,
            recentMessages: guestReasoningContext.recentMessages,
            memories: [],
            fileReferences: guestReasoningContext.fileReferences,
            imageAttachments: guestReasoningContext.imageAttachments,
            conversationSummary: guestReasoningContext.conversationSummary,
            priorConversationEvidence: guestReasoningContext.priorConversationEvidence,
            isExplicitRecallQuery: guestReasoningContext.isExplicitRecallQuery,
            modelOverride: GUEST_MODEL_OVERRIDE,
            userId,
            reasoningMode: true,
          });

          if (!clientDisconnected) {
            const thinking = gateThinking(result.thinking, { isReasoning: true });
            await streamBufferedAnswer(result.reply, thinking, true, streamMetrics);
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "complete");
          }
        } catch (err) {
          await sendStreamError(err, streamMetrics);
        } finally {
          finishSse();
        }
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const fileRefs = parsed.data.context?.file_references;
      const guestCtx = await buildContextFast({
        recent_messages: normalizedRecentMessages,
        memories: [],
        file_references: fileRefs,
        image_attachments: parsed.data.context?.image_attachments,
        web_search_mode: webSearchMode,
        userMessage: parsed.data.message,
      }, undefined, userId);

      const guestFastPath = !guestCtx.hasFileContext
        && parsed.data.message.length <= 280
        && !detectCodeQuery(parsed.data.message)
        && !isMathQuery(parsed.data.message);
      const streamMetrics = createStreamMetrics(
        "chat.stream.guest.general",
        requestStart,
        { model: GUEST_MODEL_OVERRIDE, fastPath: guestFastPath },
      );

      console.log(`[Latency] guest buffered response request started (+${Date.now() - requestStart}ms)`);
      console.log(`[Stream] guest model=${GUEST_MODEL_OVERRIDE} hasFiles=${guestCtx.hasFileContext} msgLen=${parsed.data.message.length}`);

      try {
        const streamStart = Date.now();
        const call = buildChatPrompt({
          userMessage: parsed.data.message,
          recentMessages: guestCtx.recentMessages,
          memories: [],
          fileReferences: guestCtx.fileReferences,
          imageAttachments: guestCtx.imageAttachments,
          conversationSummary: guestCtx.conversationSummary,
          priorConversationEvidence: guestCtx.priorConversationEvidence,
          isExplicitRecallQuery: guestCtx.isExplicitRecallQuery,
          modelOverride: GUEST_MODEL_OVERRIDE,
          userId,
          streaming: true,
        });
        const adapterStream = await callLLMAdapterStream(call);
        const reader = adapterStream.getReader();

        while (true) {
          if (clientDisconnected) break;
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          recordStreamChunk(streamMetrics, value);
          await writeSseJson({ type: "token", text: value });
        }

        if (!clientDisconnected) {
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
        }
        console.log(`[Stream] guest live stream completed in ${Date.now() - streamStart}ms`);
      } catch (err) {
        await sendStreamError(err, streamMetrics);
      } finally {
        finishSse();
      }
      return;
    }

    const conversationId = parsed.data.conversationId || null;
    let activeConversationId = conversationId;
    const sync = {
      persisted: true,
      deferred: false,
      conversationId: activeConversationId,
    };
    let createdConversation = false;
    let activeConversationTitle: string | null = null;
    let userMessagePersisted = false;
    let assistantMessagePersisted = false;
    let userDb: any = null;
    try {
      userDb = await resolveUserDatabaseOrThrow(userId, "chat.stream");
      await initializeUserSessionOrThrow(userDb, userId, "chat.stream");
    } catch (dbBootstrapError) {
      sync.persisted = false;
      sync.deferred = true;
      logDbFailure(
        "chat.stream.bootstrap",
        userId,
        dbBootstrapError instanceof Error ? dbBootstrapError : new Error(String(dbBootstrapError)),
        { conversationId: activeConversationId },
      );
    }
    const trustedProfile = await ensureNamedWorkspaceProfile(userId, "chat.stream", userDb || undefined);
    if (userDb && activeConversationId) {
      try {
        const conversationRow = await getOwnedConversationOrThrow(
          userDb,
          userId,
          activeConversationId,
          "chat.stream",
        );
        activeConversationTitle = typeof conversationRow.title === "string" ? conversationRow.title : null;
      } catch (conversationOwnershipError) {
        sync.deferred = true;
        const normalizedOwnershipError =
          conversationOwnershipError instanceof Error
            ? conversationOwnershipError
            : new Error(String(conversationOwnershipError));
        if (normalizedOwnershipError instanceof HttpError && normalizedOwnershipError.statusCode === 404) {
          logDbEvent("chat.stream.conversation-resolve.not-found", userId, { conversationId: activeConversationId });
        } else {
          sync.persisted = false;
          logDbFailure("chat.stream.conversation-resolve", userId, normalizedOwnershipError, {
            conversationId: activeConversationId,
          });
        }
        activeConversationId = null;
      }
    }
    if (userDb && !activeConversationId) {
      try {
        const conversationRow = await createConversationOrThrow(userDb, userId, "chat.stream");
        activeConversationId = conversationRow.id;
        activeConversationTitle = conversationRow.title || null;
        createdConversation = true;
      } catch (conversationCreateError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.conversation-create",
          userId,
          conversationCreateError instanceof Error ? conversationCreateError : new Error(String(conversationCreateError)),
        );
      }
    }
    sync.conversationId = activeConversationId;
    if (userDb && activeConversationId) {
      try {
        await insertConversationMessageOrThrow(
          userDb,
          userId,
          activeConversationId,
          "user",
          parsed.data.message,
          "chat.stream",
          { clientRequestId: parsed.data.clientRequestId },
        );
        userMessagePersisted = true;
      } catch (messagePersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.user-message",
          userId,
          messagePersistError instanceof Error ? messagePersistError : new Error(String(messagePersistError)),
          { conversationId: activeConversationId },
        );
      }
    }

    const persistAssistantMessage = async (content: string) => {
      if (!userDb || !activeConversationId) {
        sync.persisted = false;
        sync.deferred = true;
        return;
      }
      try {
        await insertConversationMessageOrThrow(
          userDb,
          userId,
          activeConversationId,
          "assistant",
          content,
          "chat.stream",
        );
        assistantMessagePersisted = true;
        if (
          userMessagePersisted &&
          (createdConversation || !activeConversationTitle || activeConversationTitle === "New Chat")
        ) {
          scheduleAutoTitleConversation({
            userDb,
            userId,
            conversationId: activeConversationId,
            userMessage: parsed.data.message,
            assistantReply: content,
            scope: "chat.stream.title.auto",
            currentTitle: activeConversationTitle,
          });
        }
      } catch (assistantPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.assistant-message",
          userId,
          assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
          { conversationId: activeConversationId },
        );
      }
    };

    const persistStoredMemory = async (memory?: {
      id?: string;
      stored?: boolean;
      type?: string;
      summary?: string;
      importance?: number;
      scope?: MemoryScope;
      chat_id?: string | null;
    }) => {
      if (!memory || memory.stored !== true) return;
      if (!userDb) {
        sync.persisted = false;
        sync.deferred = true;
        return;
      }
      const normalizedScope: MemoryScope = memory.scope === "chat" || memory.type === "project"
        ? "chat"
        : "global";
      const memoryChatId = normalizedScope === "chat" ? activeConversationId ?? memory.chat_id ?? null : null;
      try {
        const insertedMemory = await insertMemoryOrThrow(
          userDb,
          userId,
          {
            ...memory,
            scope: normalizedScope,
            chat_id: memoryChatId,
          },
          "chat.stream",
        );
        memory.id = insertedMemory.id;
        memory.scope = (insertedMemory.scope === "chat" ? "chat" : "global");
        memory.chat_id = insertedMemory.chat_id ?? null;
      } catch (memoryPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.memory",
          userId,
          memoryPersistError instanceof Error ? memoryPersistError : new Error(String(memoryPersistError)),
          { conversationId: activeConversationId },
        );
      }
    };

    const reportStreamMessageGap = (assistantExpected: boolean, route: string, error?: string) => {
      if (!activeConversationId) return;
      logMessagePersistenceGap("chat.stream", userId, {
        conversationId: activeConversationId,
        userMessagePersisted,
        assistantMessagePersisted,
        assistantExpected,
        deferred: sync.deferred,
        created: createdConversation,
        route,
        clientDisconnected,
        error: error || null,
      });
    };

    if (hasExplicitWebSearchMode) {
      console.log(`[Stream] explicit WebSurf mode=${webSearchMode} - redirecting to orchestrator`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: webSearchMode,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        reportStreamMessageGap(Boolean(result.reply), "orchestrator.web_search");
        res.json({
          route: result.route,
          answer: result.answer ?? result.reply,
          reply: result.reply,
          thinking: gateThinking(result.thinking, { route: result.route }),
          disclaimer: result.disclaimer,
          image: result.image,
          chart: result.chart,
          memory: result.memory,
          web_search: result.web_search,
          confidence: result.confidence,
          model_used: result.model_used,
          searched: result.searched === true,
          sync,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] explicit WebSurf orchestration failed: ${message}`);
        res.status(500).json({ error: message });
      }
      return;
    }

    if (detectExplicitMemoryWriteIntent(parsed.data.message)) {
      console.log(`[Stream] explicit memory write detected — redirecting to orchestrator`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: webSearchMode,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        reportStreamMessageGap(Boolean(result.reply), "orchestrator.memory");
        res.json({
          route: result.route,
          answer: result.answer ?? result.reply,
          reply: result.reply,
          thinking: gateThinking(result.thinking, { route: result.route }),
          disclaimer: result.disclaimer,
          image: result.image,
          chart: result.chart,
          memory: result.memory,
          web_search: result.web_search,
          confidence: result.confidence,
          model_used: result.model_used,
          searched: result.searched === true,
          sync,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] memory orchestration failed: ${message}`);
        res.status(500).json({ error: message });
      }
      return;
    }

    if (isChartRequest(parsed.data.message)) {
      console.log(`[Stream] chart request detected — redirecting to orchestrator`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: webSearchMode,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        reportStreamMessageGap(Boolean(result.reply), "orchestrator.chart");
        // Return the full orchestrator result as JSON (not SSE) so the frontend
        // can use deliverAssistantResponse to render the chart.
        res.json({
          route: result.route,
          answer: result.answer ?? result.reply,
          reply: result.reply,
          thinking: gateThinking(result.thinking, { route: result.route }),
          disclaimer: result.disclaimer,
          image: result.image,
          chart: result.chart,
          memory: result.memory,
          web_search: result.web_search,
          confidence: result.confidence,
          model_used: result.model_used,
          searched: result.searched === true,
          sync,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] chart orchestration failed: ${message}`);
        res.status(500).json({ error: message });
      }
      return;
    }

    // ── Safety gate: math queries use the direct math pipeline via orchestrator ──
    // Math queries need the direct openai-large pipeline, which
    // is only available through the orchestrator.  Redirect like chart requests.
    if (isBufferedReasoning) {
      console.log(`[Stream] buffered reasoning query detected - streaming SSE response`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const streamMetrics = createStreamMetrics(
        "chat.stream.reasoning",
        Date.now(),
        { model: isMathReasoningQuery ? "orchestrator" : "openai-large" },
      );
      const stopHeartbeat = startStreamHeartbeat(10_000, "reasoning");

      try {
        if (isMathReasoningQuery) {
          const result = await orchestrate({
            userMessage: parsed.data.message,
            context: {
              recent_messages: normalizedRecentMessages,
              memories: parsed.data.context?.memories,
              file_references: parsed.data.context?.file_references,
              image_attachments: parsed.data.context?.image_attachments,
              trustedProfile,
              web_search_mode: webSearchMode,
              conversationId: activeConversationId || undefined,
              userDb,
              userId,
            },
          });
          if (result.reply) {
            await persistAssistantMessage(result.reply);
          }
          await persistStoredMemory(result.memory);
          reportStreamMessageGap(Boolean(result.reply), "reasoning.math");
          if (!clientDisconnected) {
            const thinking = gateThinking(result.thinking, { route: result.route, isReasoning: true });
            await streamBufferedAnswer(result.reply ?? "", thinking, true, streamMetrics);
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "complete");
          }
          return;
        }

        const reasoningContext = await buildContext({
          recent_messages: normalizedRecentMessages,
          memories: parsed.data.context?.memories,
          file_references: parsed.data.context?.file_references,
          image_attachments: parsed.data.context?.image_attachments,
          trustedProfile,
          web_search_mode: webSearchMode,
          userMessage: parsed.data.message,
          conversationId: activeConversationId || undefined,
        }, userDb, userId);

        const result = await handleChat({
          userMessage: parsed.data.message,
          recentMessages: reasoningContext.recentMessages,
          memories: reasoningContext.memories,
          fileReferences: reasoningContext.fileReferences,
          imageAttachments: reasoningContext.imageAttachments,
          conversationSummary: reasoningContext.conversationSummary,
          priorConversationEvidence: reasoningContext.priorConversationEvidence,
          isExplicitRecallQuery: reasoningContext.isExplicitRecallQuery,
          trustedProfile: reasoningContext.trustedProfile,
          userId,
          reasoningMode: true,
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        reportStreamMessageGap(Boolean(result.reply), "reasoning");
        if (!clientDisconnected) {
          const thinking = gateThinking(result.thinking, { isReasoning: true });
          await streamBufferedAnswer(result.reply, thinking, true, streamMetrics);
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
        }
      } catch (err) {
        await sendStreamError(err, streamMetrics);
      } finally {
        stopHeartbeat();
        finishSse();
      }
      return;
    }

    // ── Safety gate: web search queries require real-time information ──
    // If the query requires web search (e.g., "2026 NVIDIA news", "latest stock price"),
    // redirect to orchestrator which handles the Tavily pipeline.
    const queryClassification = classifyQueryType(parsed.data.message);
    const forceWebSearch = shouldForceWebSearch(parsed.data.message);
    const tavilyAvailable = isTavilyAvailable();
    
    // Diagnostic logging for web search routing
    console.log(`[WebSearchCheck] query="${parsed.data.message.slice(0, 50)}..." needsWebSearch=${queryClassification.needsWebSearch} forceWebSearch=${forceWebSearch} tavilyAvailable=${tavilyAvailable} rule=${queryClassification.matchedRule} category=${queryClassification.category}`);
    
    if ((queryClassification.needsWebSearch || forceWebSearch) && tavilyAvailable) {
      console.log(`[Stream] web search detected — redirecting to orchestrator (rule: ${queryClassification.matchedRule}, category: ${queryClassification.category})`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: webSearchMode,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        reportStreamMessageGap(Boolean(result.reply), "orchestrator.web_search_auto");
        res.json({
          ...result,
          searched: result.searched === true,
          sync,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
      return;
    }

    const requestStart = Date.now();
    console.log(`[Latency] user query received`);

    // Set SSE headers IMMEDIATELY - start streaming as fast as possible
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Always include file_references when present — the frontend only sends
    // the current session file (scoped correctly), so no backend gating needed.
    const fileRefs = parsed.data.context?.file_references;
    const imageAttachments = parsed.data.context?.image_attachments;
    const hasFile = Array.isArray(fileRefs) && fileRefs.length > 0;
    const hasImage = Array.isArray(imageAttachments) && imageAttachments.length > 0;
    if (hasFile || hasImage) {
      console.log(`[File] stream: files=${fileRefs?.length ?? 0} images=${imageAttachments?.length ?? 0}`);
    }

    const recentMessageCount = normalizedRecentMessages.length;
    const lowComplexity =
      parsed.data.message.length <= 280 &&
      recentMessageCount <= 6 &&
      !detectCodeQuery(parsed.data.message) &&
      !isMathQuery(parsed.data.message);

    // Extract file names and content for coding PDF detection
    const fileNames = hasFile ? fileRefs.map((f: { filename?: string }) => f.filename || "") : undefined;
    const fileContent = hasFile ? fileRefs.map((f: { extractedText?: string }) => f.extractedText || "").join("\n") : undefined;

    const modelOverride = selectModelForPrompt(parsed.data.message, undefined, { 
      hasImage, 
      hasFile,
      fileNames,
      fileContent,
    });

    const fastPathEligible =
      !hasFile &&
      !hasImage &&
      lowComplexity &&
      !isBufferedReasoning &&
      !queryClassification.needsWebSearch &&
      !forceWebSearch;

    console.log(
      `[FastPath] eligible=${fastPathEligible} lowComplexity=${lowComplexity} ` +
      `msgLen=${parsed.data.message.length} recentMsgs=${recentMessageCount} hasFile=${hasFile}`,
    );

    // ── FAST context build (NO LLM calls, minimal latency) ──
    // Use buildContextFast which skips conversation compression for speed.
    // This gets the model started ASAP while still providing recent context.
    const ctx = await buildContextFast({
      recent_messages: normalizedRecentMessages,
      memories: parsed.data.context?.memories,
      file_references: fileRefs,
      image_attachments: parsed.data.context?.image_attachments,
      trustedProfile,
      web_search_mode: webSearchMode,
      userMessage: parsed.data.message,
      conversationId: activeConversationId || undefined,
    }, userDb, userId);

    console.log(`[Latency] context built (+${Date.now() - requestStart}ms)`);

    console.log(`[Latency] buffered response request started (+${Date.now() - requestStart}ms)`);
    console.log(`[Stream] model=${modelOverride} hasFiles=${ctx.hasFileContext} msgLen=${parsed.data.message.length}`);
    const streamMetrics = createStreamMetrics(
      "chat.stream.general",
      requestStart,
      { model: modelOverride, fastPath: fastPathEligible },
    );
    let stopHeartbeat = () => {};
    const call = buildChatPrompt({
      userMessage: parsed.data.message,
      recentMessages: ctx.recentMessages,
      memories: ctx.memories,
      fileReferences: ctx.fileReferences,
      imageAttachments: ctx.imageAttachments,
      conversationSummary: ctx.conversationSummary,
      priorConversationEvidence: ctx.priorConversationEvidence,
      isExplicitRecallQuery: ctx.isExplicitRecallQuery,
      trustedProfile: ctx.trustedProfile,
      modelOverride,
      userId,
      streaming: true,
    });

    try {
      const streamStart = Date.now();
      const streamTimeoutMs = modelOverride === "openai-large" ? 240_000 : undefined;
      const streamCall = streamTimeoutMs ? { ...call, timeout_ms: streamTimeoutMs } : call;
      stopHeartbeat = modelOverride === "openai-large"
        ? startStreamHeartbeat(10_000, "openai-large")
        : () => {};
      const adapterStream = await callLLMAdapterStream(streamCall);
      const reader = adapterStream.getReader();
      let fullReply = "";

      while (true) {
        if (clientDisconnected) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        fullReply += value;
        recordStreamChunk(streamMetrics, value);
        await writeSseJson({ type: "token", text: value });
      }

      stopHeartbeat();

      if (!clientDisconnected) {
        if (fullReply) {
          await persistAssistantMessage(fullReply);
        }
        reportStreamMessageGap(Boolean(fullReply), "stream");
        await writeSseEvent("[DONE]");
        logStreamMetrics(streamMetrics, "complete");
        console.log(`[Latency] response completed (+${Date.now() - requestStart}ms)`);
      }
      console.log(`[Stream] live stream completed in ${Date.now() - streamStart}ms`);
    } catch (err) {
      if (modelOverride === "openai-large" && streamMetrics.chunkCount === 0 && !clientDisconnected) {
        try {
          const fallback = await callLLMAdapterDetailed({
            ...call,
            timeout_ms: 180_000,
          });
          const fallbackText = fallback.text || "";
          if (fallbackText) {
            await persistAssistantMessage(fallbackText);
          }
          reportStreamMessageGap(Boolean(fallbackText), "stream.fallback");
          await streamBufferedAnswer(fallbackText, undefined, false, streamMetrics);
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "fallback");
          finishSse();
          return;
        } catch (fallbackErr) {
          console.error(
            `[Stream] openai-large fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
          );
        }
      }
      await sendStreamError(err, streamMetrics);
    } finally {
      stopHeartbeat();
      finishSse();
    }
  }),
);

// ===============================
// POST /api/memory/classify — Standalone memory classification
// ===============================
app.post(
  "/api/memory/classify",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    if (isGuest) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MemoryClassifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "memory.classify");
    await initializeUserSessionOrThrow(userDb, userId, "memory.classify");
    await ensureNamedWorkspaceProfile(userId, "memory.classify", userDb);

    const result = await processMessageForMemory({
      message: parsed.data.message,
      recentMessages: parsed.data.recent_messages,
      userId,
    });

    res.json(result);
  }),
);

// ===============================
// POST /api/memory/compress — Compress old memories
// ===============================
app.post(
  "/api/memory/compress",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    if (isGuest) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = MemoryCompressRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "memory.compress");
    await initializeUserSessionOrThrow(userDb, userId, "memory.compress");
    await ensureNamedWorkspaceProfile(userId, "memory.compress", userDb);

    const result = await compressMemories({
      memories: parsed.data.memories,
      userId,
    });

    res.json(result);
  }),
);

// ===============================
// GET /api/files/updates — SSE stream for async file analysis updates
// ===============================
app.get(
  "/api/files/updates",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    if (isGuest) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await ensureNamedWorkspaceProfile(userId, "files.updates");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const subscriberId = randomUUID();
    const writer = createSseWriter(res, { maxBufferedBytes: 256 * 1024 });
    fileAnalysisSubscribers.set(subscriberId, writer);

    req.on("close", () => {
      fileAnalysisSubscribers.delete(subscriberId);
      writer.close();
    });
  }),
);

// ===============================
// POST /api/files/upload — Upload & extract file
// ===============================
app.post(
  "/api/files/upload",
  verifyJWT({ allowGuest: false }),
  uploadRateLimiter,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    await ensureNamedWorkspaceProfile(userId, "files.upload");
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const validation = validateFileUpload(file.mimetype, file.size, file.originalname);
    if (!validation.valid || !validation.type) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const analysisId = randomUUID();
    const fileType = validation.type;
    const baseEvent = {
      type: "file_analysis" as const,
      analysis_id: analysisId,
      filename: file.originalname,
      file_type: fileType,
      size_bytes: file.size,
    };

    emitFileAnalysisEvent({
      ...baseEvent,
      event: "processing",
      status: "processing",
      updated_at: Date.now(),
    });

    let result: Awaited<ReturnType<typeof extractTextFromFile>>;
    try {
      result = await extractTextFromFile({
        buffer: file.buffer,
        filename: file.originalname,
        mimetype: file.mimetype,
        userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFileAnalysisEvent({
        ...baseEvent,
        event: "error",
        status: "error",
        error: message,
        updated_at: Date.now(),
      });
      res.status(500).json({
        error: message,
        analysis_id: analysisId,
        analysis_status: "error",
        update_protocol: "sse",
        update_endpoint: "/api/files/updates",
      });
      return;
    }

    emitFileAnalysisEvent({
      ...baseEvent,
      event: "update",
      status: "complete",
      extracted_text: result.extracted_text,
      updated_at: Date.now(),
    });

    console.log(`[File Upload] ${result.filename} → type=${result.type}, extracted=${result.extracted_text.length} chars, size=${result.size_bytes}B`);
    if (result.type === "pdf") {
      console.log(`[PDF] chunks created: 1, context length sent to LLM: ${result.extracted_text.length}`);
    }

    // Update file session for this authenticated user.
    const fileSessionKey = getFileSessionKey(req, userId, false);
    fileSessionMap.set(fileSessionKey, {
      filename: result.filename,
      type: result.type,
      extractedText: result.extracted_text,
      uploadTime: Date.now(),
      analysisId,
    });
    console.log(`[FileSession] stored for ${fileSessionKey}: ${result.filename}`);

    res.json({
      filename: result.filename,
      type: result.type,
      extracted_text: result.extracted_text,
      size_bytes: result.size_bytes,
      analysis_id: analysisId,
      analysis_status: "complete",
      update_protocol: "sse",
      update_endpoint: "/api/files/updates",
    });
  }),
);

// ===============================
// GET /api/images/quota — Check remaining image quota
// ===============================
app.get(
  "/api/images/quota",
  verifyJWT({ allowGuest: true }),
  (req, res) => {
    const info = getQuotaInfo(getImageQuotaKey(req));
    res.json(info);
  },
);

// ===============================
// POST /api/images/generate — Generate image from prompt
// ===============================
app.post(
  "/api/images/generate",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  imageQuotaMiddleware,
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const parsed = ImageGenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    // Safety check on image prompts
    if (detectPromptInjection(parsed.data.prompt)) {
      res.status(400).json({ error: "Image prompt rejected by safety filter." });
      return;
    }

    const conversationId = parsed.data.conversationId?.trim() || "";
    const clientRequestId = parsed.data.clientRequestId?.trim() || "";
    let userDb: any = null;
    if (conversationId) {
      userDb = await resolveUserDatabaseOrThrow(userId, "images.generate");
      await initializeUserSessionOrThrow(userDb, userId, "images.generate");
      await ensureNamedWorkspaceProfile(userId, "images.generate", userDb);
      await getOwnedConversationOrThrow(userDb, userId, conversationId, "images.generate");

      const existingAssistantImage = await findExistingAssistantImageMessage(
        userDb,
        conversationId,
        clientRequestId,
      );
      if (existingAssistantImage?.image_url) {
          const quota = getQuotaInfo(getImageQuotaKey(req));
        res.json({
          type: "image",
          url: existingAssistantImage.image_url,
          prompt: existingAssistantImage.prompt || parsed.data.prompt,
          provider_used: existingAssistantImage.provider || undefined,
          success: true,
          remaining: quota.remaining,
          limit: quota.limit,
          image_url: existingAssistantImage.image_url,
          image_base64: undefined,
          storage_path: existingAssistantImage.storage_path || undefined,
          file_size_bytes: existingAssistantImage.file_size_bytes || undefined,
          conversation_id: conversationId,
          persisted: true,
          deduplicated: true,
        });
        return;
      }

      await insertConversationMessageOrThrow(
        userDb,
        userId,
        conversationId,
        "user",
        buildImagePromptMessageContent(parsed.data.prompt),
        "images.generate",
        { clientRequestId },
      );
    } else {
      await ensureNamedWorkspaceProfile(userId, "images.generate");
    }

    const result = await routeImageGeneration({
      prompt: parsed.data.prompt,
      size: parsed.data.size,
    });

    if (!result.success) {
      console.log(`[IMAGE] endpoint failed prompt="${parsed.data.prompt.slice(0, 40)}..." error="${result.error}"`);
      res.status(502).json({ error: result.error });
      return;
    }

    let imageUrl = result.image_url
      || (result.image_base64 ? `data:image/png;base64,${result.image_base64}` : undefined);
    let imageBase64 = result.image_base64;
    let storagePath: string | undefined;
    let fileSizeBytes: number | undefined;

    if (userDb && conversationId) {
      const imageDataForPersistence = result.image_base64 || result.image_url || "";
      if (!imageDataForPersistence) {
        res.status(500).json({
          error: "Image generated, but no image payload was available to save.",
          code: "image_persistence_failed",
        });
        return;
      }

      try {
        const persisted = await persistGeneratedImageResult({
          userDb,
          userId,
          conversationId,
          prompt: parsed.data.prompt,
          generatedImageData: imageDataForPersistence,
          provider: result.provider_used,
          clientRequestId,
          storageDb: getImageStorageDatabase(),
        });

        imageUrl = persisted.assistantMessage.image_url || persisted.storedImage.imageUrl;
        imageBase64 = undefined;
        storagePath = persisted.assistantMessage.storage_path || persisted.storedImage.storagePath;
        fileSizeBytes = persisted.assistantMessage.file_size_bytes || persisted.storedImage.fileSizeBytes;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[IMAGE] persistence failed conversationId=${conversationId} clientRequestId=${clientRequestId || "none"} error="${message}"`,
        );
        res.status(500).json({
          error: "Image was generated, but couldn't be saved to your conversation. Please try again.",
          code: "image_persistence_failed",
        });
        return;
      }
    }

    const quota = getQuotaInfo(getImageQuotaKey(req));

    console.log(`[IMAGE] provider=${result.provider_used} success prompt="${parsed.data.prompt.slice(0, 40)}..." remaining=${quota.remaining}`);

    res.json({
      type: "image",
      url: imageUrl,
      prompt: result.prompt,
      provider_used: result.provider_used,
      success: true,
      remaining: quota.remaining,
      limit: quota.limit,
      // Keep legacy fields for frontend compatibility
      image_url: imageUrl,
      image_base64: imageBase64,
      storage_path: storagePath,
      file_size_bytes: fileSizeBytes,
      conversation_id: conversationId || undefined,
      persisted: Boolean(userDb && conversationId && imageUrl),
    });
  }),
);

// ===============================
// POST /api/images/store — Store a generated image to Supabase Storage
// Stores image in Storage bucket and metadata in database
// ===============================
app.post(
  "/api/images/store",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const { chat_id, image_data, prompt, provider } = req.body;

    // Validate required fields
    if (!chat_id || typeof chat_id !== "string") {
      res.status(400).json({ error: "chat_id is required" });
      return;
    }
    if (!isUuid(chat_id)) {
      res.status(400).json({ error: "chat_id must be a valid conversation id" });
      return;
    }
    if (!image_data || typeof image_data !== "string") {
      res.status(400).json({ error: "image_data (base64 or data URL) is required" });
      return;
    }

    // Get user's database client
    const userDb = await resolveUserDatabaseOrThrow(userId, "images.store");
    if (!userDb) {
      console.error(`[IMAGE_STORE] db.error userId=${userId}`);
      res.status(500).json({ error: "Database not available" });
      return;
    }
    await initializeUserSessionOrThrow(userDb, userId, "images.store");
    await ensureNamedWorkspaceProfile(userId, "images.store", userDb);

    await getOwnedConversationOrThrow(userDb, userId, chat_id, "images.store");

    const imageStorageDb = getImageStorageDatabase();
    const imageStorageDbId = getImageStorageDatabaseId();
    console.log(`[IMAGE_STORE] storage-db userId=${userId} chatId=${chat_id} db=${imageStorageDbId}`);

    // Upload binary to the central image bucket and save metadata on the user's shard.
    const result = await uploadChatImage(
      userDb,
      {
        userId,
        chatId: chat_id,
        imageData: image_data,
        prompt: typeof prompt === "string" ? prompt : undefined,
        provider: typeof provider === "string" ? provider : undefined,
      },
      { storageDb: imageStorageDb },
    );

    if (!result.success) {
      console.error(`[IMAGE_STORE] failed userId=${userId} chatId=${chat_id} error=${result.error}`);
      res.status(500).json({ error: "Failed to store image." });
      return;
    }

    console.log(`[IMAGE_STORE] ok userId=${userId} chatId=${chat_id} imageId=${result.imageId}`);
    res.json({
      success: true,
      image_url: result.imageUrl,
      image_id: result.imageId,
      storage_path: result.storagePath,
      file_size_bytes: result.fileSizeBytes,
    });
  }),
);

// ===============================
// GET /api/images/chat/:chatId — Get all images for a chat
// Returns image metadata (URLs) for rendering
// ===============================
app.get(
  "/api/images/chat/:chatId",
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const chatId = req.params.chatId;

    if (!chatId) {
      res.status(400).json({ error: "chatId is required" });
      return;
    }

    // Get user's database client
    const userDb = await resolveUserDatabaseOrThrow(userId, "images.list");
    if (!userDb) {
      res.status(500).json({ error: "Database not available" });
      return;
    }
    await initializeUserSessionOrThrow(userDb, userId, "images.list");
    await ensureNamedWorkspaceProfile(userId, "images.list", userDb);

    const images = await getChatImages(userDb, userId, chatId);
    res.json({ images });
  }),
);
app.post(
  "/api/charts/generate",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    await ensureNamedWorkspaceProfile(userId, "charts.generate");
    const parsed = ChartGenerateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    if (detectPromptInjection(parsed.data.message)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    const result = await routeChartGeneration({
      userMessage: parsed.data.message,
      fetchPreview: parsed.data.fetch_preview ?? false,
    });

    if (!result.success) {
      console.log(`[CHART] generation failed: ${result.error}`);
      res.status(500).json({ error: result.error });
      return;
    }

    console.log(`[CHART] type=${result.chart_type} renderer=${result.renderer} codeLen=${result.code.length}`);

    res.json({
      type: result.type,
      chart_type: result.chart_type,
      renderer: result.renderer,
      code: result.code,
      preview: result.preview,
      image_base64: result.image_base64,
      image_url: result.image_url,
      plotly_json: result.plotly_json,
      chartjs_config: result.chartjs_config,
      success: true,
    });
  }),
);

// ===============================
// POST /api/chat/selection — "Ask SentIQGPT" text selection context endpoint
// Accepts a selection context payload (selected_text + surrounding lines) and
// routes it through the AI orchestrator as a standard chat message.
// ===============================
app.post(
  "/api/chat/selection",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    const parsed = SelectionContextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const { selected_text, context_before, context_after } = parsed.data;

    // Truncate selected text to 3 lines maximum (server-enforced safety limit)
    const selectedLines = selected_text.split("\n");
    const truncatedSelection = selectedLines.slice(0, 3).join("\n");

    if (detectPromptInjection(truncatedSelection)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    // Build a contextual prompt that includes surrounding lines
    const parts: string[] = [];
    if (context_before?.trim()) {
      parts.push(`[Context before]:\n${context_before.trim()}`);
    }
    parts.push(`[Selected text]:\n${truncatedSelection}`);
    if (context_after?.trim()) {
      parts.push(`[Context after]:\n${context_after.trim()}`);
    }

    const userMessage = parts.join("\n\n");
    const normalizedRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );

    if (isGuest) {
      const guestResult = await handleChat({
        userMessage,
        recentMessages: normalizedRecentMessages,
        memories: [],
        modelOverride: GUEST_MODEL_OVERRIDE,
        userId,
      });

      res.json({
        route: "chat",
        answer: guestResult.answer,
        reply: guestResult.reply,
        thinking: gateThinking(guestResult.thinking, { modelOverride: GUEST_MODEL_OVERRIDE }),
        disclaimer: guestResult.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
      });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "chat.selection");
    await initializeUserSessionOrThrow(userDb, userId, "chat.selection");
    const trustedProfile = await ensureNamedWorkspaceProfile(userId, "chat.selection", userDb);

    const result = await orchestrate({
      userMessage,
      context: {
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        trustedProfile,
        conversationId: parsed.data.conversationId,
        userDb,
        userId,
      },
    });

    res.json({
      route: result.route,
      answer: result.answer ?? result.reply,
      reply: result.reply,
      thinking: gateThinking(result.thinking, { route: result.route }),
      disclaimer: result.disclaimer,
      image: result.image,
      chart: result.chart,
      memory: result.memory,
      confidence: result.confidence,
    });
  }),
);

// ===============================
// POST /api/chat/title — Generate session title from first exchange
// ===============================
app.post(
  "/api/chat/title",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    const { userMessage, assistantReply } = req.body;
    const rawConversationId =
      typeof req.body?.conversationId === "string" && req.body.conversationId.trim()
        ? req.body.conversationId.trim()
        : typeof req.body?.conversation_id === "string" && req.body.conversation_id.trim()
          ? req.body.conversation_id.trim()
          : "";

    if (
      typeof userMessage !== "string" || !userMessage.trim() ||
      typeof assistantReply !== "string" || !assistantReply.trim()
    ) {
      res.status(400).json({ error: "userMessage and assistantReply are required." });
      return;
    }

    let userDb: any = null;
    if (!isGuest) {
      userDb = await resolveUserDatabaseOrThrow(userId, "chat.title");
      await initializeUserSessionOrThrow(userDb, userId, "chat.title");
      await ensureNamedWorkspaceProfile(userId, "chat.title", userDb);
    }

    const cacheScopedConversationId = rawConversationId
      ? rawConversationId
      : `title-${randomUUID()}`;

    const generation = await generateTitleWithFallback({
      userMessage,
      assistantReply,
      conversationId: cacheScopedConversationId,
      userId,
      scope: "chat.title",
      modelOverride: isGuest ? GUEST_MODEL_OVERRIDE : undefined,
    });

    if (!isGuest && userDb && rawConversationId) {
      await persistConversationTitleIfEligible({
        userDb,
        userId,
        conversationId: rawConversationId,
        title: generation.title,
        scope: "chat.title",
      });
    }

    res.json({ title: generation.title });
  }),
);

// ===============================
// POST /api/search — Tavily Web Search Pipeline
// ===============================
import {
  executeTavilySearchPipeline,
  searchTavily,
  getTavilyPipelineStatus,
} from "./tools/webSearch/tavilySearchPipeline";

/**
 * Full web search pipeline with query expansion, parallel search,
 * result aggregation, and LLM synthesis.
 */
app.post(
  "/api/search",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { query, maxResults, skipLLMSynthesis } = req.body;
    const webSearchMode = normalizeWebSearchMode(req.body?.web_search_mode);

    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "Query is required." });
      return;
    }

    console.log(`[API] /api/search - query: "${query.slice(0, 60)}..."`);

    try {
      const result = await executeTavilySearchPipeline({
        query: query.trim(),
        maxResults: typeof maxResults === "number" ? maxResults : undefined,
        skipLLMSynthesis: skipLLMSynthesis === true,
        webSearchMode,
      });

      res.json({
        ...result,
        route: "web_search",
        searched: true,
        model_used: result.provider || "tavily",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[API] /api/search error: ${message}`);
      res.status(500).json({
        success: false,
        query,
        error: "Web search is temporarily unavailable.",
        results: [],
        sources: [],
        queriesUsed: 0,
      });
    }
  }),
);

/**
 * Simple direct Tavily search without pipeline features.
 */
app.post(
  "/api/search/simple",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const { query, maxResults } = req.body;
    const webSearchMode = normalizeWebSearchMode(req.body?.web_search_mode);

    if (typeof query !== "string" || !query.trim()) {
      res.status(400).json({ error: "Query is required." });
      return;
    }

    try {
      const result = await searchTavily(
        query.trim(),
        typeof maxResults === "number" ? maxResults : 5,
        webSearchMode,
      );

    res.json({
      ...result,
      route: "web_search",
      searched: true,
      model_used: "tavily",
    });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, results: [], error: message });
    }
  }),
);

/**
 * GET /api/search/status — Check Tavily pipeline health
 */
app.get("/api/search/status", (_req, res) => {
  const status = getTavilyPipelineStatus();
  res.json(status);
});

// ===============================
// GET /api/config — Server capabilities
// ===============================
app.get("/api/config", (_req, res) => {
  const searchStatus = getTavilyPipelineStatus();
  res.json({
    version: "2.0.0",
    architecture: "orchestrated-dual-model",
    models: {
      reasoning: "gemini",
      cognition: "groq",
    },
    features: {
      chat: true,
      memory: true,
      file_upload: true,
      image_generation: true,
      chart_generation: true,
      tool_detection: true,
      ai_orchestrator: true,
      streaming: true,
      session_title_generation: true,
      knowledge_query: true,
      memory_update: true,
      text_selection_tool: true,
      web_search: searchStatus.available,
    },
    limits: {
      max_message_length: 10000,
      max_file_size_mb: 10,
      allowed_file_types: ["pdf", "txt", "png", "jpg", "jpeg", "webp"],
      max_image_prompt_length: 2000,
      image_quota_per_day: 30,
      image_cooldown_seconds: 5,
    },
  });
});

// ===============================
// GET /api/audit — Recent audit entries (redacted for safety)
// ===============================
app.get(
  "/api/audit",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (_req, res) => {
    if (process.env.SENTIQ_ENABLE_AUDIT_API !== "true") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const entries = getRecentAuditEntries();
    // Redact IP addresses to prevent information disclosure.
    const redacted = entries.map(({ ip, ...rest }) => rest);
    res.json(redacted);
  }),
);

// ===============================
// Global error handler
// ===============================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AuthError) {
    console.warn(`[SentIQGPT] Auth error: ${err.code}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(err.status).json({ error: err.message });
    }
    return;
  }

  // Handle multer errors (file too large, etc.) with clear messages
  if (err && (err as any).code === "LIMIT_FILE_SIZE") {
    console.warn(`[SentIQGPT] File upload rejected: file too large`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    }
    return;
  }
  if (err && err.message && err.message.includes("Multipart")) {
    console.warn(`[SentIQGPT] Multer error: ${err.message}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(400).json({ error: "Invalid file upload. Please try again." });
    }
    return;
  }

  const { statusCode, headers, body } = buildHttpErrorResponse(err);
  const logMethod = statusCode >= 500 ? console.error : console.warn;
  logMethod("[SentIQGPT] Unhandled error:", err.message);
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.status(statusCode).json(body);
});

// ===============================
// Start
// ===============================
verifyShardMigrations().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`[SentIQGPT v2] Server running on port ${PORT}`);
    console.log(`[SentIQGPT v2] Architecture: Orchestrated Dual-Model (Gemini + Groq)`);
    console.log(`[SentIQGPT v2] LLM Service expected on port ${process.env.LLM_SERVICE_PORT || "3002"}`);

    const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
    if (!jwtSecret) {
      console.warn("[SentIQGPT v2] WARNING: SUPABASE_JWT_SECRET is not set; auth will fall back to Supabase and add latency.");
    }

    // Log Tavily availability for debugging
    const tavilyStatus = isTavilyAvailable();
    console.log(`[SentIQGPT v2] Tavily Web Search: ${tavilyStatus ? "ENABLED" : "DISABLED (set TAVILY_KEYS in env)"}`);
  });

  // ---- Graceful shutdown ----
  function gracefulShutdown(signal: string) {
    console.log(`[SentIQGPT] ${signal} received — shutting down gracefully`);
    server.close(() => {
      console.log("[SentIQGPT] HTTP server closed");
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SentIQGPT] FATAL: startup migration verification failed: ${message}`);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[SentIQGPT] UNCAUGHT EXCEPTION (kept alive):", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[SentIQGPT] UNHANDLED REJECTION (kept alive):", reason);
});
