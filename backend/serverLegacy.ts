import { bootProfiler } from "./bootProfiler";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import multer from "multer";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";
import { createHash, randomUUID } from "crypto";
import { attachStreamDisconnectLifecycle } from "./streamDisconnectLifecycle";

bootProfiler.mark("process.start");

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
bootProfiler.enable();
bootProfiler.mark("env.loaded");

// AI handlers
import { classifyImageTextRendering, handleChat } from "./ai/ChatHandler";
import { processMessageForMemory, compressMemories } from "./ai/MemoryProcessor";
import { extractTextFromFile, validateFileUpload } from "./ai/FileIngestionHandler";
import { routeImageGeneration } from "./tools/imageGeneration/imageRouter";
import { routeChartGeneration } from "./tools/chartGeneration/chartRouter";
import { ensureHtmlDocument, getGeneratedFileMimeType, routeFileGeneration } from "./tools/fileGeneration/fileGenerator";
import {
  buildGeneratedFileApiUrl,
  deleteGeneratedFileObject,
  getStorageBucketName,
  hashGeneratedFile,
  updateGeneratedFileMetadata,
  uploadGeneratedFileReplacement,
} from "./tools/fileGeneration/fileStorageService";
import type { GeneratedFileFormat, GeneratedFilePreview } from "./tools/fileGeneration/types";
import { deleteChatImage, uploadChatImage, getChatImages } from "./tools/imageGeneration/imageStorageService";
import {
  buildChatPrompt,
  callLLMAdapter,
  callLLMAdapterDetailed,
  callLLMAdapterStream,
  callLLMAdapterTurnStream,
  buildTitleGeneratePrompt,
  ModelToolTransportError,
  strictParseJsonObject,
} from "./ai/PromptBuilders";
import type { ImageAttachment, LLMAdapterCall } from "./ai/PromptBuilders";
import { buildContext, buildContextFast } from "./context/contextBuilder";
import {
  getControlDatabase,
  getGeneratedFileStorageDatabase,
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
  getConversationAlias,
  getConversationMessages,
  getUserConversations,
  insertConversationMessage,
  mergeDuplicateConversation,
  resolveConversationForTurn,
  updateConversationTitle,
  type ConversationAliasRow,
  type ConversationListRow,
  type ConversationMessageRow,
  type ConversationRow,
  type DuplicateConversationMergeRow,
} from "./services/conversationService";
import {
  decrementUserMemoryUsage,
  deleteMemory,
  getMemoryById,
  getUserMemoryUsageBytes,
  getUserMemories,
  incrementUserMemoryUsage,
  insertAutomaticMemoryOnce,
  insertMemory,
  repairUserMemoryUsage,
  type AutomaticMemoryInsertResult,
  type MemoryRow,
} from "./services/memoryService";
import {
  getMemoryConfirmationText,
  MEMORY_PERSISTENCE_FAILURE_TEXT,
  resolveMemoryScopeForRequest,
  type MemoryScope,
} from "./memory/memoryScope";
import {
  getMirroredUserProfile,
  saveMirroredUserProfile,
  validateDisplayName,
} from "./services/profileService";
import { contextCapsuleService } from "./services/contextCapsuleService";
import { sourceRetrievalService } from "./services/sourceRetrievalService";
import { loadGeminiLiveConfig } from "./live/geminiLiveConfig";
import { GeminiLiveKeyPool } from "./live/geminiLiveKeyPool";
import { GeminiLiveTokenService } from "./live/geminiLiveTokenService";
import { LiveSessionService } from "./live/liveSessionService";
import { SentIQLivePersistence } from "./live/sentiqLivePersistence";
import { registerLiveRoutes } from "./live/liveRoutes";
import { loadLiveTierPolicy } from "./live/liveTierPolicy";
import { LivePlanResolver } from "./live/livePlanResolver";
import { SupabaseLiveUsageStore } from "./live/liveUsageStore";
import {
  buildImagePromptMessageContent,
  findExistingAssistantImageMessage,
  persistGeneratedImageResult,
} from "./services/generatedImagePersistenceService";

// v2 Orchestrator
import { orchestrate } from "./orchestrator/aiOrchestrator";
import {
  executeAutomaticModelToolCalls,
  synthesizeIntuitiveToolResult,
} from "./orchestrator/toolExecutor";
import { consumeModelTurnStream, ModelTurnProgressTracker } from "./ai/modelToolExecution";
import { assertNoUnbackedToolCompletionClaim } from "./ai/modelToolCompletionClaims";
import {
  deriveRequiredModelCapabilities,
  findObsoleteModelToolEnvironmentNames,
  getAutomaticSentIQToolsForRoute,
  getEnabledAutomaticSentIQTools,
  getModelToolRuntimeSnapshot,
  resolveModelToolTransport,
  type RequiredModelCapability,
} from "./ai/modelToolCapability";

import { selectModelForCapabilities } from "./orchestrator/capabilityModelSelector";
import { isTavilyAvailable } from "./tools/webSearch/providers/tavilyProvider";
import { isWebSearchMode, normalizeWebSearchMode } from "./tools/webSearch/webSearchMode";
import { isWebSurfV2Enabled, prepareWebSurfV2, type WebSurfV2Payload } from "./tools/webSearch/webSurfV2";
import { WebSurfCitationStream } from "./tools/webSearch/webSurfCitationStream";
import { WebSurfOutputGuardStream } from "./tools/webSearch/webSurfOutputGuard";
import { normalizeExecutionMode, resolveExecutionProfile } from "./orchestrator/executionProfile";
import {
  buildIntuitiveToolSelectionPrompt,
  INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID,
  isNemotronIntuitiveLaneEnabled,
  protectIntuitiveFinalSynthesis,
  releaseIntuitiveFinalSynthesisProtection,
} from "./orchestrator/intuitiveTextLane";

// Middleware
import { generalRateLimiter, aiRateLimiter, uploadRateLimiter } from "./middleware/rateLimiter";
import { auditMiddleware, getRecentAuditEntries } from "./middleware/audit";
import { commitImageQuotaSuccess, imageQuotaMiddleware, getImageQuotaKey, getQuotaInfo } from "./middleware/imageQuota";
import { AuthError, getRequestUser, resolveRequestUser, verifyJWT } from "./middleware/auth";
import { HttpError, buildHttpErrorResponse } from "./httpErrors";

// Validation
import {
  ChatRequestSchema,
  MemoryClassifyRequestSchema,
  MemoryCompressRequestSchema,
  ImageGenerateRequestSchema,
  ChartGenerateRequestSchema,
  GeneratedFileUpdateRequestSchema,
  ProfileUpdateRequestSchema,
  SelectionContextSchema,
  detectPromptInjection,
} from "./validation/schemas";
import { getOptionalUuid, getRequiredUuid } from "./validation/uuid";
import { ZodError } from "zod";
import { collapseAdjacentDuplicateMessages } from "./context/messageDeduper";
import { resolveContextReferences } from "./context/referenceResolver";
import { getTokenAllowanceAccounting, runWithRequestBudgetContext } from "./context/requestBudgetContext";
import { callMathModelRaw, streamMathModelRaw } from "./ai/mathVerifier";
import { registerBillingRoutes } from "./billing/billingRoutes";
import { buildBillingIdentity, getAnonymousIdHeaderName } from "./billing/anonymousIdentity";
import {
  BillingQuotaError,
  BillingQuotaService,
  ModelCapabilityUnavailableError,
  buildQuotaErrorPayload,
} from "./billing/quotaService";
import type { BillingIdentity, UsageReservation } from "./billing/entitlementTypes";
import { getImageModelForPlan } from "./billing/modelEntitlementRouter";
import {
  CANONICAL_FRONTEND_ORIGIN,
  LOG_PREFIX,
  PRODUCT_DISCLAIMER,
  PRODUCT_NAME,
  PUBLIC_BACKEND_SERVICE_NAME,
  PUBLIC_SYSTEM_NAME,
} from "./branding";
import {
  isInternalGatewayHealthy,
  validateInternalGatewayConfiguration,
} from "./internalGateway";

const app = express();
bootProfiler.mark("express.app.created");
const obsoleteModelToolEnvironmentNames = findObsoleteModelToolEnvironmentNames();
if (obsoleteModelToolEnvironmentNames.length > 0) {
  console.warn(
    `${LOG_PREFIX} WARNING: obsolete model-tool environment variables are ignored: ${obsoleteModelToolEnvironmentNames.join(", ")}`,
  );
}
console.info(JSON.stringify({
  scope: "model_tool_startup",
  event: "runtime_flags",
  ...getModelToolRuntimeSnapshot(),
}));
const billingQuotaService = new BillingQuotaService();
bootProfiler.mark("billingQuotaService.created");
const geminiLiveConfig = loadGeminiLiveConfig();
const liveTierPolicy = loadLiveTierPolicy();
bootProfiler.mark("live.config.loaded");
const liveSessionService = new LiveSessionService({
  config: geminiLiveConfig,
  tierPolicy: liveTierPolicy,
  planResolver: new LivePlanResolver((userId) => billingQuotaService.resolvePlanCode({
    userId,
    anonymousKeyHash: null,
    isGuest: false,
  })),
  usageStore: new SupabaseLiveUsageStore(),
  keyPool: new GeminiLiveKeyPool(),
  tokenService: new GeminiLiveTokenService(),
  persistence: new SentIQLivePersistence(),
  titleGenerator: {
    generateTitle: async ({ userId, conversationId, userMessage, assistantReply }) => {
      const userDb = await resolveUserDatabaseOrThrow(userId, "live.title");
      await initializeUserSessionOrThrow(userDb, userId, "live.title");
      const currentTitle = await readConversationTitleIfOwned(
        userDb,
        userId,
        conversationId,
        "live.title",
      );
      await maybeAutoTitleConversation({
        userDb,
        userId,
        conversationId,
        userMessage,
        assistantReply,
        scope: "live.title.auto",
        currentTitle,
      });
    },
  },
});
bootProfiler.mark("liveSessionService.created");
const PORT = parseInt(process.env.PORT || "3001", 10);
const JSON_BODY_LIMIT = process.env.SENTIQ_JSON_BODY_LIMIT?.trim() || "6mb";
const TITLE_MAX_CHARS = 120;
const TITLE_FALLBACK_MAX_CHARS = 50;
const TITLE_GENERATION_TIMEOUT_MS = parseInt(process.env.SENTIQ_TITLE_TIMEOUT_MS || "12000", 10);
const FAST_STREAM_SYNC_GRACE_MS = parseInt(process.env.SENTIQ_FAST_STREAM_SYNC_GRACE_MS || "250", 10);
const SHUTDOWN_GRACE_MS = (() => {
  const parsed = Number.parseInt(process.env.SENTIQ_SHUTDOWN_GRACE_MS || "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
})();

app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal");
bootProfiler.mark("server.config.loaded");

// Probe routes intentionally run before CORS, auth, audit, and rate limiting.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: PUBLIC_BACKEND_SERVICE_NAME });
});

app.get("/ready", async (_req, res) => {
  const gatewayHealthy = await isInternalGatewayHealthy();
  if (!gatewayHealthy) {
    res.setHeader("Retry-After", "2");
    res.status(503).json({ status: "warming" });
    return;
  }
  res.json({ status: "ready" });
});

function getExplicitWebSearchMode(value: unknown): "basic" | undefined {
  if (!isWebSearchMode(value)) return undefined;
  return normalizeWebSearchMode(value) === "basic" ? "basic" : undefined;
}

function getWebSurfV2Preview(payload: WebSurfV2Payload | undefined): Record<string, WebSurfV2Payload> | undefined {
  return payload ? { web_surf_v2: payload } : undefined;
}

function logWebSurfAnswerOutput(args: {
  readonly profile?: string;
  readonly answer: string;
  readonly outputGuardRemovedInternalArtefact: boolean;
}): void {
  if (!args.profile) return;
  const citationMarkerCount = (args.answer.match(/\[\[S\d+\]\]/g) ?? []).length;
  console.info(
    `[WebSurfV2] stage=answer_output profile=${args.profile} citation_marker_count=${citationMarkerCount} ` +
    `streamed_output_chars=${args.answer.length} output_guard_removed=${args.outputGuardRemovedInternalArtefact ? 1 : 0}`,
  );
}

// ---- CORS ----
const DEFAULT_ORIGINS = [
  CANONICAL_FRONTEND_ORIGIN,
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://localhost:5173",
];

const ALLOWED_ORIGINS: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;

bootProfiler.mark("cors.origins.resolved");
console.log(`${LOG_PREFIX} CORS allowed origins:`, ALLOWED_ORIGINS);

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
  allowedHeaders: ["Content-Type", "Authorization", getAnonymousIdHeaderName()],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({
  limit: JSON_BODY_LIMIT,
  verify: (req, _res, buf) => {
    if ((req as Request).originalUrl.startsWith("/api/billing/webhook/razorpay")) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    }
  },
}));

const PUBLIC_PRIVATE_RESPONSE_KEYS = new Set([
  "architecture",
  "keyStatus",
  "models",
  "model_used",
  "modelUsed",
  "provider",
  "provider_used",
  "fallback_reason",
  "fallbackReason",
  "error_detail",
  "errorDetail",
  "embedding",
  "embedding_model",
  "embeddingModel",
  "storage_bucket",
  "storageBucket",
  "storage_path",
  "storagePath",
  "tag",
]);

function sanitizePublicPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePublicPayload);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (PUBLIC_PRIVATE_RESPONSE_KEYS.has(key)) continue;
    if (key === "route" && typeof nestedValue === "string") {
      const publicRoutes = new Set([
        "chat",
        "normal_chat",
        "reasoning",
        "math_reasoning",
        "web_search",
        "file_generation",
        "chart_generation",
        "image_generation",
        "memory_update",
      ]);
      output[key] = publicRoutes.has(nestedValue) ? nestedValue : "chat";
      continue;
    }
    output[key] = sanitizePublicPayload(nestedValue);
  }
  return output;
}

app.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => sendJson(sanitizePublicPayload(body))) as typeof res.json;
  next();
});

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

let activeRequests = 0;
app.use((_req, res, next) => {
  activeRequests += 1;
  let counted = true;
  const releaseRequest = () => {
    if (!counted) return;
    counted = false;
    activeRequests = Math.max(0, activeRequests - 1);
  };
  res.on("finish", releaseRequest);
  res.on("close", releaseRequest);
  next();
});

async function attachRateLimitIdentity(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    await resolveRequestUser(req, { allowGuest: true });
  } catch (error) {
    if (!(error instanceof AuthError)) {
      console.warn(`[RateLimit] auth identity pre-resolution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    next();
  }
}

// ---- Middleware stack ----
app.use(attachRateLimitIdentity);
app.use(generalRateLimiter);
app.use(auditMiddleware);
registerBillingRoutes(app);
registerLiveRoutes(app, {
  service: liveSessionService,
  requireAuth: verifyJWT({ allowGuest: false }),
  statusAuth: verifyJWT({ allowGuest: true }),
  tokenRateLimiter: aiRateLimiter,
});
bootProfiler.mark("middleware.routes.registered");

const MODEL_BUDGET_PATHS = new Set([
  "/api/chat",
  "/api/chat/stream",
  "/api/chat/selection",
  "/api/chat/title",
  "/api/memory/classify",
  "/api/memory/compress",
  "/api/search",
]);
app.use(async (req, _res, next) => {
  const budgetPath = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  if (!MODEL_BUDGET_PATHS.has(budgetPath)) {
    next();
    return;
  }

  try {
    const requestUser = getRequestUser(req);
    const identity = buildBillingIdentity(req, requestUser);
    const planCode = await billingQuotaService.resolvePlanCode(identity);
    runWithRequestBudgetContext({
      planCode,
      executionMode: req.body?.executionMode ?? req.body?.execution_mode,
      resolution: identity.isGuest ? "guest" : "billing",
    }, next);
  } catch (error) {
    console.warn(JSON.stringify({
      scope: "context_budget",
      event: "request_context_resolution_failed",
      fallback_plan: "free",
      error_type: error instanceof Error ? error.name : "unknown",
    }));
    runWithRequestBudgetContext({
      planCode: "free",
      executionMode: normalizeExecutionMode(req.body?.executionMode ?? req.body?.execution_mode),
      resolution: "fallback",
    }, next);
  }
});

// ---- Multer for file uploads ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Helpers ----
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    return fn(req, res).catch(next);
  };
}

function buildBillingRequestId(
  scope: string,
  userId: string,
  clientRequestId?: string | null,
): string {
  const requestPart = clientRequestId?.trim() || randomUUID();
  return `${scope}:${userId}:${requestPart}`;
}

function quotaErrorToPublicResponse(error: BillingQuotaError) {
  return buildQuotaErrorPayload(error);
}

async function releaseBillingReservation(reservation: UsageReservation | null | undefined): Promise<void> {
  if (!reservation) return;
  await billingQuotaService.release(reservation).catch((releaseError) => {
    console.warn(`[Billing] failed to release reservation: ${releaseError instanceof Error ? releaseError.name : "unknown_error"}`);
  });
}

async function reserveTextBilling(args: {
  readonly identity: BillingIdentity;
  readonly requestId: string;
  readonly conversationId?: string | null;
  readonly clientRequestId?: string | null;
  readonly route: string;
  readonly requiredCapabilities?: readonly RequiredModelCapability[];
  readonly executionMode: "fast" | "intuitive";
  readonly complexity?: "normal" | "heavy";
}): Promise<UsageReservation> {
  return billingQuotaService.reserveTextRoute({
    identity: args.identity,
    requestId: args.requestId,
    conversationId: args.conversationId,
    clientRequestId: args.clientRequestId,
    requiredCapabilities: args.requiredCapabilities,
    executionMode: args.executionMode,
    complexity: args.complexity,
    metadata: {
      endpoint: "chat",
      route: args.route,
    },
  });
}

async function reserveAdvancedBilling(args: {
  readonly identity: BillingIdentity;
  readonly requestId: string;
  readonly conversationId?: string | null;
  readonly clientRequestId?: string | null;
  readonly route: string;
  readonly requiredCapabilities?: readonly RequiredModelCapability[];
}): Promise<UsageReservation> {
  return billingQuotaService.reserveAdvancedReasoning({
    identity: args.identity,
    requestId: args.requestId,
    conversationId: args.conversationId,
    clientRequestId: args.clientRequestId,
    requiredCapabilities: args.requiredCapabilities,
    metadata: {
      endpoint: "chat",
      route: args.route,
    },
  });
}

async function commitTextBilling(reservation: UsageReservation, route: string): Promise<void> {
  await billingQuotaService.commit(reservation, {
    endpoint: "chat",
    route,
  });
}

async function getImageQuotaDisplay(
  identity: BillingIdentity,
  localInfo: ReturnType<typeof getQuotaInfo>,
): Promise<{
  remaining: number;
  limit: number;
  resetMs: number;
  reset_at: string | null;
  plan_code: string;
  cooldownActive: boolean;
  cooldownResetMs: number;
}> {
  try {
    const summary = await billingQuotaService.getUsageSummary(identity);
    const quota = summary?.quotas?.image_generation;
    return {
      remaining: typeof quota?.remaining === "number" ? quota.remaining : localInfo.remaining,
      limit: typeof quota?.limit === "number" ? quota.limit : localInfo.limit,
      resetMs: 0,
      reset_at: typeof quota?.reset_at === "string" ? quota.reset_at : null,
      plan_code: typeof summary?.plan_code === "string" ? summary.plan_code : "free",
      cooldownActive: localInfo.cooldownActive,
      cooldownResetMs: localInfo.cooldownActive ? 5_000 : 0,
    };
  } catch (error) {
    console.warn(`[Billing] image quota display fallback: ${error instanceof Error ? error.message : error}`);
    return {
      ...localInfo,
      reset_at: null,
      plan_code: "free",
      cooldownResetMs: localInfo.cooldownActive ? 5_000 : 0,
    };
  }
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

const GENERIC_UNAVAILABLE_REPLY_PATTERN =
  /\bcurrently unable to process your request\b|\bplease try again shortly\b/i;
const STREAM_RECOVERY_USER_ERROR = "The response did not complete. Please retry.";

function getUnavailableReplyReason(text: string | null | undefined): string | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "empty_response";
  if (GENERIC_UNAVAILABLE_REPLY_PATTERN.test(trimmed)) return "generic_unavailable_reply";
  return null;
}

function assertUsableAssistantText(text: string | null | undefined, context: {
  readonly route: string;
  readonly model?: string;
  readonly reason: string;
}): string {
  const normalized = String(text || "").trim();
  const unavailableReason = getUnavailableReplyReason(normalized);
  if (unavailableReason) {
    console.warn(
      `[StreamRecovery] route=${context.route} model=${context.model ?? "unknown"}` +
      ` reason=${context.reason} rejected=${unavailableReason}`,
    );
    throw new Error(STREAM_RECOVERY_USER_ERROR);
  }
  return normalized;
}

async function recoverBufferedStreamText(args: {
  readonly route: string;
  readonly model?: string;
  readonly reason: string;
  readonly call: LLMAdapterCall;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const model = args.model ?? args.call.model_override ?? "unknown";
  console.warn(`[StreamRecovery] route=${args.route} model=${model} reason=${args.reason} attempt=buffered_adapter`);
  const result = await callLLMAdapterDetailed({
    ...args.call,
    ...(args.timeoutMs ? { timeout_ms: args.timeoutMs } : {}),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const text = assertUsableAssistantText(result.text, {
    route: args.route,
    model,
    reason: args.reason,
  });
  console.log(
    `[StreamRecovery] route=${args.route} model=${model}` +
    ` recovered_model=${result.model_used ?? "unknown"} chars=${text.length}`,
  );
  return text;
}

async function recoverBufferedReplyText(args: {
  readonly route: string;
  readonly model?: string;
  readonly reason: string;
  readonly invoke: () => Promise<string>;
}): Promise<string> {
  const model = args.model ?? "unknown";
  console.warn(`[StreamRecovery] route=${args.route} model=${model} reason=${args.reason} attempt=buffered_reply`);
  const text = assertUsableAssistantText(await args.invoke(), {
    route: args.route,
    model,
    reason: args.reason,
  });
  console.log(`[StreamRecovery] route=${args.route} model=${model} recovered_reply_chars=${text.length}`);
  return text;
}

const GUEST_MODEL_OVERRIDE = "gemini-search";
const GUEST_TEXT_MODEL_OVERRIDE = "gpt-oss-120b";
const GUEST_MATH_MAX_OUTPUT_TOKENS = 6000;
const GUEST_MATH_EMPTY_FALLBACK = "Sorry, I couldn't complete the math response. Please try again.";

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
  console.log(`${LOG_PREFIX}[profile] ${event}${suffix ? ` ${suffix}` : ""}`);
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
  console.log(`${LOG_PREFIX}[db] ${scope} userId=${userId}${suffix}`);
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
  console.error(`${LOG_PREFIX}[db] ${scope}.failed userId=${userId}${suffix} error=${normalizedError}`);
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

type SyncStatus = {
  persisted: boolean;
  deferred: boolean;
  conversationId?: string;
  reason?: string;
  warnings: string[];
};

type DegradedStatus = {
  status: "ok" | "degraded";
  degraded: boolean;
  reasons: string[];
  persistence: {
    persisted: boolean;
    deferred: boolean;
    conversationId?: string;
    reason?: string;
    warnings: string[];
  };
};

function createSyncStatus(conversationId?: string): SyncStatus {
  return {
    persisted: true,
    deferred: false,
    conversationId,
    warnings: [],
  };
}

function finalizeSyncStatus(sync: SyncStatus): SyncStatus {
  if (sync.deferred) {
    const reason = sync.reason || "persistence_deferred";
    sync.reason = reason;
    if (!sync.warnings.includes(reason)) {
      sync.warnings.push(reason);
    }
  }
  return sync;
}

function buildDegradedStatus(sync: SyncStatus): DegradedStatus {
  const finalized = finalizeSyncStatus(sync);
  const reasons = Array.from(new Set([
    ...(finalized.warnings || []),
    ...(finalized.deferred ? [finalized.reason || "persistence_deferred"] : []),
  ].filter(Boolean)));
  return {
    status: finalized.deferred || !finalized.persisted ? "degraded" : "ok",
    degraded: finalized.deferred || !finalized.persisted,
    reasons,
    persistence: {
      persisted: finalized.persisted,
      deferred: finalized.deferred,
      conversationId: finalized.conversationId,
      reason: finalized.reason,
      warnings: finalized.warnings || [],
    },
  };
}

async function waitForFastStreamSync<T>(
  promise: Promise<T>,
  timeoutMs = FAST_STREAM_SYNC_GRACE_MS,
): Promise<T | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeTitleCandidate(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX_CHARS);
}

function fallbackTitleFromMessage(message: string): string {
  return normalizeTitleCandidate(message.slice(0, TITLE_FALLBACK_MAX_CHARS));
}

function normalizeComparableText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericConversationTitle(title: unknown): boolean {
  const normalized = normalizeComparableText(title);
  return !normalized
    || normalized === "new chat"
    || normalized === "live conversation"
    || normalized === "untitled chat"
    || normalized === "untitled conversation";
}

function titleLooksLikeFirstMessageFallback(title: unknown, firstUserMessage: unknown): boolean {
  const normalizedTitle = normalizeComparableText(title);
  const normalizedFirstUserMessage = normalizeComparableText(firstUserMessage);
  if (!normalizedTitle || !normalizedFirstUserMessage || isGenericConversationTitle(title)) return false;
  if (normalizedTitle.length < 8) return false;
  return normalizedFirstUserMessage.startsWith(normalizedTitle)
    || normalizedTitle.startsWith(normalizedFirstUserMessage.slice(0, Math.min(normalizedFirstUserMessage.length, normalizedTitle.length)));
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
  allowFallbackReplacement?: boolean;
  replacementBasisMessage?: string;
  titleSource?: "llm" | "fallback";
}): Promise<boolean> {
  const normalizedTitle = normalizeTitleCandidate(options.title);
  if (!normalizedTitle) return false;

  const currentTitle = typeof options.currentTitle === "string"
    ? options.currentTitle
    : await readConversationTitleIfOwned(options.userDb, options.userId, options.conversationId, options.scope);
  const normalizedCurrent = normalizeTitleCandidate(currentTitle || "");
  const canReplaceFallbackTitle = Boolean(
    options.allowFallbackReplacement
    && options.titleSource === "llm"
    && options.replacementBasisMessage
    && titleLooksLikeFirstMessageFallback(currentTitle || "", options.replacementBasisMessage),
  );
  if (normalizedCurrent && !isGenericConversationTitle(normalizedCurrent) && !canReplaceFallbackTitle) {
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
  const currentLooksFallback = titleLooksLikeFirstMessageFallback(options.currentTitle || "", options.userMessage);
  if (normalizedCurrent && !isGenericConversationTitle(normalizedCurrent) && !currentLooksFallback) return;

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
    allowFallbackReplacement: currentLooksFallback,
    replacementBasisMessage: options.userMessage,
    titleSource: generation.source,
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
        `${LOG_PREFIX}[alert] shard-capacity.exhausted userId=${userId} scope=${scope}` +
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

async function getConversationAliasIfPresent(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<ConversationAliasRow | null> {
  const { data, error } = await getConversationAlias(userDb, userId, conversationId);
  if (error) {
    logDbFailure(`${scope}.conversation-alias`, userId, error, { conversationId });
    return null;
  }
  return data || null;
}

async function resolveConversationIdThroughAlias(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<{ conversationId: string; requestedConversationId: string; aliased: boolean }> {
  const alias = await getConversationAliasIfPresent(userDb, userId, conversationId, scope);
  if (!alias?.canonical_conversation_id) {
    return { conversationId, requestedConversationId: conversationId, aliased: false };
  }
  logDbEvent(`${scope}.conversation-alias.ok`, userId, {
    requestedConversationId: conversationId,
    canonicalConversationId: alias.canonical_conversation_id,
  });
  return {
    conversationId: alias.canonical_conversation_id,
    requestedConversationId: conversationId,
    aliased: true,
  };
}

async function getOwnedConversationResolvingAliasOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<{ conversation: ConversationRow; requestedConversationId: string; aliased: boolean }> {
  try {
    const conversation = await getOwnedConversationOrThrow(userDb, userId, conversationId, scope);
    return { conversation, requestedConversationId: conversationId, aliased: false };
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) {
      throw error;
    }
    const resolved = await resolveConversationIdThroughAlias(userDb, userId, conversationId, scope);
    if (!resolved.aliased) throw error;
    const conversation = await getOwnedConversationOrThrow(userDb, userId, resolved.conversationId, scope);
    return {
      conversation,
      requestedConversationId: conversationId,
      aliased: true,
    };
  }
}

async function createConversationOrThrow(
  userDb: any,
  userId: string,
  scope: string,
  title = "New Chat",
  conversationId?: string,
): Promise<ConversationListRow> {
  logDbEvent(`${scope}.conversation-create.start`, userId, { title, conversationId });
  const startedAt = Date.now();
  const { data, error } = await createConversation(userDb, { userId, title, id: conversationId });

  if (error) {
    logDbFailure(`${scope}.conversation-create`, userId, error, { title, conversationId });
    throw new Error(error.message);
  }
  if (!data?.id) {
    logDbFailure(`${scope}.conversation-create`, userId, new Error("Failed to create conversation"));
    throw new Error("Failed to create conversation");
  }

  logDbEvent(`${scope}.conversation-create.ok`, userId, {
    conversationId: data.id,
    requestedConversationId: conversationId || null,
    duration_ms: Date.now() - startedAt,
  });
  return data as ConversationListRow;
}

async function resolveOrCreateConversationForRequest(
  userDb: any,
  userId: string,
  scope: string,
  requestedConversationId?: string | null,
  title = "New Chat",
  options: { clientRequestId?: string | null } = {},
): Promise<{ conversation: ConversationListRow; created: boolean }> {
  const clientRequestId = typeof options.clientRequestId === "string" && options.clientRequestId.trim()
    ? options.clientRequestId.trim().slice(0, 120)
    : "";

  if (clientRequestId) {
    logDbEvent(`${scope}.conversation-turn.resolve.start`, userId, {
      requestedConversationId: requestedConversationId || null,
      clientRequestId,
    });
    const { data, error } = await resolveConversationForTurn(userDb, {
      userId,
      clientRequestId,
      conversationId: requestedConversationId || null,
      title,
    });
    if (error) {
      logDbFailure(`${scope}.conversation-turn.resolve`, userId, error, {
        requestedConversationId: requestedConversationId || null,
      });
      throw new Error(error.message);
    }
    if (!data?.conversation_id) {
      throw new Error("Failed to resolve canonical conversation for chat turn");
    }
    logDbEvent(`${scope}.conversation-turn.resolve.ok`, userId, {
      requestedConversationId: requestedConversationId || null,
      conversationId: data.conversation_id,
      created: data.created ? "true" : "false",
    });
    return {
      conversation: {
        id: data.conversation_id,
        title: data.title || title,
        created_at: data.created_at || new Date().toISOString(),
        last_activity_at: data.last_activity_at || null,
      },
      created: Boolean(data.created),
    };
  }

  if (requestedConversationId) {
    const resolved = await resolveConversationIdThroughAlias(userDb, userId, requestedConversationId, scope);
    requestedConversationId = resolved.conversationId;
    try {
      const existing = await getOwnedConversationOrThrow(userDb, userId, requestedConversationId, scope);
      return {
        conversation: {
          id: existing.id,
          title: existing.title || title,
          created_at: existing.created_at || new Date().toISOString(),
          last_activity_at: existing.last_activity_at || null,
        },
        created: false,
      };
    } catch (error) {
      if (!(error instanceof HttpError) || error.statusCode !== 404) {
        throw error;
      }
      logDbEvent(`${scope}.conversation-owner.create-missing`, userId, { conversationId: requestedConversationId });
    }
  }

  const conversation = await createConversationOrThrow(
    userDb,
    userId,
    scope,
    title,
    requestedConversationId || undefined,
  );
  return { conversation, created: true };
}

async function insertConversationMessageOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  scope: string,
  options: {
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
    previewJson?: unknown;
  } = {},
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
    messageType: options.messageType,
    imageUrl: options.imageUrl,
    storagePath: options.storagePath,
    prompt: options.prompt,
    provider: options.provider,
    fileSizeBytes: options.fileSizeBytes,
    fileUrl: options.fileUrl,
    fileName: options.fileName,
    fileFormat: options.fileFormat,
    mimeType: options.mimeType,
    generatedFileId: options.generatedFileId,
    previewJson: options.previewJson,
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
  if (role === "assistant" && (options.messageType ?? "text") === "text") {
    contextCapsuleService.scheduleRefresh({
      userDb,
      ownerUserId: userId,
      conversationId,
    });
  }
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

async function insertAutomaticMemoryOrThrow(
  userDb: any,
  userId: string,
  memory: {
    type?: string;
    summary?: string;
    importance?: number;
    embedding?: readonly number[] | null;
    scope?: MemoryScope;
    chat_id?: string | null;
    automatic_idempotency_key: string;
  },
  scope: string,
): Promise<AutomaticMemoryInsertResult> {
  logDbEvent(`${scope}.automatic-memory-insert.start`, userId, { type: memory.type || null });
  const { data, error } = await insertAutomaticMemoryOnce(userDb, {
    userId,
    type: memory.type,
    summary: memory.summary,
    importance: memory.importance,
    embedding: memory.embedding,
    embedding_model: Array.isArray(memory.embedding) && memory.embedding.length > 0 ? MEMORY_EMBEDDING_MODEL : null,
    embedding_created_at: Array.isArray(memory.embedding) && memory.embedding.length > 0 ? new Date().toISOString() : null,
    scope: memory.scope,
    chat_id: memory.chat_id ?? null,
    automaticIdempotencyKey: memory.automatic_idempotency_key,
  });
  if (error) {
    logDbFailure(`${scope}.automatic-memory-insert`, userId, error, { type: memory.type || null });
    throw new Error(error.message);
  }
  if (!data?.id) throw new Error("Failed to create automatic memory");
  logDbEvent(`${scope}.automatic-memory-insert.ok`, userId, {
    type: memory.type || null,
    deduplicated: String(data.deduplicated),
  });
  return data;
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
      const { error: repairError } = await repairUserMemoryUsage(userDb, userId);
      if (repairError) {
        logDbFailure(`${scope}.memory-delete.usage-repair-failed`, userId, repairError, {
          memoryId,
          memoryBytes,
        });
      } else {
        logDbEvent(`${scope}.memory-delete.usage-repair.ok`, userId, { memoryId });
      }
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

type ConversationMergeNotice = {
  from: string;
  to: string;
  reason: string;
  messages_moved?: number;
  messages_deleted?: number;
  images_moved?: number;
  generated_files_moved?: number;
  memories_moved?: number;
};

const DUPLICATE_MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DUPLICATE_MERGES_PER_LIST = 6;

function getConversationFirstPromptFingerprint(conversation: ConversationListRow): string {
  return normalizeComparableText(conversation.first_user_message || "");
}

function getConversationMessageCount(conversation: ConversationListRow): number {
  const count = Number(conversation.message_count);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function getConversationCreatedMs(conversation: ConversationListRow): number {
  const parsed = Date.parse(conversation.created_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasSummarizedConversationTitle(conversation: ConversationListRow): boolean {
  return Boolean(
    conversation.title
    && !isGenericConversationTitle(conversation.title)
    && !titleLooksLikeFirstMessageFallback(conversation.title, conversation.first_user_message || ""),
  );
}

function sortCanonicalCandidates(left: ConversationListRow, right: ConversationListRow): number {
  const leftSummarized = hasSummarizedConversationTitle(left) ? 1 : 0;
  const rightSummarized = hasSummarizedConversationTitle(right) ? 1 : 0;
  if (leftSummarized !== rightSummarized) return rightSummarized - leftSummarized;

  const leftCount = getConversationMessageCount(left);
  const rightCount = getConversationMessageCount(right);
  if (leftCount !== rightCount) return rightCount - leftCount;

  const leftCreated = getConversationCreatedMs(left);
  const rightCreated = getConversationCreatedMs(right);
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;

  return String(left.id).localeCompare(String(right.id));
}

async function cleanupDuplicateConversationsForUser(
  userDb: any,
  userId: string,
  conversations: ConversationListRow[],
  scope: string,
): Promise<ConversationMergeNotice[]> {
  const groups = new Map<string, ConversationListRow[]>();
  for (const conversation of conversations) {
    if (!conversation?.id) continue;
    const fingerprint = getConversationFirstPromptFingerprint(conversation);
    if (!fingerprint) continue;
    const key = `${userId}:${fingerprint}`;
    groups.set(key, [...(groups.get(key) || []), conversation]);
  }

  const merged: ConversationMergeNotice[] = [];
  for (const group of groups.values()) {
    if (merged.length >= MAX_DUPLICATE_MERGES_PER_LIST || group.length < 2) continue;

    const sortedByCreated = [...group].sort((left, right) => getConversationCreatedMs(left) - getConversationCreatedMs(right));
    const oldestMs = getConversationCreatedMs(sortedByCreated[0]);
    const newestMs = getConversationCreatedMs(sortedByCreated[sortedByCreated.length - 1]);
    if (!oldestMs || !newestMs || newestMs - oldestMs > DUPLICATE_MERGE_WINDOW_MS) continue;

    const hasFallbackTitle = group.some((conversation) =>
      titleLooksLikeFirstMessageFallback(conversation.title || "", conversation.first_user_message || ""),
    );
    const hasSummarizedTitle = group.some(hasSummarizedConversationTitle);
    if (!hasFallbackTitle || !hasSummarizedTitle) continue;

    const canonical = [...group].sort(sortCanonicalCandidates)[0];
    if (!canonical?.id || !hasSummarizedConversationTitle(canonical)) continue;

    const duplicates = group
      .filter((conversation) =>
        conversation.id !== canonical.id
        && titleLooksLikeFirstMessageFallback(conversation.title || "", conversation.first_user_message || "")
      )
      .sort((left, right) => getConversationCreatedMs(left) - getConversationCreatedMs(right));

    for (const duplicate of duplicates) {
      if (merged.length >= MAX_DUPLICATE_MERGES_PER_LIST) break;
      const reason = "same_first_prompt_fallback_title_24h";
      const { data, error } = await mergeDuplicateConversation(userDb, {
        userId,
        canonicalConversationId: canonical.id,
        duplicateConversationId: duplicate.id,
        reason,
      });
      if (error) {
        logDbFailure(`${scope}.duplicate-merge`, userId, error, {
          canonicalConversationId: canonical.id,
          duplicateConversationId: duplicate.id,
        });
        continue;
      }
      const stats = (data || {}) as Partial<DuplicateConversationMergeRow>;
      merged.push({
        from: duplicate.id,
        to: canonical.id,
        reason,
        messages_moved: stats.messages_moved || 0,
        messages_deleted: stats.messages_deleted || 0,
        images_moved: stats.images_moved || 0,
        generated_files_moved: stats.generated_files_moved || 0,
        memories_moved: stats.memories_moved || 0,
      });
      logDbEvent(`${scope}.duplicate-merge.ok`, userId, {
        canonicalConversationId: canonical.id,
        duplicateConversationId: duplicate.id,
        messages_moved: stats.messages_moved || 0,
        messages_deleted: stats.messages_deleted || 0,
      });
    }
  }

  return merged;
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

  const { data: generatedFiles, error: generatedFilesError } = await userDb
    .from("generated_files")
    .select("id,storage_bucket,storage_path")
    .eq("user_id", userId)
    .eq("chat_id", conversationId);
  if (generatedFilesError) {
    logDbFailure(`${scope}.generated-files-list`, userId, generatedFilesError, { conversationId });
    throw new HttpError(503, "Stored artifacts could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
  }
  for (const file of generatedFiles || []) {
    try {
      await deleteGeneratedFileObject(
        getGeneratedFileStorageDatabase(),
        file.storage_bucket || getStorageBucketName(),
        file.storage_path || "",
      );
    } catch (error) {
      console.error(`[ConversationDelete] generated-file cleanup failed conversationId=${conversationId} fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(503, "Stored artifacts could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
  }

  const { data: images, error: imagesError } = await userDb
    .from("chat_images")
    .select("id")
    .eq("user_id", userId)
    .eq("chat_id", conversationId);
  if (imagesError) {
    logDbFailure(`${scope}.images-list`, userId, imagesError, { conversationId });
    throw new HttpError(503, "Stored artifacts could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
  }
  for (const image of images || []) {
    const deleted = await deleteChatImage(userDb, userId, image.id, { storageDb: getImageStorageDatabase() });
    if (!deleted) {
      throw new HttpError(503, "Stored artifacts could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
  }

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
  error?: string;
  updated_at: number;
};

const fileAnalysisSubscribersByUser: Map<string, Map<string, SseWriter>> = new Map();

function registerFileAnalysisSubscriber(userId: string, subscriberId: string, writer: SseWriter): void {
  const subscribers = fileAnalysisSubscribersByUser.get(userId) ?? new Map<string, SseWriter>();
  subscribers.set(subscriberId, writer);
  fileAnalysisSubscribersByUser.set(userId, subscribers);
}

function unregisterFileAnalysisSubscriber(userId: string, subscriberId: string): void {
  const subscribers = fileAnalysisSubscribersByUser.get(userId);
  if (!subscribers) return;
  subscribers.delete(subscriberId);
  if (subscribers.size === 0) {
    fileAnalysisSubscribersByUser.delete(userId);
  }
}

function emitFileAnalysisEvent(userId: string | undefined, event: FileAnalysisEvent): void {
  if (!userId) return;
  const subscribers = fileAnalysisSubscribersByUser.get(userId);
  if (!subscribers) return;
  const payload = JSON.stringify(event);
  for (const [subscriberId, writer] of subscribers) {
    writer.write(payload).catch((err) => {
      console.warn(`[FileAnalysis] subscriber ${subscriberId} dropped for user ${userId}: ${err instanceof Error ? err.message : err}`);
      writer.close();
      unregisterFileAnalysisSubscriber(userId, subscriberId);
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
// GET /api/health
// ===============================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    system: PUBLIC_SYSTEM_NAME,
    version: "2.0.0",
    timestamp: new Date().toISOString(),
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
    let conversations = await listConversationsOrThrow(userDb, userId, "conversations.list");
    const merged = await cleanupDuplicateConversationsForUser(userDb, userId, conversations, "conversations.list");
    if (merged.length > 0) {
      conversations = await listConversationsOrThrow(userDb, userId, "conversations.list.after-merge");
    }
    logDbEvent("conversations.list.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      count: conversations.length,
      merged_count: merged.length,
    });
    res.json({ conversations, merged });
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
    const requestedConversationId = getOptionalUuid(req.body?.conversationId || req.body?.conversation_id, "conversationId");
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.create");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.create");
    await ensureNamedWorkspaceProfile(userId, "conversations.create", userDb);
    const { conversation } = await resolveOrCreateConversationForRequest(
      userDb,
      userId,
      "conversations.create",
      requestedConversationId || null,
      requestedTitle,
    );
    logDbEvent("conversations.create.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId: conversation.id,
    });
    res.json({ conversation });
  }),
);

// ===============================
// POST /api/chat/sync
// ===============================
app.post(
  "/api/chat/sync",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const userDb = await resolveUserDatabaseOrThrow(userId, "chat.sync");
    await initializeUserSessionOrThrow(userDb, userId, "chat.sync");
    await ensureNamedWorkspaceProfile(userId, "chat.sync", userDb);

    const requestedConversationId = getOptionalUuid(req.body?.conversationId, "conversationId", {
      ignoreInvalid: true,
    });
    const requestedTitle =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, TITLE_MAX_CHARS)
        : "New Chat";
    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const turnClientRequestId =
      (typeof req.body?.clientRequestId === "string" && req.body.clientRequestId.trim()
        ? req.body.clientRequestId.trim()
        : typeof req.body?.client_request_id === "string" && req.body.client_request_id.trim()
          ? req.body.client_request_id.trim()
          : rawMessages.find((message: any) => (
            typeof message?.clientRequestId === "string" && message.clientRequestId.trim()
          ))?.clientRequestId || rawMessages.find((message: any) => (
            typeof message?.client_request_id === "string" && message.client_request_id.trim()
          ))?.client_request_id || ""
      ).slice(0, 120);
    const resolvedConversation = await resolveOrCreateConversationForRequest(
      userDb,
      userId,
      "chat.sync",
      requestedConversationId || null,
      requestedTitle,
      { clientRequestId: turnClientRequestId },
    );
    const conversationId = resolvedConversation.conversation.id;
    const createdConversation = resolvedConversation.created;

    type SyncMessage = {
      role: "user" | "assistant";
      content: string;
      clientRequestId?: string;
      meta?: any;
    };
    const toNumberOrUndefined = (value: unknown): number | undefined => {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
    };
    const buildSyncMessageOptions = (message: SyncMessage) => {
      const meta = message.meta && typeof message.meta === "object" ? message.meta : null;
      const base = { clientRequestId: message.clientRequestId } as {
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
        previewJson?: unknown;
      };
      if (meta?.type === "image") {
        return {
          ...base,
          messageType: "image",
          imageUrl: typeof meta.imageUrl === "string" ? meta.imageUrl : typeof meta.image_url === "string" ? meta.image_url : undefined,
          storagePath: typeof meta.storagePath === "string" ? meta.storagePath : typeof meta.storage_path === "string" ? meta.storage_path : undefined,
          prompt: typeof meta.prompt === "string" ? meta.prompt : undefined,
          provider: typeof meta.provider === "string" ? meta.provider : undefined,
          fileSizeBytes: toNumberOrUndefined(meta.fileSizeBytes ?? meta.file_size_bytes),
        };
      }
      if (meta?.type === "generated-file") {
        return {
          ...base,
          messageType: "file",
          fileUrl: typeof meta.file_url === "string" ? meta.file_url : typeof meta.fileUrl === "string" ? meta.fileUrl : undefined,
          fileName: typeof meta.file_name === "string" ? meta.file_name : typeof meta.fileName === "string" ? meta.fileName : undefined,
          fileFormat: typeof meta.format === "string" ? meta.format : typeof meta.file_format === "string" ? meta.file_format : undefined,
          mimeType: typeof meta.mime_type === "string" ? meta.mime_type : typeof meta.mimeType === "string" ? meta.mimeType : undefined,
          generatedFileId: typeof meta.file_id === "string" ? meta.file_id : typeof meta.generated_file_id === "string" ? meta.generated_file_id : undefined,
          storagePath: typeof meta.storage_path === "string" ? meta.storage_path : typeof meta.storagePath === "string" ? meta.storagePath : undefined,
          fileSizeBytes: toNumberOrUndefined(meta.file_size_bytes ?? meta.fileSizeBytes),
          previewJson: meta.preview || undefined,
        };
      }
      if (meta?.type === "message-attachments") {
        const attachments = Array.isArray(meta.attachments)
          ? meta.attachments
            .map((attachment: any) => ({
              kind: attachment?.kind === "image" ? "image" : "file",
              filename: typeof attachment?.filename === "string" ? attachment.filename.slice(0, 255) : "",
              mime_type: typeof attachment?.mime_type === "string" ? attachment.mime_type.slice(0, 160) : "",
              size_bytes: toNumberOrUndefined(attachment?.size_bytes),
              analysis_id: typeof attachment?.analysis_id === "string" ? attachment.analysis_id.slice(0, 160) : undefined,
            }))
            .filter((attachment: any) => attachment.filename)
          : [];
        const first = attachments[0];
        return {
          ...base,
          messageType: "file_upload",
          fileName: first?.filename,
          mimeType: first?.mime_type,
          fileSizeBytes: first?.size_bytes,
          previewJson: { attachments },
        };
      }
      if (meta?.type === "file-upload") {
        return {
          ...base,
          messageType: "file_upload",
          fileName: typeof meta.filename === "string" ? meta.filename : typeof meta.file_name === "string" ? meta.file_name : undefined,
          mimeType: typeof meta.mime_type === "string" ? meta.mime_type : typeof meta.mimeType === "string" ? meta.mimeType : undefined,
          fileSizeBytes: toNumberOrUndefined(meta.size_bytes ?? meta.file_size_bytes ?? meta.fileSizeBytes),
          previewJson: {
            filename: typeof meta.filename === "string" ? meta.filename : typeof meta.file_name === "string" ? meta.file_name : undefined,
            analysis_id: typeof meta.analysis_id === "string" ? meta.analysis_id : undefined,
            analysis_status: typeof meta.analysis_status === "string" ? meta.analysis_status : undefined,
            size_bytes: toNumberOrUndefined(meta.size_bytes ?? meta.file_size_bytes ?? meta.fileSizeBytes),
            mime_type: typeof meta.mime_type === "string" ? meta.mime_type : typeof meta.mimeType === "string" ? meta.mimeType : undefined,
          },
        };
      }
      if (meta?.type === "response-state") {
        return {
          ...base,
          messageType: "text",
          previewJson: {
            response_status: typeof meta.response_status === "string" ? meta.response_status : undefined,
            continuation_of: typeof meta.continuation_of === "string" ? meta.continuation_of : undefined,
            auto_resume_attempted: Boolean(meta.auto_resume_attempted),
          },
        };
      }
      if (meta?.type === "websurf_v2" && meta.payload && typeof meta.payload === "object") {
        return {
          ...base,
          messageType: "text",
          previewJson: { web_surf_v2: meta.payload },
        };
      }
      return base;
    };
    const messages = rawMessages
      .map((message: any) => ({
        role: message?.role === "assistant" ? "assistant" as const : "user" as const,
        content: typeof message?.content === "string" ? message.content : "",
        clientRequestId: typeof message?.clientRequestId === "string" && message.clientRequestId.trim()
          ? message.clientRequestId.trim().slice(0, 120)
          : undefined,
        meta: message?.meta && typeof message.meta === "object" ? message.meta : undefined,
      }))
      .filter((message: SyncMessage) => {
        if (message.content.trim().length > 0) return true;
        return message.meta?.type === "image" || message.meta?.type === "generated-file" || message.meta?.type === "file-upload" || message.meta?.type === "message-attachments" || message.meta?.type === "websurf_v2";
      })
      .slice(0, 20) as SyncMessage[];

    for (const message of messages) {
      await insertConversationMessageOrThrow(
        userDb,
        userId,
        conversationId,
        message.role,
        message.content,
        "chat.sync",
        buildSyncMessageOptions(message),
      );
      if (
        message.role === "assistant"
        && (message.meta?.type === "response-state" || message.meta?.type === "websurf_v2")
        && message.clientRequestId
      ) {
        const options = buildSyncMessageOptions(message);
        const { error: responseStateError } = await userDb
          .from("messages")
          .update({ preview_json: options.previewJson })
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .eq("client_request_id", message.clientRequestId)
          .eq("message_type", "text");
        if (responseStateError) {
          logDbFailure("chat.sync.assistant-preview", userId, responseStateError, { conversationId });
        }
      }
    }

    const firstUserMessage = messages.find((message) => message.role === "user")?.content || "";
    const assistantReply = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
    if (createdConversation && firstUserMessage && assistantReply) {
      scheduleAutoTitleConversation({
        userDb,
        userId,
        conversationId,
        userMessage: firstUserMessage,
        assistantReply,
        scope: "chat.sync.title.auto",
        currentTitle: requestedTitle,
      });
    }

    logDbEvent("chat.sync.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId,
      count: messages.length,
    });
    res.json({
      sync: {
        persisted: true,
        deferred: false,
        conversationId,
      },
      degraded: buildDegradedStatus(createSyncStatus(conversationId)),
    });
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
    const conversationId = getRequiredUuid(req.params.id, "Conversation id");
    const title =
      typeof req.body?.title === "string" && req.body.title.trim()
        ? req.body.title.trim().slice(0, 120)
        : "";

    if (!title) {
      res.status(400).json({ error: "Title is required." });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.title");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.title");
    await ensureNamedWorkspaceProfile(userId, "conversations.title", userDb);
    const resolved = await resolveConversationIdThroughAlias(userDb, userId, conversationId, "conversations.title");
    await updateConversationTitleIfOwned(userDb, userId, resolved.conversationId, title, "conversations.title");
    logDbEvent("conversations.title.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId: resolved.conversationId,
    });
    res.json({
      success: true,
      conversationId: resolved.conversationId,
      canonicalConversationId: resolved.conversationId,
      requestedConversationId: conversationId,
      aliased: resolved.aliased,
      title,
    });
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
    const conversationId = getRequiredUuid(req.params.id, "Conversation id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.messages");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.messages");
    await ensureNamedWorkspaceProfile(userId, "conversations.messages", userDb);
    
    // Fetch conversation details (including title) along with messages
    let resolved;
    try {
      resolved = await getOwnedConversationResolvingAliasOrThrow(
        userDb,
        userId,
        conversationId,
        "conversations.messages",
      );
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.status === 404) {
        res.json({
          conversation: {
            id: conversationId,
            title: "New Chat",
            created_at: new Date().toISOString(),
            last_activity_at: null,
          },
          canonicalConversationId: conversationId,
          requestedConversationId: conversationId,
          aliased: false,
          message_count: 0,
          messages: [],
        });
        return;
      }
      throw err;
    }
    const conversation = resolved.conversation;
    
    const messages = await listConversationMessagesOrThrow(
      userDb,
      userId,
      conversation.id,
      "conversations.messages",
      { skipOwnershipCheck: true },
    );
    logDbEvent("conversations.messages.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId: conversation.id,
      count: messages.length,
    });
    
    // Return both conversation metadata (with title) and messages
    res.json({
      conversation: {
        id: conversation.id,
        title: conversation.title || "New Chat",
        created_at: conversation.created_at,
        last_activity_at: conversation.last_activity_at || null,
      },
      canonicalConversationId: conversation.id,
      requestedConversationId: resolved.requestedConversationId,
      aliased: resolved.aliased,
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
    const conversationId = getRequiredUuid(req.params.id, "Conversation id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.delete");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.delete");
    await ensureNamedWorkspaceProfile(userId, "conversations.delete", userDb);
    const alias = await getConversationAliasIfPresent(userDb, userId, conversationId, "conversations.delete");
    if (alias?.canonical_conversation_id) {
      res.json({
        success: true,
        conversationId: alias.canonical_conversation_id,
        canonicalConversationId: alias.canonical_conversation_id,
        requestedConversationId: conversationId,
        aliased: true,
      });
      return;
    }
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
    const memoryId = getRequiredUuid(req.params.id, "Memory id");
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
    const requestAbortController = new AbortController();
    const abortRequest = () => {
      if (!res.writableEnded) requestAbortController.abort(new Error("Client disconnected"));
    };
    const cleanupAbortListeners = () => {
      req.removeListener("aborted", abortRequest);
      res.removeListener("close", abortRequest);
    };
    req.once("aborted", abortRequest);
    res.once("close", abortRequest);
    res.once("finish", cleanupAbortListeners);
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const executionProfile = resolveExecutionProfile(parsed.data.executionMode);
    const normalizedRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );
    const requestUser = getRequestUser(req);
    const { sub: userId, isGuest } = requestUser;
    const billingIdentity = buildBillingIdentity(req, requestUser);
    const billingRequestId = buildBillingRequestId("chat", userId, parsed.data.clientRequestId);
    const effectiveUserMessage = parsed.data.message;
    const requestedConversationId = getOptionalUuid(parsed.data.conversationId, "conversationId", {
      ignoreInvalid: isGuest,
    });
    const webSearchMode = getExplicitWebSearchMode(parsed.data.context?.web_search_mode);
    const hasExplicitWebSearchMode = Boolean(webSearchMode);
    const effectiveWebSearchMode = webSearchMode;
    const hasEffectiveWebSearchMode = Boolean(effectiveWebSearchMode);
    const webSurfV2Enabled = isWebSurfV2Enabled();
    const isReasoningQuery = false;
    const isMathReasoningQuery = false;
    const isLogicReasoningQuery = isReasoningQuery && !isMathReasoningQuery;
    const guestUserMessage = effectiveUserMessage;

    // Prompt injection detection
    if (detectPromptInjection(parsed.data.message) || detectPromptInjection(effectiveUserMessage)) {
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

    if (isGuest && hasEffectiveWebSearchMode && !webSurfV2Enabled) {
      const result = await orchestrate({
        userMessage: parsed.data.message,
        executionMode: parsed.data.executionMode,
        signal: requestAbortController.signal,
        context: {
          recent_messages: normalizedRecentMessages,
          memories: [],
          file_references: orcFileRefs,
          image_attachments: orcImageAttachments,
          web_search_mode: effectiveWebSearchMode,
          userId,
          billingIdentity,
          billingRequestId,
          clientRequestId: parsed.data.clientRequestId,
          imageQuotaKey: getImageQuotaKey(req),
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
        file: result.file,
        memory: result.memory,
        web_search: result.web_search,
        confidence: result.confidence,
        model_used: result.model_used,
        searched: result.searched === true,
      });
      return;
    }

    if (
      isGuest &&
      getEnabledAutomaticSentIQTools().length > 0 &&
      !hasExplicitWebSearchMode
    ) {
      const result = await orchestrate({
        userMessage: parsed.data.message,
        executionMode: parsed.data.executionMode,
        signal: requestAbortController.signal,
        context: {
          recent_messages: normalizedRecentMessages,
          memories: [],
          file_references: orcFileRefs,
          image_attachments: orcImageAttachments,
          userId,
          billingIdentity,
          billingRequestId,
          clientRequestId: parsed.data.clientRequestId,
          imageQuotaKey: getImageQuotaKey(req),
        },
      });
      res.json({
        route: result.route,
        answer: result.answer ?? result.reply,
        reply: result.reply,
        disclaimer: result.disclaimer,
        image: result.image,
        web_search: result.web_search,
        tool_events: result.tool_events,
        confidence: result.confidence,
        model_used: result.model_used,
        searched: result.searched === true,
      });
      return;
    }

    if (isGuest) {
      const guestRawContext = {
        recent_messages: normalizedRecentMessages,
        memories: [],
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        web_search_mode: effectiveWebSearchMode,
        userMessage: guestUserMessage,
        billingIdentity,
        billingRequestId,
      };
      const guestContext = executionProfile.context.compressConversation
        ? await buildContext(guestRawContext, undefined, userId, { profile: executionProfile })
        : await buildContextFast(guestRawContext, undefined, userId, { profile: executionProfile });

      if (isMathReasoningQuery) {
        const mathReservation = await reserveAdvancedBilling({
          identity: billingIdentity,
          requestId: `${billingRequestId}:guest-math`,
          conversationId: requestedConversationId,
          clientRequestId: parsed.data.clientRequestId,
          route: "guest.math",
          requiredCapabilities: guestContext.imageAttachments.length ? ["image_input"] : [],
        });
        let mathResult: Awaited<ReturnType<typeof callMathModelRaw>>;
        try {
          mathResult = await callMathModelRaw({
            userMessage: guestUserMessage,
            modelOverride: mathReservation.adapterModelOverride,
            recentMessages: guestContext.recentMessages,
            memories: [],
            fileReferences: guestContext.fileReferences,
            imageAttachments: guestContext.imageAttachments,
            conversationSummary: guestContext.conversationSummary,
            conversationCapsule: guestContext.conversationCapsule,
            workspaceCapsule: guestContext.workspaceCapsule,
            priorConversationEvidence: guestContext.priorConversationEvidence,
            isExplicitRecallQuery: guestContext.isExplicitRecallQuery,
            userId,
            maxOutputTokens: GUEST_MATH_MAX_OUTPUT_TOKENS,
            emptyFallback: GUEST_MATH_EMPTY_FALLBACK,
          });
          await commitTextBilling(mathReservation, "guest.math");
        } catch (error) {
          await releaseBillingReservation(mathReservation);
          throw error;
        }
        res.json({
          route: "math_reasoning",
          answer: mathResult.answer,
          reply: mathResult.answer,
          thinking: undefined,
          disclaimer: PRODUCT_DISCLAIMER,
          image: undefined,
          chart: undefined,
          memory: undefined,
          confidence: undefined,
          model_used: mathResult.model_used,
          searched: false,
        });
        return;
      }

      let guestWebSurfV2: Awaited<ReturnType<typeof prepareWebSurfV2>> | undefined;
      if (webSurfV2Enabled && hasEffectiveWebSearchMode) {
        try {
          guestWebSurfV2 = await prepareWebSurfV2(
            effectiveUserMessage,
            hasExplicitWebSearchMode ? "manual" : "auto",
          );
        } catch (error) {
          res.json({
            route: "web_search",
            answer: "Web search is temporarily unavailable. Please try again later.",
            reply: "Web search is temporarily unavailable. Please try again later.",
            searched: false,
          });
          return;
        }
      }

      const guestReservation = await reserveTextBilling({
        identity: billingIdentity,
        requestId: `${billingRequestId}:guest-chat`,
        conversationId: requestedConversationId,
        clientRequestId: parsed.data.clientRequestId,
        route: "guest.chat",
        executionMode: executionProfile.mode,
        complexity: guestContext.fileReferences.length > 0 ? "heavy" : "normal",
        requiredCapabilities: deriveRequiredModelCapabilities({
          hasImageInput: guestContext.imageAttachments.length > 0,
          automaticToolsRequested: false,
          streaming: false,
        }),
      });
      const guestChatModelOverride = guestReservation.adapterModelOverride;
      let guestResult: Awaited<ReturnType<typeof handleChat>>;
      try {
        guestResult = await handleChat({
          userMessage: guestUserMessage,
          recentMessages: guestContext.recentMessages,
          memories: [],
          fileReferences: guestContext.fileReferences,
          imageAttachments: guestContext.imageAttachments,
          conversationSummary: guestContext.conversationSummary,
          conversationCapsule: guestContext.conversationCapsule,
          workspaceCapsule: guestContext.workspaceCapsule,
          priorConversationEvidence: guestContext.priorConversationEvidence,
          routeEvidence: guestWebSurfV2?.routeEvidence,
          isExplicitRecallQuery: guestContext.isExplicitRecallQuery,
          modelOverride: guestChatModelOverride,
          userId,
          reasoningMode: isReasoningQuery,
          reasoningEffort: executionProfile.model.reasoningEffort,
          webSurfSourceIds: guestWebSurfV2?.synthesisSourceIds,
          webSurfAnswerPlan: guestWebSurfV2?.answerIntelligence?.plan,
          webSurfAnswerSources: guestWebSurfV2?.answerIntelligence?.sources,
          requiredCapabilities: deriveRequiredModelCapabilities({
            hasImageInput: guestContext.imageAttachments.length > 0,
            automaticToolsRequested: false,
            streaming: false,
          }),
        });
        await commitTextBilling(guestReservation, "guest.chat");
      } catch (error) {
        await releaseBillingReservation(guestReservation);
        throw error;
      }

      res.json({
        route: guestWebSurfV2 ? "web_search" : "chat",
        answer: guestResult.answer,
        reply: guestResult.reply,
        thinking: gateThinking(guestResult.thinking, { modelOverride: guestChatModelOverride, isReasoning: isReasoningQuery }),
        disclaimer: guestResult.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
        model_used: guestResult.model_used,
        searched: Boolean(guestWebSurfV2),
        web_search: guestWebSurfV2 ? { v2: guestWebSurfV2.payload } : undefined,
      });
      return;
    }

    const sync = createSyncStatus();

    let createdConversation = false;
    let activeConversationTitle: string | null = null;
    let userMessagePersisted = false;
    let assistantMessagePersisted = false;

    let userDb: any = null;
    let activeConversationId = requestedConversationId || null;
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

    if (userDb) {
      try {
        const resolvedConversation = await resolveOrCreateConversationForRequest(
          userDb,
          userId,
          "chat",
          activeConversationId,
          "New Chat",
          { clientRequestId: parsed.data.clientRequestId },
        );
        activeConversationId = resolvedConversation.conversation.id;
        sync.conversationId = activeConversationId;
        activeConversationTitle = resolvedConversation.conversation.title || null;
        createdConversation = resolvedConversation.created;
      } catch (conversationCreateError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.conversation.resolve-or-create",
          userId,
          conversationCreateError instanceof Error ? conversationCreateError : new Error(String(conversationCreateError)),
          { conversationId: activeConversationId },
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
      const reasoningRawContext = {
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        trustedProfile,
        web_search_mode: effectiveWebSearchMode,
        userMessage: effectiveUserMessage,
        conversationId: activeConversationId || undefined,
        billingIdentity,
        billingRequestId,
      };
      const reasoningContext = executionProfile.context.compressConversation
        ? await buildContext(reasoningRawContext, userDb, userId, { profile: executionProfile })
        : await buildContextFast(reasoningRawContext, userDb, userId, { profile: executionProfile });

      const reasoningReservation = await reserveAdvancedBilling({
        identity: billingIdentity,
        requestId: `${billingRequestId}:reasoning`,
        conversationId: activeConversationId,
        clientRequestId: parsed.data.clientRequestId,
        route: "reasoning",
        requiredCapabilities: reasoningContext.imageAttachments.length ? ["image_input"] : [],
      });
      let result: Awaited<ReturnType<typeof handleChat>>;
      try {
        result = await handleChat({
          userMessage: effectiveUserMessage,
          recentMessages: reasoningContext.recentMessages,
          memories: reasoningContext.memories,
          fileReferences: reasoningContext.fileReferences,
          imageAttachments: reasoningContext.imageAttachments,
          conversationSummary: reasoningContext.conversationSummary,
          conversationCapsule: reasoningContext.conversationCapsule,
          workspaceCapsule: reasoningContext.workspaceCapsule,
          priorConversationEvidence: reasoningContext.priorConversationEvidence,
          isExplicitRecallQuery: reasoningContext.isExplicitRecallQuery,
          trustedProfile: reasoningContext.trustedProfile,
          modelOverride: reasoningReservation.adapterModelOverride,
          userId,
          reasoningMode: true,
          reasoningEffort: executionProfile.model.reasoningEffort,
          requiredCapabilities: reasoningContext.imageAttachments.length ? ["image_input"] : [],
        });
        await commitTextBilling(reasoningReservation, "reasoning");
      } catch (error) {
        await releaseBillingReservation(reasoningReservation);
        throw error;
      }

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
        sync: finalizeSyncStatus(sync),
        degraded: buildDegradedStatus(sync),
      });
      return;
    }

    const result = await orchestrate({
      userMessage: parsed.data.message,
      executionMode: parsed.data.executionMode,
      signal: requestAbortController.signal,
      context: {
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
        image_attachments: orcImageAttachments,
        trustedProfile,
        web_search_mode: effectiveWebSearchMode,
        web_search_trigger: hasEffectiveWebSearchMode ? (hasExplicitWebSearchMode ? "manual" : "auto") : undefined,
        userDb,
        userId,
        conversationId: activeConversationId || undefined,
        billingIdentity,
        billingRequestId,
        clientRequestId: parsed.data.clientRequestId,
        imageQuotaKey: getImageQuotaKey(req),
      },
    });

    let responseReply = result.reply;
    let responseAnswer = result.answer ?? result.reply;
    let responseMemory = result.memory;
    if (result.image?.success && result.image.persisted) assistantMessagePersisted = true;
    if (userDb && result.memory && result.memory.stored === true) {
      const memoryScope = result.memory.automatic_idempotency_key
        ? (result.memory.scope === "chat" ? "chat" : "global")
        : resolveMemoryScopeForRequest(result.memory, parsed.data.message);
      try {
        const automaticKey = result.memory.automatic_idempotency_key;
        const insertInput = {
          ...result.memory,
          scope: memoryScope,
          chat_id: memoryScope === "chat" ? activeConversationId : null,
        };
        const insertedMemory = automaticKey
          ? await insertAutomaticMemoryOrThrow(
              userDb,
              userId,
              { ...insertInput, automatic_idempotency_key: automaticKey },
              "chat",
            )
          : await insertMemoryOrThrow(userDb, userId, insertInput, "chat");
        responseMemory = {
          ...result.memory,
          id: insertedMemory.id,
          deduplicated: "deduplicated" in insertedMemory
            ? Boolean((insertedMemory as AutomaticMemoryInsertResult).deduplicated)
            : false,
          persisted: true,
          scope: insertedMemory.scope === "chat" ? "chat" : "global",
          chat_id: insertedMemory.chat_id ?? null,
          source_conversation_id: activeConversationId ?? null,
        };
        if (result.route === "memory_update") {
          responseReply = getMemoryConfirmationText(responseMemory.scope === "chat" ? "chat" : "global");
          responseAnswer = responseReply;
        }
      } catch (memoryPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        responseMemory = {
          ...result.memory,
          persisted: false,
          scope: memoryScope,
          chat_id: memoryScope === "chat" ? activeConversationId : null,
          source_conversation_id: activeConversationId ?? null,
        };
        if (result.route === "memory_update") {
          responseReply = MEMORY_PERSISTENCE_FAILURE_TEXT;
          responseAnswer = responseReply;
        }
        logDbFailure(
          "chat.memory.persist",
          userId,
          memoryPersistError instanceof Error ? memoryPersistError : new Error(String(memoryPersistError)),
          { conversationId: activeConversationId },
        );
      }
    } else if (result.memory && result.memory.stored === true) {
      sync.persisted = false;
      sync.deferred = true;
      const memoryScope = resolveMemoryScopeForRequest(result.memory, parsed.data.message);
      responseMemory = {
        ...result.memory,
        persisted: false,
        scope: memoryScope,
        chat_id: memoryScope === "chat" ? activeConversationId : null,
        source_conversation_id: activeConversationId ?? null,
      };
      if (result.route === "memory_update") {
        responseReply = MEMORY_PERSISTENCE_FAILURE_TEXT;
        responseAnswer = responseReply;
      }
    }

    if (userDb && activeConversationId && !result.image?.success) {
      try {
        const assistantMessageOptions = result.file?.success
          ? {
              clientRequestId: parsed.data.clientRequestId,
              messageType: "file",
              fileUrl: result.file.file_url,
              storagePath: result.file.storage_path,
              prompt: parsed.data.message,
              provider: result.file.model_used,
              fileSizeBytes: result.file.file_size_bytes,
              fileName: result.file.file_name,
              fileFormat: result.file.format,
              mimeType: result.file.mime_type,
              generatedFileId: result.file.file_id,
              previewJson: result.file.preview,
            }
          : result.chart?.success
            ? {
                clientRequestId: parsed.data.clientRequestId,
                messageType: "text",
                previewJson: { chart: result.chart },
              }
            : { clientRequestId: parsed.data.clientRequestId };
        const webSurfV2Payload = result.web_search?.v2;
        const persistedAssistantOptions = webSurfV2Payload && !result.file?.success
          ? {
              clientRequestId: parsed.data.clientRequestId,
              messageType: "text",
              previewJson: getWebSurfV2Preview(webSurfV2Payload),
            }
          : assistantMessageOptions;
        await insertConversationMessageOrThrow(
          userDb,
          userId,
          activeConversationId,
          "assistant",
          responseReply ?? "",
          "chat",
          persistedAssistantOptions,
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
        assistantReply: responseReply ?? "",
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
      answer: responseAnswer,
      reply: responseReply,
      thinking: gateThinking(result.thinking, { route: result.route, isReasoning: isReasoningQuery }),
      disclaimer: result.disclaimer,
      image: result.image,
      chart: result.chart,
      file: result.file,
      memory: responseMemory,
      web_search: result.web_search,
      confidence: result.confidence,
      model_used: result.model_used,
      searched: result.searched === true,
      tool_events: result.tool_events,
      sync: finalizeSyncStatus(sync),
      degraded: buildDegradedStatus(sync),
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
    let responseCompleted = false;
    const requestAbortController = new AbortController();
    attachStreamDisconnectLifecycle({
      request: req,
      response: res,
      isResponseCompleted: () => responseCompleted,
      onDisconnect: () => {
        clientDisconnected = true;
        requestAbortController.abort(new Error("Client disconnected"));
      },
    });

    const sseWriter = createSseWriter(res, { maxBufferedBytes: 512 * 1024 });
    const writeSseEvent = async (payload: string) => {
      if (clientDisconnected) return;
      ensureSseStarted();
      await sseWriter.write(payload);
    };
    const writeSseJson = async (payload: unknown) => {
      await writeSseEvent(JSON.stringify(sanitizePublicPayload(payload)));
    };
    const finishSse = () => {
      responseCompleted = true;
      sseWriter.close();
    };
    let sseStarted = false;
    const ensureSseStarted = () => {
      if (sseStarted || res.headersSent) return;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      sseStarted = true;
    };
    const writeStructuredResponse = async (response: Record<string, unknown>) => {
      ensureSseStarted();
      await writeSseJson({ type: "structured_response", response });
      await writeSseEvent("[DONE]");
      finishSse();
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

    const solveGuestMathWithGemini = async (args: {
      userMessage: string;
      userId: string;
      recentMessages?: readonly { role: string; content: string }[];
      fileReferences?: readonly { filename: string; extractedText: string }[];
      imageAttachments?: readonly ImageAttachment[];
      conversationSummary?: string;
      conversationCapsule?: string;
      workspaceCapsule?: string;
      priorConversationEvidence?: readonly { content: string; createdAt?: string }[];
      isExplicitRecallQuery?: boolean;
      modelOverride?: string;
    }) => {
      const result = await callMathModelRaw({
        userMessage: args.userMessage,
        modelOverride: args.modelOverride ?? GUEST_MODEL_OVERRIDE,
        recentMessages: args.recentMessages,
        memories: [],
        fileReferences: args.fileReferences,
        imageAttachments: args.imageAttachments,
        conversationSummary: args.conversationSummary,
        conversationCapsule: args.conversationCapsule,
        workspaceCapsule: args.workspaceCapsule,
        priorConversationEvidence: args.priorConversationEvidence,
        isExplicitRecallQuery: args.isExplicitRecallQuery,
        userId: args.userId,
        maxOutputTokens: GUEST_MATH_MAX_OUTPUT_TOKENS,
        emptyFallback: GUEST_MATH_EMPTY_FALLBACK,
      });
      return {
        reply: result.answer,
        model_used: result.model_used,
        fallback: result.fallback ?? false,
      };
    };

    const sendStreamError = async (err: unknown, metrics?: StreamMetrics) => {
      const message = err instanceof Error ? err.message : String(err);
      const partial = Boolean(metrics && metrics.chunkCount > 0);
      const rawErrorCode = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : undefined;
      const explicitCode = rawErrorCode === "websurf_retrieval_failed"
        || rawErrorCode === "model_tool_capability_unavailable"
        ? rawErrorCode
        : undefined;
      console.error(`[Stream] error: ${message}`);
      if (!clientDisconnected) {
        try {
          ensureSseStarted();
          if (err instanceof BillingQuotaError) {
            const quotaPayload = quotaErrorToPublicResponse(err);
            await writeSseJson({
              ...quotaPayload,
              quota_type: quotaPayload.type,
              type: "error",
              partial,
              streamed_chunks: metrics?.chunkCount ?? 0,
              approx_tokens: metrics?.approxTokens ?? 0,
            });
            await writeSseEvent("[DONE]");
            return;
          }
          if (err instanceof ModelCapabilityUnavailableError) {
            await writeSseJson({
              type: "error",
              code: err.code,
              error: err.message,
              partial,
              streamed_chunks: metrics?.chunkCount ?? 0,
              approx_tokens: metrics?.approxTokens ?? 0,
            });
            await writeSseEvent("[DONE]");
            return;
          }
          await writeSseJson({
            type: "error",
            code: explicitCode ?? (partial ? "response_interrupted" : "backend_unavailable"),
            error: explicitCode === "model_tool_capability_unavailable"
              ? "A compatible tool-capable model is temporarily unavailable. Please try again later."
              : partial
                ? "The response was interrupted. Your partial answer has been preserved."
                : `${PRODUCT_NAME} could not finish that response. Please try again.`,
            partial,
            streamed_chunks: metrics?.chunkCount ?? 0,
            approx_tokens: metrics?.approxTokens ?? 0,
          });
          await writeSseEvent("[DONE]");
        } catch (writeErr) {
          console.error(`[Stream] failed to emit error event: ${writeErr instanceof Error ? writeErr.message : writeErr}`);
        }
      }
      try {
        reportStreamMessageGap(true, "stream.error", message);
      } catch {
        // Guest and early validation stream failures may happen before persistence state exists.
      }
      if (metrics) {
        logStreamMetrics(metrics, "error");
      }
    };

    const startStreamHeartbeat = (intervalMs: number, tag: string) => {
      if (!intervalMs || intervalMs <= 0) return () => {};
      const timer = setInterval(() => {
        if (clientDisconnected) return;
        writeSseJson({ type: "heartbeat", ts: Date.now() }).catch((err) => {
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
    const executionProfile = resolveExecutionProfile(parsed.data.executionMode);

    if (detectPromptInjection(parsed.data.message)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    // ── Safety gate: chart requests MUST go through the orchestrator ──
    // Explicit manual routes are resolved before the general streaming turn.
    // If the message is a chart request, redirect to the orchestrator and return
    // the result as a single SSE JSON payload so the frontend can render it.
    const normalizedRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );
    const requestUser = getRequestUser(req);
    const { sub: userId, isGuest } = requestUser;
    const billingIdentity = buildBillingIdentity(req, requestUser);
    const billingRequestId = buildBillingRequestId("chat-stream", userId, parsed.data.clientRequestId);
    const effectiveUserMessage = parsed.data.message;
    if (detectPromptInjection(effectiveUserMessage)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }
    const requestedConversationId = getOptionalUuid(parsed.data.conversationId, "conversationId", {
      ignoreInvalid: isGuest,
    });
    const webSearchMode = getExplicitWebSearchMode(parsed.data.context?.web_search_mode);
    const hasExplicitWebSearchMode = Boolean(webSearchMode);
    const effectiveWebSearchMode = webSearchMode;
    const hasEffectiveWebSearchMode = Boolean(effectiveWebSearchMode);
    const webSurfV2Enabled = isWebSurfV2Enabled();
    const isBufferedReasoning = false;
    const isMathReasoningQuery = false;
    const guestUserMessage = effectiveUserMessage;
    if (isGuest && hasEffectiveWebSearchMode && !webSurfV2Enabled) {
      const result = await orchestrate({
        userMessage: parsed.data.message,
        executionMode: parsed.data.executionMode,
        signal: requestAbortController.signal,
        context: {
          recent_messages: normalizedRecentMessages,
          memories: [],
          file_references: parsed.data.context?.file_references,
          image_attachments: parsed.data.context?.image_attachments,
          web_search_mode: effectiveWebSearchMode,
          userId,
          billingIdentity,
          billingRequestId,
        },
      });
      await writeStructuredResponse({
        route: result.route,
        answer: result.answer ?? result.reply,
        reply: result.reply,
        thinking: gateThinking(result.thinking, { route: result.route, isReasoning: isBufferedReasoning }),
        disclaimer: result.disclaimer,
        image: result.image,
        chart: result.chart,
        file: result.file,
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
        const streamMetrics = createStreamMetrics(
          "chat.stream.guest.reasoning",
          requestStart,
          { model: GUEST_MODEL_OVERRIDE },
        );

        try {
          if (isMathReasoningQuery) {
            let guestMathStreamReply = "";
            const guestMathReservation = await reserveAdvancedBilling({
              identity: billingIdentity,
              requestId: `${billingRequestId}:guest-math-stream`,
              conversationId: requestedConversationId,
              clientRequestId: parsed.data.clientRequestId,
              route: "guest.math.stream",
              requiredCapabilities: parsed.data.context?.image_attachments?.length ? ["image_input"] : [],
            });
            await writeSseJson({ type: "route", route: "math_reasoning" });
            let guestMathCommitted = false;
            try {
            const guestMathRawContext = {
              recent_messages: normalizedRecentMessages,
              memories: [],
              file_references: parsed.data.context?.file_references,
              image_attachments: parsed.data.context?.image_attachments,
              web_search_mode: effectiveWebSearchMode,
              userMessage: guestUserMessage,
              billingIdentity,
              billingRequestId,
            };
            const guestMathContext = executionProfile.context.compressConversation
              ? await buildContext(guestMathRawContext, undefined, userId, { profile: executionProfile })
              : await buildContextFast(guestMathRawContext, undefined, userId, { profile: executionProfile });

            try {
              const mathStream = await streamMathModelRaw({
                userMessage: guestUserMessage,
                modelOverride: guestMathReservation.adapterModelOverride,
                userId,
                recentMessages: guestMathContext.recentMessages,
                memories: [],
                fileReferences: guestMathContext.fileReferences,
                imageAttachments: guestMathContext.imageAttachments,
                conversationSummary: guestMathContext.conversationSummary,
                conversationCapsule: guestMathContext.conversationCapsule,
                workspaceCapsule: guestMathContext.workspaceCapsule,
                priorConversationEvidence: guestMathContext.priorConversationEvidence,
                isExplicitRecallQuery: guestMathContext.isExplicitRecallQuery,
                maxOutputTokens: GUEST_MATH_MAX_OUTPUT_TOKENS,
                signal: requestAbortController.signal,
              });
              const reader = mathStream.getReader();
              try {
                while (true) {
                  if (clientDisconnected) break;
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (!value) continue;
                  guestMathStreamReply += value;
                  recordStreamChunk(streamMetrics, value);
                  await writeSseJson({ type: "token", text: value });
                }
              } finally {
                if (clientDisconnected) {
                  await reader.cancel("client disconnected").catch(() => undefined);
                }
              }
            } catch (streamErr) {
              if (streamMetrics.chunkCount > 0 || clientDisconnected) {
                throw streamErr;
              }
              console.warn(
                `[Stream] guest math live stream failed before first token; falling back to buffered math: ${streamErr instanceof Error ? streamErr.message : streamErr}`,
              );
                const result = await solveGuestMathWithGemini({
                  userMessage: guestUserMessage,
                  userId,
                recentMessages: guestMathContext.recentMessages,
                fileReferences: guestMathContext.fileReferences,
                imageAttachments: guestMathContext.imageAttachments,
                conversationSummary: guestMathContext.conversationSummary,
                conversationCapsule: guestMathContext.conversationCapsule,
                workspaceCapsule: guestMathContext.workspaceCapsule,
                priorConversationEvidence: guestMathContext.priorConversationEvidence,
                isExplicitRecallQuery: guestMathContext.isExplicitRecallQuery,
                modelOverride: guestMathReservation.adapterModelOverride,
                });
              guestMathStreamReply = result.reply;
              await streamBufferedAnswer(result.reply, undefined, false, streamMetrics);
            }

            if (!guestMathStreamReply.trim() && !clientDisconnected) {
              console.warn(`[StreamRecovery] route=guest.math model=${GUEST_MODEL_OVERRIDE} reason=empty_stream attempt=buffered_math`);
              const result = await solveGuestMathWithGemini({
                userMessage: guestUserMessage,
                userId,
                recentMessages: guestMathContext.recentMessages,
                fileReferences: guestMathContext.fileReferences,
                imageAttachments: guestMathContext.imageAttachments,
                conversationSummary: guestMathContext.conversationSummary,
                conversationCapsule: guestMathContext.conversationCapsule,
                workspaceCapsule: guestMathContext.workspaceCapsule,
                priorConversationEvidence: guestMathContext.priorConversationEvidence,
                isExplicitRecallQuery: guestMathContext.isExplicitRecallQuery,
                modelOverride: guestMathReservation.adapterModelOverride,
              });
              guestMathStreamReply = assertUsableAssistantText(result.reply, {
                route: "guest.math",
                model: GUEST_MODEL_OVERRIDE,
                reason: "empty_stream",
              });
              await streamBufferedAnswer(guestMathStreamReply, undefined, false, streamMetrics);
            }

            if (!clientDisconnected) {
              await commitTextBilling(guestMathReservation, "guest.math.stream");
              guestMathCommitted = true;
              await writeSseEvent("[DONE]");
              logStreamMetrics(streamMetrics, "complete");
            } else {
              await releaseBillingReservation(guestMathReservation);
              guestMathCommitted = true;
            }
            } catch (error) {
              if (!guestMathCommitted) {
                await releaseBillingReservation(guestMathReservation);
              }
              throw error;
            }
            return;
          }

          const guestReasoningRawContext = {
            recent_messages: normalizedRecentMessages,
            memories: [],
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            web_search_mode: effectiveWebSearchMode,
            userMessage: guestUserMessage,
            billingIdentity,
            billingRequestId,
          };
          const guestReasoningContext = executionProfile.context.compressConversation
            ? await buildContext(guestReasoningRawContext, undefined, userId, { profile: executionProfile })
            : await buildContextFast(guestReasoningRawContext, undefined, userId, { profile: executionProfile });

          const guestReasoningReservation = await reserveAdvancedBilling({
            identity: billingIdentity,
            requestId: `${billingRequestId}:guest-reasoning-stream`,
            conversationId: requestedConversationId,
            clientRequestId: parsed.data.clientRequestId,
            route: "guest.reasoning.stream",
            requiredCapabilities: guestReasoningContext.imageAttachments.length ? ["image_input"] : [],
          });
          let guestReasoningCommitted = false;
          try {
          const result = await handleChat({
            userMessage: guestUserMessage,
            recentMessages: guestReasoningContext.recentMessages,
            memories: [],
            fileReferences: guestReasoningContext.fileReferences,
            imageAttachments: guestReasoningContext.imageAttachments,
            conversationSummary: guestReasoningContext.conversationSummary,
            conversationCapsule: guestReasoningContext.conversationCapsule,
            workspaceCapsule: guestReasoningContext.workspaceCapsule,
            priorConversationEvidence: guestReasoningContext.priorConversationEvidence,
            isExplicitRecallQuery: guestReasoningContext.isExplicitRecallQuery,
            modelOverride: guestReasoningReservation.adapterModelOverride,
            userId,
            reasoningMode: true,
            reasoningEffort: executionProfile.model.reasoningEffort,
            signal: requestAbortController.signal,
            requiredCapabilities: guestReasoningContext.imageAttachments.length ? ["image_input"] : [],
          });

          if (!clientDisconnected) {
            let reply = result.reply;
            const unavailableReason = getUnavailableReplyReason(reply);
            if (unavailableReason) {
              reply = await recoverBufferedReplyText({
                route: "guest.reasoning",
                model: GUEST_MODEL_OVERRIDE,
                reason: unavailableReason,
                invoke: async () => (await handleChat({
                  userMessage: guestUserMessage,
                  recentMessages: guestReasoningContext.recentMessages,
                  memories: [],
                  fileReferences: guestReasoningContext.fileReferences,
                  imageAttachments: guestReasoningContext.imageAttachments,
                  conversationSummary: guestReasoningContext.conversationSummary,
                  conversationCapsule: guestReasoningContext.conversationCapsule,
                  workspaceCapsule: guestReasoningContext.workspaceCapsule,
                  priorConversationEvidence: guestReasoningContext.priorConversationEvidence,
                  isExplicitRecallQuery: guestReasoningContext.isExplicitRecallQuery,
                  modelOverride: guestReasoningReservation.adapterModelOverride,
                  userId,
                  reasoningMode: true,
                  reasoningEffort: executionProfile.model.reasoningEffort,
                  signal: requestAbortController.signal,
                })).reply,
              });
            }
            const thinking = unavailableReason ? undefined : gateThinking(result.thinking, { isReasoning: true });
            await streamBufferedAnswer(reply, thinking, !unavailableReason, streamMetrics);
            await commitTextBilling(guestReasoningReservation, "guest.reasoning.stream");
            guestReasoningCommitted = true;
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "complete");
          } else {
            await releaseBillingReservation(guestReasoningReservation);
            guestReasoningCommitted = true;
          }
          } catch (error) {
            if (!guestReasoningCommitted) {
              await releaseBillingReservation(guestReasoningReservation);
            }
            throw error;
          }
        } catch (err) {
          await sendStreamError(err, streamMetrics);
        } finally {
          finishSse();
        }
        return;
      }

      const fileRefs = parsed.data.context?.file_references;
      const guestCtx = await buildContextFast({
        recent_messages: normalizedRecentMessages,
        memories: [],
        file_references: fileRefs,
        image_attachments: parsed.data.context?.image_attachments,
        web_search_mode: effectiveWebSearchMode,
        userMessage: guestUserMessage,
        billingIdentity,
        billingRequestId,
        clientRequestId: parsed.data.clientRequestId,
        imageQuotaKey: getImageQuotaKey(req),
      }, undefined, userId, { profile: executionProfile });

      const guestFastPath = !guestCtx.hasFileContext && effectiveUserMessage.length <= 280;
      const guestGeneralReservation = await reserveTextBilling({
        identity: billingIdentity,
        requestId: `${billingRequestId}:guest-general-stream`,
        conversationId: requestedConversationId,
        clientRequestId: parsed.data.clientRequestId,
        route: "guest.general.stream",
        executionMode: executionProfile.mode,
        complexity: guestCtx.hasFileContext ? "heavy" : "normal",
        requiredCapabilities: deriveRequiredModelCapabilities({
          hasImageInput: guestCtx.imageAttachments.length > 0,
          automaticToolsRequested: !hasEffectiveWebSearchMode && getEnabledAutomaticSentIQTools().length > 0,
          streaming: false,
        }),
      });
      const guestGeneralModelOverride = guestGeneralReservation.adapterModelOverride;
      const streamMetrics = createStreamMetrics(
        "chat.stream.guest.general",
        requestStart,
        { model: guestGeneralModelOverride, fastPath: guestFastPath },
      );

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      console.log(`[Latency] guest buffered response request started (+${Date.now() - requestStart}ms)`);
      console.log(`[Stream] guest model=${guestGeneralModelOverride} hasFiles=${guestCtx.hasFileContext} msgLen=${parsed.data.message.length}`);

      let guestGeneralCallForRecovery: LLMAdapterCall | null = null;
      let guestWebSurfV2: Awaited<ReturnType<typeof prepareWebSurfV2>> | undefined;
      let guestCitationStream: WebSurfCitationStream | undefined;
      let guestOutputGuard: WebSurfOutputGuardStream | undefined;
      let guestAutomaticToolAccepted = false;
      const guestTurnProgress = new ModelTurnProgressTracker();
      try {
        const streamStart = Date.now();
        await writeSseJson({ type: "route", route: "chat" });
        if (webSurfV2Enabled && hasEffectiveWebSearchMode) {
          await writeSseJson({ type: "route", route: "web_search", v2: true });
          guestWebSurfV2 = await prepareWebSurfV2(
            effectiveUserMessage,
            hasExplicitWebSearchMode ? "manual" : "auto",
            {},
            requestAbortController.signal,
          );
          guestCitationStream = new WebSurfCitationStream(new Set(guestWebSurfV2.synthesisSourceIds), {
            preserveSourceMarkers: guestWebSurfV2.payload.presentationVersion === 1,
          });
          if (guestWebSurfV2.answerIntelligence) {
            guestOutputGuard = new WebSurfOutputGuardStream(new Set(guestWebSurfV2.synthesisSourceIds));
          }
          await writeSseJson({ type: "websurf_sources", web_search: guestWebSurfV2.payload });
        }
        if (isMathReasoningQuery) {
          await writeSseJson({ type: "route", route: "math_reasoning" });
          const result = await solveGuestMathWithGemini({
            userMessage: guestUserMessage,
            userId,
            recentMessages: guestCtx.recentMessages,
            fileReferences: guestCtx.fileReferences,
            imageAttachments: guestCtx.imageAttachments,
            conversationSummary: guestCtx.conversationSummary,
            conversationCapsule: guestCtx.conversationCapsule,
            workspaceCapsule: guestCtx.workspaceCapsule,
            priorConversationEvidence: guestCtx.priorConversationEvidence,
            isExplicitRecallQuery: guestCtx.isExplicitRecallQuery,
            modelOverride: guestGeneralModelOverride,
          });
          if (!clientDisconnected) {
            await streamBufferedAnswer(result.reply, undefined, false, streamMetrics);
            await commitTextBilling(guestGeneralReservation, "guest.general.math-buffered");
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "complete");
          } else {
            await releaseBillingReservation(guestGeneralReservation);
          }
          console.log(`[Stream] guest math buffered response completed in ${Date.now() - streamStart}ms`);
          return;
        }

        const call = buildChatPrompt({
          userMessage: guestUserMessage,
          recentMessages: guestCtx.recentMessages,
          memories: [],
          fileReferences: guestCtx.fileReferences,
          imageAttachments: guestCtx.imageAttachments,
          conversationSummary: guestCtx.conversationSummary,
          conversationCapsule: guestCtx.conversationCapsule,
          workspaceCapsule: guestCtx.workspaceCapsule,
          priorConversationEvidence: guestCtx.priorConversationEvidence,
          routeEvidence: guestWebSurfV2?.routeEvidence,
          isExplicitRecallQuery: guestCtx.isExplicitRecallQuery,
          modelOverride: guestGeneralModelOverride,
          userId,
          streaming: true,
          reasoningEffort: executionProfile.model.reasoningEffort,
          webSurfSourceIds: guestWebSurfV2?.synthesisSourceIds,
          webSurfAnswerPlan: guestWebSurfV2?.answerIntelligence?.plan,
          webSurfAnswerSources: guestWebSurfV2?.answerIntelligence?.sources,
        });
        guestGeneralCallForRecovery = call;
        const automaticTools = guestWebSurfV2
          ? []
          : getAutomaticSentIQToolsForRoute(guestGeneralReservation, true);
        const toolTransport = automaticTools.length > 0
          ? resolveModelToolTransport(guestGeneralReservation, "streaming")
          : null;
        const requiredCapabilities = deriveRequiredModelCapabilities({
          hasImageInput: guestCtx.imageAttachments.length > 0,
          automaticToolsRequested: automaticTools.length > 0,
          toolTransportMode: toolTransport?.mode === "streaming" ? "streaming" : "buffered",
        });
        const intuitiveLaneActive = isNemotronIntuitiveLaneEnabled(executionProfile.mode)
          && guestCtx.imageAttachments.length === 0;
        const intuitiveToolSelectionActive = intuitiveLaneActive && automaticTools.length > 0;
        const initialTurnCall: LLMAdapterCall = {
          ...call,
          signal: requestAbortController.signal,
          ...(intuitiveToolSelectionActive
            ? {
                prompt: buildIntuitiveToolSelectionPrompt(effectiveUserMessage, automaticTools),
                max_output_tokens: 200,
                execution_mode: "fast" as const,
                reasoning_effort: "low" as const,
                safety_mode: "low_risk_text" as const,
                budget_class: "auxiliary" as const,
                auxiliary_budget: "routing" as const,
                skip_wrappers: true,
              }
            : { execution_mode: executionProfile.mode }),
          sentiq_tool_context: automaticTools.length > 0 ? { authenticated: false, executionMode: executionProfile.mode } : undefined,
          sentiq_allowed_tool_names: automaticTools,
          required_capabilities: requiredCapabilities,
          tool_transport_mode: toolTransport?.mode ?? "none",
        };
        const adapterStream = await callLLMAdapterTurnStream(initialTurnCall);
        let fullReply = "";

        let turn = await consumeModelTurnStream(adapterStream, async (value) => {
            if (intuitiveToolSelectionActive) return;
            if (clientDisconnected) return;
            const safeValue = guestOutputGuard ? guestOutputGuard.push(value) : value;
            fullReply += safeValue;
            const visible = guestCitationStream ? guestCitationStream.push(safeValue) : safeValue;
            if (visible) {
              recordStreamChunk(streamMetrics, visible);
              await writeSseJson({ type: "token", text: visible });
            }
        }, (progress) => {
          if (!intuitiveToolSelectionActive) guestTurnProgress.advance(progress);
        }, {
          validateAssistantText: assertNoUnbackedToolCompletionClaim,
        });
        if (intuitiveToolSelectionActive && turn.kind === "assistant_text") {
          const finalStream = await callLLMAdapterTurnStream({
            ...call,
            signal: requestAbortController.signal,
            execution_mode: "intuitive",
            sentiq_tool_context: undefined,
            sentiq_allowed_tool_names: [],
            required_capabilities: [],
            tool_transport_mode: "none",
          });
          turn = await consumeModelTurnStream(finalStream, async (value) => {
            if (clientDisconnected) return;
            const safeValue = guestOutputGuard ? guestOutputGuard.push(value) : value;
            fullReply += safeValue;
            const visible = guestCitationStream ? guestCitationStream.push(safeValue) : safeValue;
            if (visible) {
              recordStreamChunk(streamMetrics, visible);
              await writeSseJson({ type: "token", text: visible });
            }
          }, (progress) => guestTurnProgress.advance(progress), {
            validateAssistantText: assertNoUnbackedToolCompletionClaim,
          });
        }
        if (turn.kind === "tool_calls") {
          guestAutomaticToolAccepted = true;
          guestTurnProgress.advance("execution_started");
          const requestsFileGeneration = turn.calls.some((call) => call.name === "file_gen");
          const tokenAccounting = getTokenAllowanceAccounting(guestGeneralReservation.requestId);
          const affordableArtifactTokens = tokenAccounting
            ? tokenAccounting.reservedTokens - tokenAccounting.inputTokens - tokenAccounting.outputTokens
            : 0;
          if (requestsFileGeneration
              && (
                !["premium_text", "unified_text"].includes(guestGeneralReservation.feature)
                || affordableArtifactTokens < 2_048
              )) {
            await releaseBillingReservation(guestGeneralReservation);
            if (guestGeneralReservation.feature === "unified_text") {
              throw new BillingQuotaError(
                "Your remaining text-token allowance cannot support this request yet. Try a smaller request or wait for tokens to refresh.",
                {
                  code: "unified_text_insufficient_for_request",
                  type: "insufficient_allowance",
                  planCode: guestGeneralReservation.planCode,
                  policyVersion: guestGeneralReservation.policyVersion,
                  requiredMode: null,
                  limitTokens: guestGeneralReservation.limit,
                  remainingTokens: guestGeneralReservation.remaining,
                  fastAvailableTokens: guestGeneralReservation.remaining,
                  nextRecoveryAt: guestGeneralReservation.resetAt,
                  resetAt: guestGeneralReservation.resetAt,
                },
              );
            }
            throw new BillingQuotaError(
              "You do not have enough Standard tokens remaining for this request. Your allowance will refresh automatically.",
              {
                code: "quota_exceeded",
                feature: "premium_text",
                planCode: guestGeneralReservation.planCode,
                resetAt: guestGeneralReservation.resetAt,
                limit: guestGeneralReservation.limit,
                remaining: guestGeneralReservation.remaining,
              },
            );
          }
          let toolResult = await executeAutomaticModelToolCalls(
            turn.calls,
            effectiveUserMessage,
            guestCtx,
            executionProfile,
            requestAbortController.signal,
            async (event) => writeSseJson(event),
          );
          if (intuitiveLaneActive) {
            toolResult = await synthesizeIntuitiveToolResult(
              toolResult,
              effectiveUserMessage,
              guestCtx,
              executionProfile,
              guestGeneralModelOverride,
              requestAbortController.signal,
            );
          }
          const deliveredUsableResult = toolResult.file?.success === true
            || toolResult.image?.success === true
            || toolResult.chart?.success === true
            || (toolResult.tool === "web_search" && Boolean(toolResult.reply?.trim()))
            || (toolResult.tool === "memory_update" && toolResult.memory?.stored === true);
          if (deliveredUsableResult && !clientDisconnected) {
            await commitTextBilling(guestGeneralReservation, `guest.general.stream.${toolResult.tool}`);
          } else {
            await releaseBillingReservation(guestGeneralReservation);
          }
          if (toolResult.reply && !toolResult.image) {
            await streamBufferedAnswer(toolResult.reply, undefined, false, streamMetrics);
          }
          if (toolResult.web_search?.v2) {
            await writeSseJson({ type: "websurf_sources", web_search: toolResult.web_search.v2 });
            await writeSseJson({ type: "websurf_complete", answer: toolResult.reply, web_search: toolResult.web_search.v2 });
          }
          if (toolResult.image) {
            await writeSseJson({ type: "structured_response", response: { route: "image_generation", image: toolResult.image, reply: toolResult.reply } });
          }
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
          return;
        }

        const outputGuardTail = guestOutputGuard?.flush();
        if (outputGuardTail) {
          fullReply += outputGuardTail;
          const visible = guestCitationStream ? guestCitationStream.push(outputGuardTail) : outputGuardTail;
          if (visible) {
            recordStreamChunk(streamMetrics, visible);
            await writeSseJson({ type: "token", text: visible });
          }
        }

        if (!fullReply.trim() && !clientDisconnected) {
          const fallbackText = await recoverBufferedStreamText({
            route: "guest.general",
            model: guestGeneralModelOverride,
            reason: "empty_stream",
            call,
            timeoutMs: 90_000,
            signal: requestAbortController.signal,
          });
          const safeFallbackText = guestOutputGuard
            ? `${guestOutputGuard.push(fallbackText)}${guestOutputGuard.flush()}`
            : fallbackText;
          fullReply = safeFallbackText;
          const visible = guestCitationStream
            ? `${guestCitationStream.push(safeFallbackText)}${guestCitationStream.flush()}`
            : safeFallbackText;
          await streamBufferedAnswer(visible, undefined, false, streamMetrics);
        }

        if (fullReply && !clientDisconnected) {
          logWebSurfAnswerOutput({
            profile: guestWebSurfV2?.answerIntelligence?.plan.profile,
            answer: fullReply,
            outputGuardRemovedInternalArtefact: guestOutputGuard?.removedInternalArtefact ?? false,
          });
          await commitTextBilling(guestGeneralReservation, "guest.general.stream");
        } else if (clientDisconnected) {
          await releaseBillingReservation(guestGeneralReservation);
        }

        if (!clientDisconnected) {
          const citationTail = guestCitationStream?.flush();
          if (citationTail) {
            recordStreamChunk(streamMetrics, citationTail);
            await writeSseJson({ type: "token", text: citationTail });
          }
          if (guestWebSurfV2) {
            await writeSseJson({
              type: "websurf_complete",
              answer: fullReply,
              web_search: guestWebSurfV2.payload,
            });
          }
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
        }
        console.log(`[Stream] guest live stream completed in ${Date.now() - streamStart}ms`);
      } catch (err) {
        if (guestAutomaticToolAccepted) {
          await releaseBillingReservation(guestGeneralReservation);
          await sendStreamError(err, streamMetrics);
          return;
        }
        if (
          guestTurnProgress.canRecover()
          && streamMetrics.chunkCount === 0
          && !clientDisconnected
          && guestGeneralCallForRecovery
          && (!err || typeof err !== "object" || (err as { code?: string }).code !== "model_tool_capability_unavailable")
        ) {
          try {
            const fallbackText = await recoverBufferedStreamText({
              route: "guest.general",
              model: guestGeneralModelOverride,
              reason: "stream_error_before_first_token",
              call: guestGeneralCallForRecovery,
              timeoutMs: 90_000,
              signal: requestAbortController.signal,
            });
            const safeFallbackText = guestOutputGuard
              ? `${guestOutputGuard.push(fallbackText)}${guestOutputGuard.flush()}`
              : fallbackText;
            const visible = guestCitationStream
              ? `${guestCitationStream.push(safeFallbackText)}${guestCitationStream.flush()}`
              : safeFallbackText;
            await streamBufferedAnswer(visible, undefined, false, streamMetrics);
            await commitTextBilling(guestGeneralReservation, "guest.general.stream.fallback");
            logWebSurfAnswerOutput({
              profile: guestWebSurfV2?.answerIntelligence?.plan.profile,
              answer: safeFallbackText,
              outputGuardRemovedInternalArtefact: guestOutputGuard?.removedInternalArtefact ?? false,
            });
            if (guestWebSurfV2) {
              await writeSseJson({
                type: "websurf_complete",
                answer: safeFallbackText,
                web_search: guestWebSurfV2.payload,
              });
            }
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "fallback");
            return;
          } catch (fallbackErr) {
            console.error(
              `[StreamRecovery] route=guest.general fallback_failed=${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
            );
            await releaseBillingReservation(guestGeneralReservation);
            await sendStreamError(fallbackErr, streamMetrics);
            return;
          }
        }
        let streamError = err;
        const settlementAlreadyUnavailable = err instanceof BillingQuotaError
          && err.code === "unified_text_quota_unavailable";
        if (streamMetrics.chunkCount > 0 && !settlementAlreadyUnavailable) {
          try {
            await commitTextBilling(guestGeneralReservation, "guest.general.stream.partial");
          } catch (settlementErr) {
            streamError = settlementErr;
          }
        } else if (streamMetrics.chunkCount === 0) {
          await releaseBillingReservation(guestGeneralReservation);
        }
        await sendStreamError(streamError, streamMetrics);
      } finally {
        finishSse();
      }
      return;
    }

    const fastHasFileContext = (parsed.data.context?.file_references?.length ?? 0) > 0;
    const fastHasImageContext = (parsed.data.context?.image_attachments?.length ?? 0) > 0;
    const fastPlainChatEligible =
      executionProfile.mode === "fast" &&
      getEnabledAutomaticSentIQTools().length === 0 &&
      !hasEffectiveWebSearchMode &&
      !fastHasFileContext &&
      !fastHasImageContext &&
      !isBufferedReasoning;

    if (fastPlainChatEligible) {
      const requestStart = Date.now();
      console.log(`[FastStream] signed-in plain chat fast path start`);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      sseStarted = true;

      type FastPersistenceBootstrap = {
        sync: SyncStatus;
        userDb: any | null;
        activeConversationId: string | null;
        activeConversationTitle: string | null;
        createdConversation: boolean;
        userMessagePersisted: boolean;
      };

      const createDeferredFastSync = (reason = "persistence_deferred") => {
        const sync = createSyncStatus(requestedConversationId || undefined);
        sync.persisted = false;
        sync.deferred = true;
        sync.reason = reason;
        return sync;
      };

      const bootstrapFastPersistence = async (): Promise<FastPersistenceBootstrap> => {
        const sync = createSyncStatus(requestedConversationId || undefined);
        let fastUserDb: any | null = null;
        let fastConversationId = requestedConversationId || null;
        let fastConversationTitle: string | null = null;
        let fastCreatedConversation = false;
        let fastUserMessagePersisted = false;

        try {
          fastUserDb = await resolveUserDatabaseOrThrow(userId, "chat.stream.fast");
          await initializeUserSessionOrThrow(fastUserDb, userId, "chat.stream.fast");
          await ensureNamedWorkspaceProfile(userId, "chat.stream.fast", fastUserDb);
        } catch (dbBootstrapError) {
          sync.persisted = false;
          sync.deferred = true;
          sync.reason = "persistence_deferred";
          logDbFailure(
            "chat.stream.fast.bootstrap",
            userId,
            dbBootstrapError instanceof Error ? dbBootstrapError : new Error(String(dbBootstrapError)),
            { conversationId: fastConversationId },
          );
          return {
            sync,
            userDb: null,
            activeConversationId: fastConversationId,
            activeConversationTitle: null,
            createdConversation: false,
            userMessagePersisted: false,
          };
        }

        try {
          const resolvedConversation = await resolveOrCreateConversationForRequest(
            fastUserDb,
            userId,
            "chat.stream.fast",
            fastConversationId,
            "New Chat",
            { clientRequestId: parsed.data.clientRequestId },
          );
          fastConversationId = resolvedConversation.conversation.id;
          sync.conversationId = fastConversationId;
          fastConversationTitle = resolvedConversation.conversation.title || null;
          fastCreatedConversation = resolvedConversation.created;
        } catch (conversationCreateError) {
          sync.persisted = false;
          sync.deferred = true;
          sync.reason = "persistence_deferred";
          logDbFailure(
            "chat.stream.fast.conversation-resolve-or-create",
            userId,
            conversationCreateError instanceof Error ? conversationCreateError : new Error(String(conversationCreateError)),
            { conversationId: fastConversationId },
          );
          fastConversationId = null;
        }

        if (fastUserDb && fastConversationId) {
          try {
            await insertConversationMessageOrThrow(
              fastUserDb,
              userId,
              fastConversationId,
              "user",
              parsed.data.message,
              "chat.stream.fast",
              { clientRequestId: parsed.data.clientRequestId },
            );
            fastUserMessagePersisted = true;
          } catch (messagePersistError) {
            sync.persisted = false;
            sync.deferred = true;
            sync.reason = "persistence_deferred";
            logDbFailure(
              "chat.stream.fast.user-message",
              userId,
              messagePersistError instanceof Error ? messagePersistError : new Error(String(messagePersistError)),
              { conversationId: fastConversationId },
            );
          }
        }

        return {
          sync,
          userDb: fastUserDb,
          activeConversationId: fastConversationId,
          activeConversationTitle: fastConversationTitle,
          createdConversation: fastCreatedConversation,
          userMessagePersisted: fastUserMessagePersisted,
        };
      };

      const persistenceBootstrapPromise = bootstrapFastPersistence();
      persistenceBootstrapPromise.catch((error) => {
        logDbFailure(
          "chat.stream.fast.bootstrap.background",
          userId,
          error instanceof Error ? error : new Error(String(error)),
          { conversationId: requestedConversationId || null },
        );
      });

      const persistFastAssistantMessage = async (content: string): Promise<SyncStatus> => {
        const bootstrap = await persistenceBootstrapPromise;
        const sync = bootstrap.sync;
        let assistantMessagePersisted = false;

        if (!bootstrap.userDb || !bootstrap.activeConversationId) {
          sync.persisted = false;
          sync.deferred = true;
          sync.reason = sync.reason || "persistence_deferred";
          return sync;
        }

        try {
          await insertConversationMessageOrThrow(
            bootstrap.userDb,
            userId,
            bootstrap.activeConversationId,
            "assistant",
            content,
            "chat.stream.fast",
            { clientRequestId: parsed.data.clientRequestId },
          );
          assistantMessagePersisted = true;
        } catch (assistantPersistError) {
          sync.persisted = false;
          sync.deferred = true;
          sync.reason = "persistence_deferred";
          logDbFailure(
            "chat.stream.fast.assistant-message",
            userId,
            assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
            { conversationId: bootstrap.activeConversationId },
          );
        }

        if (
          bootstrap.userDb &&
          bootstrap.activeConversationId &&
          bootstrap.userMessagePersisted &&
          (bootstrap.createdConversation || !bootstrap.activeConversationTitle || bootstrap.activeConversationTitle === "New Chat")
        ) {
          scheduleAutoTitleConversation({
            userDb: bootstrap.userDb,
            userId,
            conversationId: bootstrap.activeConversationId,
            userMessage: parsed.data.message,
            assistantReply: content,
            scope: "chat.stream.fast.title.auto",
            currentTitle: bootstrap.activeConversationTitle,
          });
        }

        logMessagePersistenceGap("chat.stream.fast", userId, {
          conversationId: bootstrap.activeConversationId,
          userMessagePersisted: bootstrap.userMessagePersisted,
          assistantMessagePersisted,
          assistantExpected: Boolean(content),
          deferred: sync.deferred,
          created: bootstrap.createdConversation,
          route: "stream.fast",
          clientDisconnected,
        });

        sync.persisted = Boolean(sync.persisted && bootstrap.userMessagePersisted && (!content || assistantMessagePersisted));
        sync.deferred = sync.deferred || !sync.persisted;
        if (sync.deferred) {
          sync.reason = sync.reason || "persistence_deferred";
        }
        sync.conversationId = bootstrap.activeConversationId || sync.conversationId;
        return sync;
      };

      const cachedTrustedProfile =
        parsed.data.context?.trustedProfile?.displayName
          ? { displayName: parsed.data.context.trustedProfile.displayName }
          : undefined;
      const fastRawContext = {
        recent_messages: normalizedRecentMessages,
        memories: parsed.data.context?.memories,
        trustedProfile: cachedTrustedProfile,
        web_search_mode: effectiveWebSearchMode,
        userMessage: effectiveUserMessage,
        conversationId: requestedConversationId || undefined,
        billingIdentity,
        billingRequestId,
      };
      let fastStreamMetrics: StreamMetrics | null = null;
      let fastCallForRecovery: LLMAdapterCall | null = null;
      let fastModelForRecovery = "unknown";
      let fastReservation: UsageReservation | null = null;

      try {
        fastReservation = await reserveTextBilling({
          identity: billingIdentity,
          requestId: `${billingRequestId}:fast-stream`,
          conversationId: requestedConversationId,
          clientRequestId: parsed.data.clientRequestId,
          route: "stream.fast",
          executionMode: executionProfile.mode,
          complexity: "normal",
        });
        const [fastCtx, routedModel] = await Promise.all([
          buildContextFast(fastRawContext, undefined, userId, { profile: executionProfile }),
          selectModelForCapabilities({
            query: effectiveUserMessage,
            options: { hasImage: false, hasFile: false },
            executionMode: executionProfile.mode,
            userId,
            isGuest,
            signal: requestAbortController.signal,
          }),
        ]);
        const modelOverride = fastReservation.adapterModelOverride;
        fastModelForRecovery = modelOverride;
        const streamMetrics = createStreamMetrics(
          "chat.stream.fast",
          requestStart,
          { model: modelOverride, fastPath: true },
        );
        fastStreamMetrics = streamMetrics;
        const call = buildChatPrompt({
          userMessage: effectiveUserMessage,
          recentMessages: fastCtx.recentMessages,
          memories: fastCtx.memories,
          conversationSummary: fastCtx.conversationSummary,
          conversationCapsule: fastCtx.conversationCapsule,
          workspaceCapsule: fastCtx.workspaceCapsule,
          priorConversationEvidence: fastCtx.priorConversationEvidence,
          isExplicitRecallQuery: fastCtx.isExplicitRecallQuery,
          trustedProfile: fastCtx.trustedProfile,
          modelOverride,
          userId,
          streaming: true,
          reasoningEffort: executionProfile.model.reasoningEffort,
        });
        fastCallForRecovery = call;
        const adapterStream = await callLLMAdapterStream({
          ...call,
          signal: requestAbortController.signal,
        });
        const reader = adapterStream.getReader();
        let fullReply = "";

        try {
          while (true) {
            if (clientDisconnected) break;
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            fullReply += value;
            recordStreamChunk(streamMetrics, value);
            await writeSseJson({ type: "token", text: value });
          }
        } finally {
          if (clientDisconnected) {
            await reader.cancel("client disconnected").catch(() => undefined);
          }
        }

        if (!fullReply.trim() && !clientDisconnected) {
          fullReply = await recoverBufferedStreamText({
            route: "stream.fast",
            model: modelOverride,
            reason: "empty_stream",
            call,
            timeoutMs: modelOverride === "openai-large" ? 180_000 : 90_000,
            signal: requestAbortController.signal,
          });
          await streamBufferedAnswer(fullReply, undefined, false, streamMetrics);
        }

        let streamSync = createDeferredFastSync();
        if (fullReply && !clientDisconnected) {
          await commitTextBilling(fastReservation, "stream.fast");
          streamSync = await persistFastAssistantMessage(fullReply);
        } else if (clientDisconnected) {
          await releaseBillingReservation(fastReservation);
        }

        if (!clientDisconnected) {
          const finalizedSync = finalizeSyncStatus(streamSync);
          await writeSseJson({ type: "sync", sync: finalizedSync, degraded: buildDegradedStatus(finalizedSync) });
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
          console.log(`[FastStream] response completed (+${Date.now() - requestStart}ms)`);
        }
      } catch (err) {
        if (fastStreamMetrics && fastCallForRecovery && fastStreamMetrics.chunkCount === 0 && !clientDisconnected) {
          try {
            const fallbackText = await recoverBufferedStreamText({
              route: "stream.fast",
              model: fastModelForRecovery,
              reason: "stream_error_before_first_token",
              call: fastCallForRecovery,
              timeoutMs: fastModelForRecovery === "openai-large" ? 180_000 : 90_000,
              signal: requestAbortController.signal,
            });
            if (fastReservation) {
              await commitTextBilling(fastReservation, "stream.fast.fallback");
            }
            const streamSync = await persistFastAssistantMessage(fallbackText);
            const finalizedSync = finalizeSyncStatus(streamSync);
            await streamBufferedAnswer(fallbackText, undefined, false, fastStreamMetrics);
            await writeSseJson({ type: "sync", sync: finalizedSync, degraded: buildDegradedStatus(finalizedSync) });
            await writeSseEvent("[DONE]");
            logStreamMetrics(fastStreamMetrics, "fallback");
            return;
          } catch (fallbackErr) {
            console.error(
              `[StreamRecovery] route=stream.fast fallback_failed=${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
            );
            await releaseBillingReservation(fastReservation);
            await sendStreamError(fallbackErr, fastStreamMetrics);
            return;
          }
        }
        if (fastReservation && fastStreamMetrics && fastStreamMetrics.chunkCount > 0) {
          await commitTextBilling(fastReservation, "stream.fast.partial");
        } else {
          await releaseBillingReservation(fastReservation);
        }
        await sendStreamError(err);
      } finally {
        finishSse();
      }
      return;
    }

    const conversationId = requestedConversationId || null;
    let activeConversationId = conversationId;
    const sync = createSyncStatus(activeConversationId || undefined);
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
    if (userDb) {
      try {
        const resolvedConversation = await resolveOrCreateConversationForRequest(
          userDb,
          userId,
          "chat.stream",
          activeConversationId,
          "New Chat",
          { clientRequestId: parsed.data.clientRequestId },
        );
        activeConversationId = resolvedConversation.conversation.id;
        activeConversationTitle = resolvedConversation.conversation.title || null;
        createdConversation = resolvedConversation.created;
      } catch (conversationCreateError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.conversation-resolve-or-create",
          userId,
          conversationCreateError instanceof Error ? conversationCreateError : new Error(String(conversationCreateError)),
          { conversationId: activeConversationId },
        );
        activeConversationId = null;
      }
    }
    sync.conversationId = activeConversationId || undefined;
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

    const persistAssistantMessage = async (content: string, webSurfV2Payload?: WebSurfV2Payload) => {
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
          {
            clientRequestId: parsed.data.clientRequestId,
            messageType: "text",
            previewJson: getWebSurfV2Preview(webSurfV2Payload),
          },
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

    const getStreamSyncPayload = (assistantExpected = true) => {
      const contentPersisted = Boolean(
        sync.persisted
        && userMessagePersisted
        && (!assistantExpected || assistantMessagePersisted),
      );
      return {
        persisted: contentPersisted,
        deferred: sync.deferred || !contentPersisted,
        conversationId: activeConversationId,
        reason: sync.deferred || !contentPersisted ? (sync.reason || "persistence_deferred") : undefined,
        warnings: sync.deferred || !contentPersisted
          ? Array.from(new Set([...(sync.warnings || []), sync.reason || "persistence_deferred"]))
          : [],
      };
    };
    const buildDegradedStatusFromStreamSync = (streamSync: ReturnType<typeof getStreamSyncPayload>) =>
      buildDegradedStatus({
        persisted: streamSync.persisted,
        deferred: streamSync.deferred,
        conversationId: streamSync.conversationId || undefined,
        reason: streamSync.reason,
        warnings: streamSync.warnings || [],
      });

    const persistStoredMemory = async (memory?: {
      id?: string;
      stored?: boolean;
      type?: string;
      summary?: string;
      importance?: number;
      embedding?: readonly number[];
      scope?: MemoryScope;
      chat_id?: string | null;
      persisted?: boolean;
      source_conversation_id?: string | null;
      failure_reason?: string;
      deduplicated?: boolean;
      automatic_idempotency_key?: string;
    }): Promise<boolean> => {
      if (!memory || memory.stored !== true) return true;
      const normalizedScope = memory.automatic_idempotency_key
        ? (memory.scope === "chat" ? "chat" : "global")
        : resolveMemoryScopeForRequest(memory, parsed.data.message);
      if (!userDb) {
        sync.persisted = false;
        sync.deferred = true;
        memory.persisted = false;
        memory.scope = normalizedScope;
        memory.chat_id = normalizedScope === "chat" ? activeConversationId ?? memory.chat_id ?? null : null;
        memory.source_conversation_id = activeConversationId ?? null;
        return false;
      }
      const memoryChatId = normalizedScope === "chat" ? activeConversationId ?? memory.chat_id ?? null : null;
      try {
        const insertInput = { ...memory, scope: normalizedScope, chat_id: memoryChatId };
        const insertedMemory = memory.automatic_idempotency_key
          ? await insertAutomaticMemoryOrThrow(
              userDb,
              userId,
              {
                ...insertInput,
                automatic_idempotency_key: memory.automatic_idempotency_key,
              },
              "chat.stream",
            )
          : await insertMemoryOrThrow(userDb, userId, insertInput, "chat.stream");
        memory.id = insertedMemory.id;
        memory.deduplicated = "deduplicated" in insertedMemory
          ? Boolean((insertedMemory as AutomaticMemoryInsertResult).deduplicated)
          : false;
        memory.scope = (insertedMemory.scope === "chat" ? "chat" : "global");
        memory.chat_id = insertedMemory.chat_id ?? null;
        memory.persisted = true;
        memory.source_conversation_id = activeConversationId ?? null;
        return true;
      } catch (memoryPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        memory.persisted = false;
        memory.scope = normalizedScope;
        memory.chat_id = memoryChatId;
        memory.source_conversation_id = activeConversationId ?? null;
        logDbFailure(
          "chat.stream.memory",
          userId,
          memoryPersistError instanceof Error ? memoryPersistError : new Error(String(memoryPersistError)),
          { conversationId: activeConversationId },
        );
        return false;
      }
    };

    const finalizeMemoryUpdateCopy = (
      result: { route?: string; reply?: string; answer?: string; memory?: { stored?: boolean; persisted?: boolean; scope?: MemoryScope } },
    ) => {
      if (result.route !== "memory_update" || result.memory?.stored !== true) return;
      const reply = result.memory.persisted === true
        ? getMemoryConfirmationText(result.memory.scope === "chat" ? "chat" : "global")
        : MEMORY_PERSISTENCE_FAILURE_TEXT;
      result.reply = reply;
      result.answer = reply;
    };

    const persistAssistantFileMessage = async (
      content: string,
      file: NonNullable<Awaited<ReturnType<typeof routeFileGeneration>>>,
    ) => {
      if (!userDb || !activeConversationId || !file.success) {
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
          {
            clientRequestId: parsed.data.clientRequestId,
            messageType: "file",
            fileUrl: file.file_url,
            storagePath: file.storage_path,
            prompt: parsed.data.message,
            provider: file.model_used,
            fileSizeBytes: file.file_size_bytes,
            fileName: file.file_name,
            fileFormat: file.format,
            mimeType: file.mime_type,
            generatedFileId: file.file_id,
            previewJson: file.preview,
          },
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
          "chat.stream.assistant-file-message",
          userId,
          assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
          { conversationId: activeConversationId },
        );
      }
    };

    const persistAssistantChartMessage = async (
      content: string,
      chart: NonNullable<Awaited<ReturnType<typeof orchestrate>>["chart"]>,
    ) => {
      if (!userDb || !activeConversationId || !chart.success) {
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
          {
            clientRequestId: parsed.data.clientRequestId,
            messageType: "text",
            previewJson: { chart },
          },
        );
        assistantMessagePersisted = true;
      } catch (assistantPersistError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.assistant-chart-message",
          userId,
          assistantPersistError instanceof Error ? assistantPersistError : new Error(String(assistantPersistError)),
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
    const buildStreamStructuredPayload = (payload: Record<string, unknown>) => ({
      ...payload,
      sync: finalizeSyncStatus(sync),
      degraded: buildDegradedStatus(sync),
    });

    if (hasEffectiveWebSearchMode && !webSurfV2Enabled) {
      console.log(
        hasExplicitWebSearchMode
          ? `[Stream] explicit WebSurf mode=${effectiveWebSearchMode} - redirecting to orchestrator`
          : `[Stream] current/live query detected - redirecting to WebSurf`,
      );
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          executionMode: parsed.data.executionMode,
          signal: requestAbortController.signal,
          context: {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: effectiveWebSearchMode,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
            billingIdentity,
            billingRequestId,
          },
        });
        await persistStoredMemory(result.memory);
        finalizeMemoryUpdateCopy(result);
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        reportStreamMessageGap(Boolean(result.reply), "orchestrator.web_search");
        await writeStructuredResponse(buildStreamStructuredPayload({
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
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] explicit WebSurf orchestration failed: ${message}`);
        await sendStreamError(err);
      }
      return;
    }

    // ── Safety gate: math queries use the direct math pipeline via orchestrator ──
    // Math queries use the advanced-reasoning reservation path, which is only
    // available through the orchestrator. Redirect like chart requests.
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
        { model: "advanced_reasoning" },
      );
      const stopHeartbeat = startStreamHeartbeat(10_000, "reasoning");

      try {
        if (isMathReasoningQuery) {
          await writeSseJson({ type: "route", route: "math_reasoning" });
          let mathStreamReply = "";
          const mathReservation = await reserveAdvancedBilling({
            identity: billingIdentity,
            requestId: `${billingRequestId}:math-stream`,
            conversationId: activeConversationId,
            clientRequestId: parsed.data.clientRequestId,
            route: "reasoning.math.stream",
            requiredCapabilities: parsed.data.context?.image_attachments?.length ? ["image_input"] : [],
          });
          let mathReservationCompleted = false;
          try {
          const mathRawContext = {
            recent_messages: normalizedRecentMessages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            image_attachments: parsed.data.context?.image_attachments,
            trustedProfile,
            web_search_mode: effectiveWebSearchMode,
            userMessage: effectiveUserMessage,
            conversationId: activeConversationId || undefined,
            billingIdentity,
            billingRequestId,
          };
          const mathContext = executionProfile.context.compressConversation
            ? await buildContext(mathRawContext, userDb, userId, { profile: executionProfile })
            : await buildContextFast(mathRawContext, userDb, userId, { profile: executionProfile });

          try {
            const mathStream = await streamMathModelRaw({
              userMessage: effectiveUserMessage,
              modelOverride: mathReservation.adapterModelOverride,
              userId,
              recentMessages: mathContext.recentMessages,
              memories: mathContext.memories,
              fileReferences: mathContext.fileReferences,
              imageAttachments: mathContext.imageAttachments,
              conversationSummary: mathContext.conversationSummary,
              conversationCapsule: mathContext.conversationCapsule,
              workspaceCapsule: mathContext.workspaceCapsule,
              priorConversationEvidence: mathContext.priorConversationEvidence,
              isExplicitRecallQuery: mathContext.isExplicitRecallQuery,
              signal: requestAbortController.signal,
            });
            const reader = mathStream.getReader();
            try {
              while (true) {
                if (clientDisconnected) break;
                const { done, value } = await reader.read();
                if (done) break;
                if (!value) continue;
                mathStreamReply += value;
                recordStreamChunk(streamMetrics, value);
                await writeSseJson({ type: "token", text: value });
              }
            } finally {
              if (clientDisconnected) {
                await reader.cancel("client disconnected").catch(() => undefined);
              }
            }
          } catch (streamErr) {
            if (streamMetrics.chunkCount > 0 || clientDisconnected) {
              throw streamErr;
            }
            console.warn(
              `[Stream] signed-in math live stream failed before first token; falling back to buffered math: ${streamErr instanceof Error ? streamErr.message : streamErr}`,
            );
            const fallback = await callMathModelRaw({
              userMessage: effectiveUserMessage,
              modelOverride: mathReservation.adapterModelOverride,
              userId,
              recentMessages: mathContext.recentMessages,
              memories: mathContext.memories,
              fileReferences: mathContext.fileReferences,
              imageAttachments: mathContext.imageAttachments,
              conversationSummary: mathContext.conversationSummary,
              conversationCapsule: mathContext.conversationCapsule,
              workspaceCapsule: mathContext.workspaceCapsule,
              priorConversationEvidence: mathContext.priorConversationEvidence,
              isExplicitRecallQuery: mathContext.isExplicitRecallQuery,
            });
            mathStreamReply = fallback.answer;
            await streamBufferedAnswer(fallback.answer, undefined, false, streamMetrics);
          }

          if (!mathStreamReply.trim() && !clientDisconnected) {
            console.warn(`[StreamRecovery] route=reasoning.math.stream model=${mathReservation.adapterModelOverride} reason=empty_stream attempt=buffered_math`);
            const fallback = await callMathModelRaw({
              userMessage: effectiveUserMessage,
              modelOverride: mathReservation.adapterModelOverride,
              userId,
              recentMessages: mathContext.recentMessages,
              memories: mathContext.memories,
              fileReferences: mathContext.fileReferences,
              imageAttachments: mathContext.imageAttachments,
              conversationSummary: mathContext.conversationSummary,
              conversationCapsule: mathContext.conversationCapsule,
              workspaceCapsule: mathContext.workspaceCapsule,
              priorConversationEvidence: mathContext.priorConversationEvidence,
              isExplicitRecallQuery: mathContext.isExplicitRecallQuery,
            });
            mathStreamReply = assertUsableAssistantText(fallback.answer, {
              route: "reasoning.math.stream",
              model: mathReservation.adapterModelOverride,
              reason: "empty_stream",
            });
            await streamBufferedAnswer(mathStreamReply, undefined, false, streamMetrics);
          }

          if (mathStreamReply && !clientDisconnected) {
            await commitTextBilling(mathReservation, "reasoning.math.stream");
            mathReservationCompleted = true;
            await persistAssistantMessage(mathStreamReply);
          } else if (clientDisconnected) {
            await releaseBillingReservation(mathReservation);
            mathReservationCompleted = true;
          }
          reportStreamMessageGap(Boolean(mathStreamReply), "reasoning.math.stream");
          if (!clientDisconnected) {
            await writeSseEvent("[DONE]");
            logStreamMetrics(streamMetrics, "complete");
          }
          } catch (error) {
            if (!mathReservationCompleted) {
              await releaseBillingReservation(mathReservation);
            }
            throw error;
          }
          return;
        }

        const reasoningRawContext = {
          recent_messages: normalizedRecentMessages,
          memories: parsed.data.context?.memories,
          file_references: parsed.data.context?.file_references,
          image_attachments: parsed.data.context?.image_attachments,
          trustedProfile,
          web_search_mode: effectiveWebSearchMode,
          userMessage: effectiveUserMessage,
          conversationId: activeConversationId || undefined,
          billingIdentity,
          billingRequestId,
        };
        const reasoningContext = executionProfile.context.compressConversation
          ? await buildContext(reasoningRawContext, userDb, userId, { profile: executionProfile })
          : await buildContextFast(reasoningRawContext, userDb, userId, { profile: executionProfile });

        const reasoningReservation = await reserveAdvancedBilling({
          identity: billingIdentity,
          requestId: `${billingRequestId}:reasoning-stream`,
          conversationId: activeConversationId,
          clientRequestId: parsed.data.clientRequestId,
          route: "reasoning.stream",
          requiredCapabilities: reasoningContext.imageAttachments.length ? ["image_input"] : [],
        });
        let reasoningReservationCompleted = false;
        let result: Awaited<ReturnType<typeof handleChat>>;
        try {
        result = await handleChat({
          userMessage: effectiveUserMessage,
          recentMessages: reasoningContext.recentMessages,
          memories: reasoningContext.memories,
          fileReferences: reasoningContext.fileReferences,
          imageAttachments: reasoningContext.imageAttachments,
          conversationSummary: reasoningContext.conversationSummary,
          conversationCapsule: reasoningContext.conversationCapsule,
          workspaceCapsule: reasoningContext.workspaceCapsule,
          priorConversationEvidence: reasoningContext.priorConversationEvidence,
          isExplicitRecallQuery: reasoningContext.isExplicitRecallQuery,
          trustedProfile: reasoningContext.trustedProfile,
          modelOverride: reasoningReservation.adapterModelOverride,
          userId,
          reasoningMode: true,
          reasoningEffort: executionProfile.model.reasoningEffort,
          signal: requestAbortController.signal,
          requiredCapabilities: reasoningContext.imageAttachments.length ? ["image_input"] : [],
        });
        let reply = result.reply;
        const unavailableReason = getUnavailableReplyReason(reply);
        if (unavailableReason) {
          reply = await recoverBufferedReplyText({
            route: "reasoning",
            model: "default",
            reason: unavailableReason,
            invoke: async () => (await handleChat({
              userMessage: effectiveUserMessage,
              recentMessages: reasoningContext.recentMessages,
              memories: reasoningContext.memories,
              fileReferences: reasoningContext.fileReferences,
              imageAttachments: reasoningContext.imageAttachments,
              conversationSummary: reasoningContext.conversationSummary,
              conversationCapsule: reasoningContext.conversationCapsule,
              workspaceCapsule: reasoningContext.workspaceCapsule,
              priorConversationEvidence: reasoningContext.priorConversationEvidence,
              isExplicitRecallQuery: reasoningContext.isExplicitRecallQuery,
              trustedProfile: reasoningContext.trustedProfile,
              modelOverride: reasoningReservation.adapterModelOverride,
              userId,
              reasoningMode: true,
              reasoningEffort: executionProfile.model.reasoningEffort,
              signal: requestAbortController.signal,
            })).reply,
          });
        }
        if (reply) {
          await commitTextBilling(reasoningReservation, "reasoning.stream");
          reasoningReservationCompleted = true;
          await persistAssistantMessage(reply);
        } else if (clientDisconnected) {
          await releaseBillingReservation(reasoningReservation);
          reasoningReservationCompleted = true;
        }
        reportStreamMessageGap(Boolean(reply), "reasoning");
        if (!clientDisconnected && reply) {
          const thinking = unavailableReason ? undefined : gateThinking(result.thinking, { isReasoning: true });
          await streamBufferedAnswer(reply, thinking, !unavailableReason, streamMetrics);
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "complete");
          return;
        }
        } catch (error) {
          if (!reasoningReservationCompleted) {
            await releaseBillingReservation(reasoningReservation);
          }
          throw error;
        }
        if (!reasoningReservationCompleted) {
          await releaseBillingReservation(reasoningReservation);
          reasoningReservationCompleted = true;
        }
        throw new Error(STREAM_RECOVERY_USER_ERROR);
      } catch (err) {
        await sendStreamError(err, streamMetrics);
      } finally {
        stopHeartbeat();
        finishSse();
      }
      return;
    }

    const requestStart = Date.now();
    console.log(`[Latency] user query received`);

    let webSurfV2: Awaited<ReturnType<typeof prepareWebSurfV2>> | undefined;
    let webSurfCitationStream: WebSurfCitationStream | undefined;
    let webSurfOutputGuard: WebSurfOutputGuardStream | undefined;
    if (webSurfV2Enabled && hasEffectiveWebSearchMode) {
      try {
        webSurfV2 = await prepareWebSurfV2(
          effectiveUserMessage,
          hasExplicitWebSearchMode ? "manual" : "auto",
          {},
          requestAbortController.signal,
        );
        webSurfCitationStream = new WebSurfCitationStream(new Set(webSurfV2.synthesisSourceIds), {
          preserveSourceMarkers: webSurfV2.payload.presentationVersion === 1,
        });
        if (webSurfV2.answerIntelligence) {
          webSurfOutputGuard = new WebSurfOutputGuardStream(new Set(webSurfV2.synthesisSourceIds));
        }
      } catch (error) {
        const errorClass = error instanceof Error && /^[A-Za-z0-9_-]{1,64}$/.test(error.name)
          ? error.name
          : "Error";
        console.warn(`[WebSurfV2] stage=signed_stream_preparation_failed error_class=${errorClass}`);
        const retrievalError = new Error("Web search is temporarily unavailable. Please try again later.");
        (retrievalError as Error & { code?: string }).code = "websurf_retrieval_failed";
        await sendStreamError(retrievalError);
        return;
      }
    }

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
      effectiveUserMessage.length <= 280 &&
      recentMessageCount <= 6;

    // Extract file names and content for coding PDF detection
    const fileNames = hasFile ? fileRefs.map((f: { filename?: string }) => f.filename || "") : undefined;
    const fileContent = hasFile ? fileRefs.map((f: { extractedText?: string }) => f.extractedText || "").join("\n") : undefined;

    const routedModel = await selectModelForCapabilities({
      query: effectiveUserMessage,
      options: {
        hasImage,
        hasFile,
        fileNames,
        fileContent,
      },
      executionMode: executionProfile.mode,
      userId,
      isGuest,
      signal: requestAbortController.signal,
    });
    const requestedAutomaticTools = webSurfV2 ? [] : getEnabledAutomaticSentIQTools();
    const billingRequiredCapabilities = deriveRequiredModelCapabilities({
      hasImageInput: hasImage,
      automaticToolsRequested: requestedAutomaticTools.length > 0,
      streaming: false,
    });
    const directReservation = await reserveTextBilling({
      identity: billingIdentity,
      requestId: `${billingRequestId}:direct-stream`,
      conversationId: activeConversationId,
      clientRequestId: parsed.data.clientRequestId,
      route: "stream",
      executionMode: executionProfile.mode,
      complexity: hasFile ? "heavy" : "normal",
      requiredCapabilities: billingRequiredCapabilities,
    });
    const modelOverride = directReservation.adapterModelOverride;
    if (routedModel.fallback_reason) {
      console.log(`[ModelSelector] stream capability=${routedModel.fallback_reason}`);
    }

    const fastPathEligible =
      !hasFile &&
      !hasImage &&
      lowComplexity &&
      !isBufferedReasoning;

    console.log(
      `[FastPath] eligible=${fastPathEligible} lowComplexity=${lowComplexity} ` +
      `msgLen=${parsed.data.message.length} recentMsgs=${recentMessageCount} hasFile=${hasFile}`,
    );

    // ── FAST context build (NO LLM calls, minimal latency) ──
    // Use buildContextFast which skips conversation compression for speed.
    // This gets the model started ASAP while still providing recent context.
    const directRawContext = {
      recent_messages: normalizedRecentMessages,
      memories: parsed.data.context?.memories,
      file_references: fileRefs,
      image_attachments: parsed.data.context?.image_attachments,
      trustedProfile,
      web_search_mode: effectiveWebSearchMode,
      userMessage: effectiveUserMessage,
      conversationId: activeConversationId || undefined,
      billingIdentity,
      billingRequestId,
      clientRequestId: parsed.data.clientRequestId,
      imageQuotaKey: getImageQuotaKey(req),
    };
    const ctx = executionProfile.context.compressConversation
      ? await buildContext(directRawContext, userDb, userId, { profile: executionProfile })
      : await buildContextFast(directRawContext, userDb, userId, { profile: executionProfile });

    console.log(`[Latency] context built (+${Date.now() - requestStart}ms)`);

    console.log(`[Latency] buffered response request started (+${Date.now() - requestStart}ms)`);
    console.log(`[Stream] model=${modelOverride} hasFiles=${ctx.hasFileContext} msgLen=${parsed.data.message.length}`);
    const streamMetrics = createStreamMetrics(
      "chat.stream.general",
      requestStart,
      { model: modelOverride, fastPath: fastPathEligible },
    );

    let call: LLMAdapterCall;
    try {
      call = buildChatPrompt({
        userMessage: effectiveUserMessage,
        recentMessages: ctx.recentMessages,
        memories: ctx.memories,
        fileReferences: ctx.fileReferences,
        imageAttachments: ctx.imageAttachments,
        conversationSummary: ctx.conversationSummary,
        conversationCapsule: ctx.conversationCapsule,
        workspaceCapsule: ctx.workspaceCapsule,
        priorConversationEvidence: ctx.priorConversationEvidence,
        routeEvidence: webSurfV2?.routeEvidence,
        isExplicitRecallQuery: ctx.isExplicitRecallQuery,
        trustedProfile: ctx.trustedProfile,
        modelOverride,
        userId,
        streaming: true,
        reasoningEffort: executionProfile.model.reasoningEffort,
        webSurfSourceIds: webSurfV2?.synthesisSourceIds,
        webSurfAnswerPlan: webSurfV2?.answerIntelligence?.plan,
        webSurfAnswerSources: webSurfV2?.answerIntelligence?.sources,
      });
    } catch (error) {
      await releaseBillingReservation(directReservation);
      throw error;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    if (webSurfV2) {
      await writeSseJson({ type: "route", route: "web_search", v2: true });
      await writeSseJson({ type: "websurf_sources", web_search: webSurfV2.payload });
    }

    let stopHeartbeat = () => {};
    let automaticToolAccepted = false;
    let automaticToolReservationCompleted = false;
    const modelTurnProgress = new ModelTurnProgressTracker();

    let intuitiveFutureProtected = false;
    try {
      const streamStart = Date.now();
      const streamTimeoutMs = modelOverride === "openai-large" ? 240_000 : undefined;
      const streamCall = {
        ...call,
        ...(streamTimeoutMs ? { timeout_ms: streamTimeoutMs } : {}),
        signal: requestAbortController.signal,
      };
      stopHeartbeat = modelOverride === "openai-large"
        ? startStreamHeartbeat(10_000, "openai-large")
        : () => {};
      const automaticTools = requestedAutomaticTools.length > 0
        ? getAutomaticSentIQToolsForRoute(directReservation, true)
        : [];
      const intuitiveLaneActive = isNemotronIntuitiveLaneEnabled(executionProfile.mode) && !hasImage;
      if (requestedAutomaticTools.length > 0 && automaticTools.length === 0) {
        throw new ModelCapabilityUnavailableError(billingRequiredCapabilities);
      }
      const toolTransport = automaticTools.length > 0
        ? resolveModelToolTransport(directReservation, "streaming")
        : null;
      const invocationRequiredCapabilities = deriveRequiredModelCapabilities({
        hasImageInput: hasImage,
        automaticToolsRequested: automaticTools.length > 0,
        toolTransportMode: toolTransport?.mode === "streaming" ? "streaming" : "buffered",
      });
      const intuitiveToolSelectionActive = intuitiveLaneActive && automaticTools.length > 0;
      if (intuitiveToolSelectionActive) {
        protectIntuitiveFinalSynthesis({
          userMessage: effectiveUserMessage,
          complexity: hasFile ? "heavy" : "normal",
          knownContext: [
            ctx.conversationSummary,
            ctx.conversationCapsule,
            ctx.workspaceCapsule,
            ...(ctx.recentMessages ?? []).map((message) => message.content),
            ...(ctx.memories ?? []).map((memory) => memory.summary),
            ...(ctx.fileReferences ?? []).map((file) => file.extractedText.slice(0, 200_000)),
          ].filter((value): value is string => Boolean(value)),
          messageCount: (ctx.recentMessages?.length ?? 0) + 1,
        });
        intuitiveFutureProtected = true;
      }
      const initialTurnCall: LLMAdapterCall = {
        ...streamCall,
        ...(intuitiveToolSelectionActive
          ? {
              prompt: buildIntuitiveToolSelectionPrompt(effectiveUserMessage, automaticTools),
              max_output_tokens: 200,
              execution_mode: "fast" as const,
              reasoning_effort: "low" as const,
              safety_mode: "low_risk_text" as const,
              budget_class: "auxiliary" as const,
              auxiliary_budget: "routing" as const,
              skip_wrappers: true,
            }
          : { execution_mode: executionProfile.mode }),
        sentiq_tool_context: automaticTools.length > 0 ? {
          authenticated: !isGuest,
          executionMode: executionProfile.mode,
        } : undefined,
        sentiq_allowed_tool_names: automaticTools,
        required_capabilities: invocationRequiredCapabilities,
        tool_transport_mode: toolTransport?.mode ?? "none",
      };
      const adapterStream = await callLLMAdapterTurnStream(initialTurnCall);
      let fullReply = "";

      let turn = await consumeModelTurnStream(adapterStream, async (value) => {
          if (intuitiveToolSelectionActive) return;
          const safeValue = webSurfOutputGuard ? webSurfOutputGuard.push(value) : value;
          fullReply += safeValue;
          const visible = webSurfCitationStream ? webSurfCitationStream.push(safeValue) : safeValue;
          if (visible) {
            recordStreamChunk(streamMetrics, visible);
            await writeSseJson({ type: "token", text: visible });
          }
      }, (progress) => {
        if (!intuitiveToolSelectionActive) modelTurnProgress.advance(progress);
      }, {
        validateAssistantText: assertNoUnbackedToolCompletionClaim,
      });
      if (intuitiveToolSelectionActive && turn.kind === "assistant_text") {
        const finalRequiredCapabilities = deriveRequiredModelCapabilities({
          hasImageInput: false,
          automaticToolsRequested: false,
          streaming: true,
        });
        const finalStream = await callLLMAdapterTurnStream({
          ...streamCall,
          execution_mode: "intuitive",
          sentiq_tool_context: undefined,
          sentiq_allowed_tool_names: [],
          required_capabilities: finalRequiredCapabilities,
          tool_transport_mode: "none",
          consume_future_obligation_id: INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID,
        });
        intuitiveFutureProtected = false;
        turn = await consumeModelTurnStream(finalStream, async (value) => {
          const safeValue = webSurfOutputGuard ? webSurfOutputGuard.push(value) : value;
          fullReply += safeValue;
          const visible = webSurfCitationStream ? webSurfCitationStream.push(safeValue) : safeValue;
          if (visible) {
            recordStreamChunk(streamMetrics, visible);
            await writeSseJson({ type: "token", text: visible });
          }
        }, (progress) => modelTurnProgress.advance(progress), {
          validateAssistantText: assertNoUnbackedToolCompletionClaim,
        });
      }
      if (turn.kind === "tool_calls") {
        automaticToolAccepted = true;
        modelTurnProgress.advance("execution_started");
        if (!intuitiveLaneActive) {
          await commitTextBilling(directReservation, "stream.tool-selected");
          automaticToolReservationCompleted = true;
        }
        let toolResult = await executeAutomaticModelToolCalls(
          turn.calls,
          effectiveUserMessage,
          ctx,
          executionProfile,
          requestAbortController.signal,
          async (event) => writeSseJson(event),
          async (token) => writeSseJson({ type: "file_token", format: "html", text: token }),
        );
        if (intuitiveLaneActive) {
          toolResult = await synthesizeIntuitiveToolResult(
            toolResult,
            effectiveUserMessage,
            ctx,
            executionProfile,
            modelOverride,
            requestAbortController.signal,
          );
          intuitiveFutureProtected = false;
          await commitTextBilling(directReservation, "stream.tool-final-synthesis");
          automaticToolReservationCompleted = true;
        }
        if (toolResult.reply && toolResult.web_search?.v2) {
          await streamBufferedAnswer(toolResult.reply, undefined, false, streamMetrics);
          await persistAssistantMessage(toolResult.reply, toolResult.web_search.v2);
          await writeSseJson({ type: "websurf_sources", web_search: toolResult.web_search.v2 });
          await writeSseJson({ type: "websurf_complete", answer: toolResult.reply, web_search: toolResult.web_search.v2 });
        } else if (toolResult.image) {
          if (toolResult.image.persisted) assistantMessagePersisted = true;
          await writeSseJson({
            type: "structured_response",
            response: { route: "image_generation", image: toolResult.image, reply: toolResult.reply },
          });
        } else if (toolResult.chart?.success) {
          await persistAssistantChartMessage(toolResult.reply ?? "Generated chart.", toolResult.chart as any);
          await writeSseJson({
            type: "structured_response",
            response: { route: "chart_generation", chart: toolResult.chart, reply: toolResult.reply },
          });
        } else if (toolResult.file?.success) {
          await persistAssistantFileMessage(toolResult.reply ?? `Generated ${toolResult.file.file_name}.`, toolResult.file as any);
          await writeSseJson({
            type: "structured_response",
            response: { route: "file_generation", file: toolResult.file, reply: toolResult.reply },
          });
        } else if (toolResult.memory) {
          await persistStoredMemory(toolResult.memory);
          const memoryReply = toolResult.final_synthesis_completed && toolResult.reply
            ? toolResult.reply
            : toolResult.memory.stored && toolResult.memory.persisted
              ? getMemoryConfirmationText(toolResult.memory.scope === "chat" ? "chat" : "global")
              : (toolResult.reply || MEMORY_PERSISTENCE_FAILURE_TEXT);
          await persistAssistantMessage(memoryReply);
          await writeSseJson({
            type: "structured_response",
            response: { route: "memory_update", memory: toolResult.memory, reply: memoryReply, answer: memoryReply },
          });
        } else if (toolResult.reply) {
          await streamBufferedAnswer(toolResult.reply, undefined, false, streamMetrics);
          await persistAssistantMessage(toolResult.reply);
        }
        const streamSync = getStreamSyncPayload(Boolean(
          toolResult.reply || toolResult.image || toolResult.chart || toolResult.file || toolResult.memory,
        ));
        await writeSseJson({ type: "sync", sync: streamSync, degraded: buildDegradedStatusFromStreamSync(streamSync) });
        await writeSseEvent("[DONE]");
        logStreamMetrics(streamMetrics, toolResult.error ? "error" : "complete");
        return;
      }

      stopHeartbeat();

      const outputGuardTail = webSurfOutputGuard?.flush();
      if (outputGuardTail) {
        fullReply += outputGuardTail;
        const visible = webSurfCitationStream ? webSurfCitationStream.push(outputGuardTail) : outputGuardTail;
        if (visible) {
          recordStreamChunk(streamMetrics, visible);
          await writeSseJson({ type: "token", text: visible });
        }
      }

      if (!fullReply.trim() && !clientDisconnected) {
        const recoveredText = await recoverBufferedStreamText({
          route: "stream",
          model: modelOverride,
          reason: "empty_stream",
          call,
          timeoutMs: modelOverride === "openai-large" ? 180_000 : 90_000,
          signal: requestAbortController.signal,
        });
        fullReply = webSurfOutputGuard
          ? `${webSurfOutputGuard.push(recoveredText)}${webSurfOutputGuard.flush()}`
          : recoveredText;
        const visible = webSurfCitationStream
          ? `${webSurfCitationStream.push(fullReply)}${webSurfCitationStream.flush()}`
          : fullReply;
        await streamBufferedAnswer(visible, undefined, false, streamMetrics);
      }

      if (fullReply && !clientDisconnected) {
        logWebSurfAnswerOutput({
          profile: webSurfV2?.answerIntelligence?.plan.profile,
          answer: fullReply,
          outputGuardRemovedInternalArtefact: webSurfOutputGuard?.removedInternalArtefact ?? false,
        });
        await commitTextBilling(directReservation, "stream");
        await persistAssistantMessage(fullReply, webSurfV2?.payload);
      } else if (clientDisconnected) {
        await releaseBillingReservation(directReservation);
      }
      if (!clientDisconnected) {
        const citationTail = webSurfCitationStream?.flush();
        if (citationTail) {
          recordStreamChunk(streamMetrics, citationTail);
          await writeSseJson({ type: "token", text: citationTail });
        }
        if (webSurfV2) {
          await writeSseJson({
            type: "websurf_complete",
            answer: fullReply,
            web_search: webSurfV2.payload,
          });
        }
        reportStreamMessageGap(Boolean(fullReply), "stream");
        const streamSync = getStreamSyncPayload(Boolean(fullReply));
        await writeSseJson({ type: "sync", sync: streamSync, degraded: buildDegradedStatusFromStreamSync(streamSync) });
        await writeSseEvent("[DONE]");
        logStreamMetrics(streamMetrics, "complete");
        console.log(`[Latency] response completed (+${Date.now() - requestStart}ms)`);
      }
      console.log(`[Stream] live stream completed in ${Date.now() - streamStart}ms`);
    } catch (err) {
      if (intuitiveFutureProtected) {
        releaseIntuitiveFinalSynthesisProtection();
        intuitiveFutureProtected = false;
      }
      if (automaticToolAccepted) {
        if (!automaticToolReservationCompleted) {
          await releaseBillingReservation(directReservation);
        }
        await sendStreamError(err, streamMetrics);
        return;
      }
      if (
        modelTurnProgress.canRecover()
        && streamMetrics.chunkCount === 0
        && !clientDisconnected
        && (
          !err
          || typeof err !== "object"
          || ![
            "model_tool_capability_unavailable",
            "generation_budget_insufficient",
            "token_reservation_exhausted",
          ].includes((err as { code?: string }).code ?? "")
        )
      ) {
        try {
          const fallbackText = await recoverBufferedStreamText({
            route: "stream",
            model: modelOverride,
            reason: "stream_error_before_first_token",
            call,
            timeoutMs: modelOverride === "openai-large" ? 180_000 : 90_000,
            signal: requestAbortController.signal,
          });
          const safeFallbackText = webSurfOutputGuard
            ? `${webSurfOutputGuard.push(fallbackText)}${webSurfOutputGuard.flush()}`
            : fallbackText;
          await commitTextBilling(directReservation, "stream.fallback");
          await persistAssistantMessage(safeFallbackText, webSurfV2?.payload);
          reportStreamMessageGap(Boolean(safeFallbackText), "stream.fallback");
          const visible = webSurfCitationStream
            ? `${webSurfCitationStream.push(safeFallbackText)}${webSurfCitationStream.flush()}`
            : safeFallbackText;
          await streamBufferedAnswer(visible, undefined, false, streamMetrics);
          logWebSurfAnswerOutput({
            profile: webSurfV2?.answerIntelligence?.plan.profile,
            answer: safeFallbackText,
            outputGuardRemovedInternalArtefact: webSurfOutputGuard?.removedInternalArtefact ?? false,
          });
          if (webSurfV2) {
            await writeSseJson({
              type: "websurf_complete",
              answer: safeFallbackText,
              web_search: webSurfV2.payload,
            });
          }
          const streamSync = getStreamSyncPayload(Boolean(fallbackText));
          await writeSseJson({ type: "sync", sync: streamSync, degraded: buildDegradedStatusFromStreamSync(streamSync) });
          await writeSseEvent("[DONE]");
          logStreamMetrics(streamMetrics, "fallback");
          finishSse();
          return;
        } catch (fallbackErr) {
          console.error(
            `[StreamRecovery] route=stream fallback_failed=${fallbackErr instanceof Error ? fallbackErr.message : fallbackErr}`,
          );
          await releaseBillingReservation(directReservation);
          await sendStreamError(fallbackErr, streamMetrics);
          return;
        }
      }
      let streamError = err;
      const settlementAlreadyUnavailable = err instanceof BillingQuotaError
        && err.code === "unified_text_quota_unavailable";
      if (streamMetrics.chunkCount > 0 && !settlementAlreadyUnavailable) {
        try {
          await commitTextBilling(directReservation, "stream.partial");
        } catch (settlementErr) {
          streamError = settlementErr;
        }
      } else if (streamMetrics.chunkCount === 0) {
        await releaseBillingReservation(directReservation);
      }
      await sendStreamError(streamError, streamMetrics);
    } finally {
      if (intuitiveFutureProtected) releaseIntuitiveFinalSynthesisProtection();
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
    registerFileAnalysisSubscriber(userId, subscriberId, writer);

    req.on("close", () => {
      unregisterFileAnalysisSubscriber(userId, subscriberId);
      writer.close();
    });
  }),
);

// ===============================
// POST /api/files/upload — Upload & extract file
// ===============================
app.post(
  "/api/files/upload",
  verifyJWT({ allowGuest: true }),
  uploadRateLimiter,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    if (!isGuest) {
      await ensureNamedWorkspaceProfile(userId, "files.upload");
    }
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

    emitFileAnalysisEvent(isGuest ? undefined : userId, {
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
        userId: isGuest ? undefined : userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const publicMessage = "File analysis could not finish. Please try again.";
      console.error(`[File Upload] analysis failed analysisId=${analysisId}: ${message}`);
      emitFileAnalysisEvent(isGuest ? undefined : userId, {
        ...baseEvent,
        event: "error",
        status: "error",
        error: publicMessage,
        updated_at: Date.now(),
      });
      res.status(500).json({
        error: publicMessage,
        code: "file_analysis_failed",
        analysis_id: analysisId,
        analysis_status: "error",
        update_protocol: "sse",
        update_endpoint: "/api/files/updates",
      });
      return;
    }

    let persistedSource: Awaited<ReturnType<typeof sourceRetrievalService.persistUploadedSource>> | undefined;
    if (!isGuest && (result.type === "pdf" || result.type === "txt")) {
      try {
        const userDb = await resolveUserDatabaseOrThrow(userId, "files.upload.source");
        const requestedConversationId = typeof req.body?.conversationId === "string"
          ? req.body.conversationId.trim()
          : typeof req.body?.conversation_id === "string"
            ? req.body.conversation_id.trim()
            : "";
        persistedSource = await sourceRetrievalService.persistUploadedSource({
          userDb,
          ownerUserId: userId,
          conversationId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedConversationId)
            ? requestedConversationId
            : undefined,
          filename: result.filename,
          mimeType: file.mimetype || "application/octet-stream",
          extractionType: result.type,
          extractedText: result.extracted_text,
          sizeBytes: result.size_bytes,
          analysisId,
        });
      } catch (error) {
        console.warn(JSON.stringify({
          scope: "source_retrieval",
          event: "document_skipped",
          reason: "upload_persistence_failed",
          error_type: error instanceof Error ? error.name : "unknown",
        }));
      }
    }

    emitFileAnalysisEvent(isGuest ? undefined : userId, {
      ...baseEvent,
      event: "update",
      status: "complete",
      updated_at: Date.now(),
    });

    console.log(`[File Upload] ${result.filename} → type=${result.type}, extracted=${result.extracted_text.length} chars, size=${result.size_bytes}B`);
    if (result.type === "pdf") {
      const createdChunks = persistedSource
        ? persistedSource.parentChunksCreated + persistedSource.childChunksCreated
        : 0;
      console.log(`[PDF] persisted source chunks: ${createdChunks}, extracted chars: ${result.extracted_text.length}`);
    }

    // Update file session for this user or IP-scoped guest.
    const fileSessionKey = getFileSessionKey(req, userId, isGuest);
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
      document_id: persistedSource?.document?.id,
      source_document_id: persistedSource?.document?.id,
      source_chunks_created: persistedSource
        ? persistedSource.parentChunksCreated + persistedSource.childChunksCreated
        : undefined,
    });
  }),
);

// ===============================
// DELETE /api/files/session - Clear temporary uploaded source context
// ===============================
app.delete(
  "/api/files/session",
  verifyJWT({ allowGuest: true }),
  asyncHandler(async (req, res) => {
    const { userId, isGuest } = await getRequestIdentity(req);
    const sessionKey = getFileSessionKey(req, userId, isGuest);
    const requestedAnalysisId = typeof req.body?.analysis_id === "string" ? req.body.analysis_id.trim() : "";
    const session = fileSessionMap.get(sessionKey);
    const shouldClear = Boolean(session) && (!requestedAnalysisId || session?.analysisId === requestedAnalysisId);
    if (shouldClear) fileSessionMap.delete(sessionKey);
    res.json({ success: true, cleared: shouldClear });
  }),
);

// ===============================
// Generated file metadata and access routes
// ===============================
type GeneratedFileRow = {
  id: string;
  user_id: string;
  chat_id: string;
  format: GeneratedFileFormat;
  file_name: string;
  mime_type: string;
  file_url: string | null;
  storage_path: string | null;
  storage_bucket?: string | null;
  file_size_bytes?: number | null;
  preview_json?: GeneratedFilePreview | null;
  version?: number | null;
  content_sha256?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function clampGeneratedPreviewText(text: string, maxChars = 2400): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}...` : normalized;
}

function serializeGeneratedFileRow(row: GeneratedFileRow) {
  return {
    type: "file" as const,
    success: true,
    file_id: row.id,
    id: row.id,
    format: row.format,
    file_name: row.file_name,
    mime_type: row.mime_type,
    file_url: row.file_url || buildGeneratedFileApiUrl(row.id),
    storage_path: row.storage_path || undefined,
    storage_bucket: row.storage_bucket || undefined,
    file_size_bytes: row.file_size_bytes ?? undefined,
    preview: row.preview_json || undefined,
    html: row.format === "html" ? row.preview_json?.html : undefined,
    text: row.preview_json?.text,
    content_sha256: row.content_sha256 || undefined,
    version: row.version || 1,
    created_at: row.created_at || undefined,
    updated_at: row.updated_at || undefined,
  };
}

async function getGeneratedFileRowOrThrow(
  userDb: any,
  userId: string,
  fileId: string,
  scope: string,
): Promise<GeneratedFileRow> {
  const { data, error } = await userDb
    .from("generated_files")
    .select("id,user_id,chat_id,format,file_name,mime_type,file_url,storage_path,storage_bucket,file_size_bytes,preview_json,version,content_sha256,created_at,updated_at")
    .eq("id", fileId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    logDbFailure(`${scope}.generated-file.lookup`, userId, error, { fileId });
    throw new Error(error.message);
  }
  if (!data) {
    throw new HttpError(404, "Generated file not found.", { code: "generated_file_not_found" });
  }
  return data as GeneratedFileRow;
}

async function createGeneratedFileSignedUrl(row: GeneratedFileRow, mode: "download" | "preview") {
  const storageBucket = row.storage_bucket || getStorageBucketName();
  if (row.storage_path) {
    const options = mode === "download" ? { download: row.file_name } : undefined;
    const { data, error } = await getGeneratedFileStorageDatabase().storage
      .from(storageBucket)
      .createSignedUrl(row.storage_path, 120, options as any);

    if (!error && data?.signedUrl) {
      return {
        url: data.signedUrl,
        expires_in: 120,
        legacy: false,
      };
    }
    console.warn(`[GeneratedFiles] signed URL failed fileId=${row.id}: ${error?.message || "unknown error"}`);
  }

  if (row.file_url && /^https?:\/\//i.test(row.file_url)) {
    return {
      url: row.file_url,
      expires_in: null,
      legacy: true,
    };
  }

  throw new HttpError(404, "Generated file content is unavailable.", { code: "generated_file_unavailable" });
}

app.get(
  "/api/generated-files/:id/download",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const fileId = getRequiredUuid(req.params.id, "Generated file id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "generated-files.download");
    await initializeUserSessionOrThrow(userDb, userId, "generated-files.download");
    const row = await getGeneratedFileRowOrThrow(userDb, userId, fileId, "generated-files.download");
    const signed = await createGeneratedFileSignedUrl(row, "download");
    res.json({
      success: true,
      file_id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size_bytes: row.file_size_bytes ?? null,
      version: row.version || 1,
      content_sha256: row.content_sha256 || null,
      updated_at: row.updated_at || null,
      ...signed,
    });
  }),
);

app.get(
  "/api/generated-files/:id/preview-url",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const fileId = getRequiredUuid(req.params.id, "Generated file id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "generated-files.preview");
    await initializeUserSessionOrThrow(userDb, userId, "generated-files.preview");
    const row = await getGeneratedFileRowOrThrow(userDb, userId, fileId, "generated-files.preview");
    const signed = await createGeneratedFileSignedUrl(row, "preview");
    res.json({
      success: true,
      file_id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size_bytes: row.file_size_bytes ?? null,
      version: row.version || 1,
      content_sha256: row.content_sha256 || null,
      updated_at: row.updated_at || null,
      ...signed,
    });
  }),
);

app.patch(
  "/api/generated-files/:id",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const fileId = getRequiredUuid(req.params.id, "Generated file id");
    const parsed = GeneratedFileUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "generated-files.update");
    await initializeUserSessionOrThrow(userDb, userId, "generated-files.update");
    const row = await getGeneratedFileRowOrThrow(userDb, userId, fileId, "generated-files.update");
    if (row.format !== "html") {
      throw new HttpError(400, "Only generated HTML files can be edited.", { code: "unsupported_generated_file_edit" });
    }
    if (parsed.data.version && row.version && parsed.data.version !== row.version) {
      res.status(409).json({
        error: "This generated file changed in another session. Reload and try again.",
        code: "generated_file_version_conflict",
        file: serializeGeneratedFileRow(row),
      });
      return;
    }

    const html = ensureHtmlDocument(parsed.data.html);
    const buffer = Buffer.from(html, "utf8");
    const version = (row.version || 1) + 1;
    const mimeType = getGeneratedFileMimeType("html");
    const fileName = row.file_name || "doc.html";
    const preview: GeneratedFilePreview = {
      html,
      text: clampGeneratedPreviewText(html),
    };
    const uploaded = await uploadGeneratedFileReplacement(getGeneratedFileStorageDatabase(), {
      userId,
      chatId: row.chat_id,
      fileId,
      format: "html",
      buffer,
      mimeType,
      version,
    });

    if (!uploaded.success || !uploaded.storagePath || !uploaded.storageBucket || !uploaded.contentSha256) {
      res.status(500).json({ error: uploaded.error || "Failed to save edited generated file." });
      return;
    }

    const fileUrl = buildGeneratedFileApiUrl(fileId);
    try {
      await updateGeneratedFileMetadata(userDb, {
        fileId,
        userId,
        format: "html",
        fileName,
        mimeType,
        fileUrl,
        storagePath: uploaded.storagePath,
        storageBucket: uploaded.storageBucket,
        fileSizeBytes: uploaded.fileSizeBytes ?? buffer.length,
        contentSha256: uploaded.contentSha256 || hashGeneratedFile(buffer),
        version,
        preview,
      });
    } catch (metadataError) {
      await deleteGeneratedFileObject(getGeneratedFileStorageDatabase(), uploaded.storageBucket, uploaded.storagePath)
        .catch((cleanupError) => {
          console.warn(`[GeneratedFiles] cleanup failed after metadata update failure fileId=${fileId}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        });
      throw metadataError;
    }

    const { error: messageUpdateError } = await userDb
      .from("messages")
      .update({
        file_url: fileUrl,
        storage_path: uploaded.storagePath,
        file_size_bytes: uploaded.fileSizeBytes ?? buffer.length,
        file_name: fileName,
        file_format: "html",
        mime_type: mimeType,
        preview_json: preview,
      })
      .eq("generated_file_id", fileId);
    if (messageUpdateError) {
      logDbFailure("generated-files.update.messages", userId, messageUpdateError, { fileId });
    }

    const updatedRow: GeneratedFileRow = {
      ...row,
      file_url: fileUrl,
      storage_path: uploaded.storagePath,
      storage_bucket: uploaded.storageBucket,
      file_size_bytes: uploaded.fileSizeBytes ?? buffer.length,
      preview_json: preview,
      version,
      content_sha256: uploaded.contentSha256 || hashGeneratedFile(buffer),
      updated_at: new Date().toISOString(),
    };

    res.json({
      success: true,
      file: serializeGeneratedFileRow(updatedRow),
      degraded: Boolean(messageUpdateError),
      warnings: messageUpdateError ? ["generated_file_message_metadata_update_failed"] : [],
    });
  }),
);

app.delete(
  "/api/generated-files/:id",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const fileId = getRequiredUuid(req.params.id, "Generated file id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "generated-files.delete");
    await initializeUserSessionOrThrow(userDb, userId, "generated-files.delete");
    const row = await getGeneratedFileRowOrThrow(userDb, userId, fileId, "generated-files.delete");
    try {
      await deleteGeneratedFileObject(
        getGeneratedFileStorageDatabase(),
        row.storage_bucket || getStorageBucketName(),
        row.storage_path || "",
      );
    } catch (error) {
      console.error(`[GeneratedFiles] object delete failed fileId=${fileId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(503, "Stored file could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
    const { error: messageDeleteError } = await userDb.from("messages").delete().eq("generated_file_id", fileId);
    if (messageDeleteError) {
      logDbFailure("generated-files.delete.messages", userId, messageDeleteError, { fileId });
      throw new HttpError(503, "Stored file could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
    const { error: fileDeleteError } = await userDb.from("generated_files").delete().eq("id", fileId).eq("user_id", userId);
    if (fileDeleteError) {
      logDbFailure("generated-files.delete.metadata", userId, fileDeleteError, { fileId });
      throw new HttpError(503, "Stored file could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
    res.json({ success: true, file_id: fileId });
  }),
);

app.get(
  "/api/images/quota",
  verifyJWT({ allowGuest: true }),
  asyncHandler(async (req, res) => {
    const localInfo = getQuotaInfo(getImageQuotaKey(req));
    const requestUser = getRequestUser(req);
    const billingIdentity = buildBillingIdentity(req, requestUser);
    res.json(await getImageQuotaDisplay(billingIdentity, localInfo));
  }),
);

// ===============================
// POST /api/images/generate — Generate image from prompt
// ===============================
app.post(
  "/api/images/generate",
  verifyJWT({ allowGuest: true }),
  aiRateLimiter,
  imageQuotaMiddleware,
  asyncHandler(async (req, res) => {
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;
    const isGuest = requestUser.isGuest;
    const billingIdentity = buildBillingIdentity(req, requestUser);
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

    let conversationId = getOptionalUuid(parsed.data.conversationId, "conversationId", { ignoreInvalid: isGuest }) || "";
    if (isGuest) {
      conversationId = "";
    }
    const clientRequestId = parsed.data.clientRequestId?.trim() || "";
    const imageContextRecentMessages = collapseAdjacentDuplicateMessages(
      parsed.data.context?.recent_messages ?? [],
    );
    const promptResolution = resolveContextReferences({
      input: parsed.data.prompt,
      tool: "image_generation",
      recentMessages: imageContextRecentMessages,
      memories: parsed.data.context?.memories ?? [],
    });
    const providerPrompt = promptResolution.changed ? promptResolution.resolved : parsed.data.prompt;
    if (providerPrompt !== parsed.data.prompt && detectPromptInjection(providerPrompt)) {
      res.status(400).json({ error: "Image prompt rejected by safety filter." });
      return;
    }
    // Manual image generation resolves deterministic references before any
    // provider call. This clarification is separate from automatic semantic
    // tool routing and remains part of the public manual-image contract.
    if (promptResolution.needsClarification) {
      res.status(409).json({
        error: promptResolution.candidates.length > 0
          ? `Which subject should I use for the image: ${promptResolution.candidates.slice(0, 3).join(", ")}?`
          : "What should I generate an image of?",
        code: "context_clarification_required",
        candidates: promptResolution.candidates.slice(0, 3),
      });
      return;
    }
    if (promptResolution.changed) {
      console.log(
        `[IMAGE] prompt resolved original="${parsed.data.prompt.slice(0, 80)}" ` +
        `resolved="${providerPrompt.slice(0, 140)}" subject="${promptResolution.subject ?? ""}" ` +
        `source=${promptResolution.source ?? "none"} confidence=${promptResolution.confidence.toFixed(2)}`,
      );
    }
    let userDb: any = null;
    if (!isGuest) {
      userDb = await resolveUserDatabaseOrThrow(userId, "images.generate");
      await initializeUserSessionOrThrow(userDb, userId, "images.generate");
    }
    if (userDb && conversationId) {
      await ensureNamedWorkspaceProfile(userId, "images.generate", userDb);
      const resolvedImageConversation = await resolveConversationIdThroughAlias(userDb, userId, conversationId, "images.generate");
      conversationId = resolvedImageConversation.conversationId;
      await getOwnedConversationOrThrow(userDb, userId, conversationId, "images.generate");

      const existingAssistantImage = await findExistingAssistantImageMessage(
        userDb,
        conversationId,
        clientRequestId,
      );
      if (existingAssistantImage?.image_url) {
        const localQuota = getQuotaInfo(getImageQuotaKey(req));
        const quota = await getImageQuotaDisplay(billingIdentity, localQuota);
        res.json({
          type: "image",
          url: existingAssistantImage.image_url,
          prompt: parsed.data.prompt,
          resolved_prompt: existingAssistantImage.prompt || providerPrompt,
          original_prompt: parsed.data.prompt,
          provider_used: existingAssistantImage.provider || undefined,
          success: true,
          remaining: quota.remaining,
          limit: quota.limit,
          cooldownActive: localQuota.cooldownActive,
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
    } else if (userDb) {
      await ensureNamedWorkspaceProfile(userId, "images.generate", userDb);
    }

    const initialImageRoute = getImageModelForPlan("free", false);
    const imageReservation = await billingQuotaService.reserveFeature({
      identity: billingIdentity,
      feature: "image_generation",
      requestId: buildBillingRequestId("image", userId, clientRequestId || undefined),
      route: initialImageRoute,
      conversationId: conversationId || null,
      clientRequestId: clientRequestId || null,
      metadata: { endpoint: "images.generate" },
    });
    const textRenderingDecision = imageReservation.planCode === "free"
      ? { requiresTextRendering: false, source: "free_not_applicable" as const }
      : await classifyImageTextRendering({
          prompt: providerPrompt,
          executionMode: parsed.data.executionMode,
          userId,
          authenticated: !isGuest,
        });
    const entitledImageRoute = getImageModelForPlan(
      imageReservation.planCode,
      textRenderingDecision.requiresTextRendering,
    );
    const committedImageReservation: UsageReservation = {
      ...imageReservation,
      provider: entitledImageRoute.provider,
      model: entitledImageRoute.model,
      adapterModelOverride: entitledImageRoute.adapterModelOverride,
      safeModelLabel: entitledImageRoute.safeModelLabel,
      route: entitledImageRoute.route,
    };
    const preferredModel = entitledImageRoute.adapterModelOverride;

    let result: Awaited<ReturnType<typeof routeImageGeneration>>;
    const imageAbortController = new AbortController();
    const abortImageRequest = () => {
      if (!res.writableEnded) imageAbortController.abort(new Error("Client disconnected"));
    };
    req.once("aborted", abortImageRequest);
    res.once("close", abortImageRequest);
    try {
      const imageRequestKey = createHash("sha256")
        .update(userId)
        .update("\0")
        .update(conversationId || "no-conversation")
        .update("\0")
        .update(clientRequestId || providerPrompt)
        .update("\0manual_image_generation")
        .digest("hex");
      result = await routeImageGeneration({
        prompt: providerPrompt,
        size: parsed.data.size,
        userId,
        preferredModel,
        signal: imageAbortController.signal,
        requestKey: imageRequestKey,
      });
    } catch (error) {
      await releaseBillingReservation(committedImageReservation);
      throw error;
    } finally {
      req.removeListener("aborted", abortImageRequest);
      res.removeListener("close", abortImageRequest);
    }

    if (!result.success) {
      await releaseBillingReservation(committedImageReservation);
      console.log(`[IMAGE] endpoint failed prompt="${providerPrompt.slice(0, 40)}..." error="${result.error}"`);
      res.status(502).json({ error: "Image generation could not finish. Please try again.", code: "image_generation_failed" });
      return;
    }

    let imageUrl = result.image_url
      || (result.image_base64 ? `data:image/png;base64,${result.image_base64}` : undefined);
    let imageBase64 = result.image_base64;
    let imageId: string | undefined;
    let storagePath: string | undefined;
    let fileSizeBytes: number | undefined;

    if (!imageUrl && !imageBase64) {
      await releaseBillingReservation(committedImageReservation);
      res.status(502).json({ error: "Image generation could not finish. Please try again.", code: "image_generation_failed" });
      return;
    }

    await billingQuotaService.commit(committedImageReservation, {
      endpoint: "images.generate",
      route: "image_generation",
      requires_text_rendering: textRenderingDecision.requiresTextRendering,
      text_rendering_decision_source: textRenderingDecision.source,
    });

    if (userDb && conversationId) {
      const imageDataForPersistence = result.image_base64 || result.image_url || "";
      if (!imageDataForPersistence) {
        await releaseBillingReservation(committedImageReservation);
        res.status(502).json({ error: "Image generation could not finish. Please try again.", code: "image_generation_failed" });
        return;
      }

      try {
        const persisted = await persistGeneratedImageResult({
          userDb,
          userId,
          conversationId,
          prompt: providerPrompt,
          generatedImageData: imageDataForPersistence,
          provider: result.provider_used,
          clientRequestId,
          storageDb: getImageStorageDatabase(),
        });

        imageUrl = persisted.assistantMessage.image_url || persisted.storedImage.imageUrl;
        imageBase64 = undefined;
        imageId = persisted.storedImage.imageId;
        storagePath = persisted.assistantMessage.storage_path || persisted.storedImage.storagePath;
        fileSizeBytes = persisted.assistantMessage.file_size_bytes || persisted.storedImage.fileSizeBytes;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[IMAGE] persistence failed conversationId=${conversationId} clientRequestId=${clientRequestId || "none"} error="${message}"`,
        );
        commitImageQuotaSuccess(getImageQuotaKey(req));
        const quota = await getImageQuotaDisplay(billingIdentity, getQuotaInfo(getImageQuotaKey(req)));
        res.json({
          type: "image",
          url: imageUrl,
          prompt: parsed.data.prompt,
          resolved_prompt: result.prompt,
          original_prompt: parsed.data.prompt,
          provider_used: result.provider_used,
          success: true,
          persisted: false,
          code: "image_persistence_failed",
          warning: "Image was generated, but couldn't be saved to your conversation.",
          remaining: quota.remaining,
          limit: quota.limit,
          reset_at: quota.reset_at,
          plan_code: quota.plan_code,
          cooldownActive: quota.cooldownActive,
          cooldownResetMs: quota.cooldownResetMs,
          image_url: imageUrl,
          image_base64: imageBase64,
          conversation_id: conversationId || undefined,
        });
        return;
      }
    }

    commitImageQuotaSuccess(getImageQuotaKey(req));
    const quota = await getImageQuotaDisplay(billingIdentity, getQuotaInfo(getImageQuotaKey(req)));

    console.log(`[IMAGE] provider=${result.provider_used} success prompt="${parsed.data.prompt.slice(0, 40)}..." remaining=${quota.remaining}`);

    res.json({
      type: "image",
      url: imageUrl,
      prompt: parsed.data.prompt,
      resolved_prompt: result.prompt,
      original_prompt: parsed.data.prompt,
      context_resolution: {
        changed: promptResolution.changed,
        subject: promptResolution.subject,
        confidence: promptResolution.confidence,
        source: promptResolution.source,
      },
      provider_used: result.provider_used,
      success: true,
      remaining: quota.remaining,
      limit: quota.limit,
      reset_at: quota.reset_at,
      plan_code: quota.plan_code,
      cooldownActive: quota.cooldownActive,
      cooldownResetMs: quota.cooldownResetMs,
      // Keep legacy fields for frontend compatibility
      image_url: imageUrl,
      image_base64: imageBase64,
      image_id: imageId,
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
    const chatId = getRequiredUuid(chat_id, "chat_id");
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

    await getOwnedConversationOrThrow(userDb, userId, chatId, "images.store");

    const imageStorageDb = getImageStorageDatabase();
    const imageStorageDbId = getImageStorageDatabaseId();
    console.log(`[IMAGE_STORE] storage-db userId=${userId} chatId=${chatId} db=${imageStorageDbId}`);

    // Upload binary to the central image bucket and save metadata on the user's shard.
    const result = await uploadChatImage(
      userDb,
      {
        userId,
        chatId,
        imageData: image_data,
        prompt: typeof prompt === "string" ? prompt : undefined,
        provider: typeof provider === "string" ? provider : undefined,
      },
      { storageDb: imageStorageDb },
    );

    if (!result.success) {
      console.error(`[IMAGE_STORE] failed userId=${userId} chatId=${chatId} error=${result.error}`);
      res.status(500).json({ error: "Failed to store image." });
      return;
    }

    console.log(`[IMAGE_STORE] ok userId=${userId} chatId=${chatId} imageId=${result.imageId}`);
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
    const chatId = getRequiredUuid(req.params.chatId, "chatId");

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

app.delete(
  "/api/images/:id",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const imageId = getRequiredUuid(req.params.id, "Image id");
    const userDb = await resolveUserDatabaseOrThrow(userId, "images.delete");
    await initializeUserSessionOrThrow(userDb, userId, "images.delete");
    const { data: image, error: imageError } = await userDb
      .from("chat_images")
      .select("storage_path")
      .eq("id", imageId)
      .eq("user_id", userId)
      .maybeSingle();
    if (imageError || !image) {
      throw new HttpError(404, "Image not found.", { code: "image_not_found" });
    }
    const deleted = await deleteChatImage(userDb, userId, imageId, { storageDb: getImageStorageDatabase() });
    if (!deleted) {
      throw new HttpError(503, "Stored image could not be removed. Please try again.", { code: "artifact_cleanup_failed" });
    }
    if (image.storage_path) {
      const { error: messageDeleteError } = await userDb
        .from("messages")
        .delete()
        .eq("message_type", "image")
        .eq("storage_path", image.storage_path);
      if (messageDeleteError) {
        logDbFailure("images.delete.messages", userId, messageDeleteError, { imageId });
      }
    }
    res.json({ success: true, image_id: imageId, degraded: false });
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
      res.status(500).json({ error: "Chart generation could not finish. Please try again.", code: "chart_generation_failed" });
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
// POST /api/chat/selection — "Ask SentIQ Chat" text selection context endpoint
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
    const selectionConversationId = getOptionalUuid(parsed.data.conversationId, "conversationId");

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
        modelOverride: GUEST_TEXT_MODEL_OVERRIDE,
        userId,
      });

      res.json({
        route: "chat",
        answer: guestResult.answer,
        reply: guestResult.reply,
        thinking: gateThinking(guestResult.thinking, { modelOverride: GUEST_TEXT_MODEL_OVERRIDE }),
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
        conversationId: selectionConversationId,
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
    const rawConversationIdCandidate =
      typeof req.body?.conversationId === "string" && req.body.conversationId.trim()
        ? req.body.conversationId.trim()
        : typeof req.body?.conversation_id === "string" && req.body.conversation_id.trim()
          ? req.body.conversation_id.trim()
          : "";
    const rawConversationId = getOptionalUuid(rawConversationIdCandidate, "conversationId") || "";

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

    const resolvedTitleConversation = userDb && rawConversationId
      ? await resolveConversationIdThroughAlias(userDb, userId, rawConversationId, "chat.title")
      : null;
    const titleConversationId = resolvedTitleConversation?.conversationId || rawConversationId;
    const cacheScopedConversationId = titleConversationId
      ? titleConversationId
      : `title-${randomUUID()}`;

    const generation = await generateTitleWithFallback({
      userMessage,
      assistantReply,
      conversationId: cacheScopedConversationId,
      userId,
      scope: "chat.title",
      modelOverride: isGuest ? GUEST_MODEL_OVERRIDE : undefined,
    });

    if (!isGuest && userDb && titleConversationId) {
      await persistConversationTitleIfEligible({
        userDb,
        userId,
        conversationId: titleConversationId,
        title: generation.title,
        scope: "chat.title",
        allowFallbackReplacement: true,
        replacementBasisMessage: userMessage,
        titleSource: generation.source,
      });
    }

    res.json({
      title: generation.title,
      ...(titleConversationId ? {
        conversationId: titleConversationId,
        canonicalConversationId: titleConversationId,
        requestedConversationId: rawConversationId || null,
        aliased: Boolean(resolvedTitleConversation?.aliased),
      } : {}),
    });
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
    });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Search] direct search failed: ${message}`);
      res.status(503).json({ success: false, results: [], error: "Web search is temporarily unavailable. Please try again shortly.", code: "search_unavailable" });
    }
  }),
);

/**
 * GET /api/search/status — Check Tavily pipeline health
 */
app.get("/api/search/status", (_req, res) => {
  const status = getTavilyPipelineStatus();
  res.json({ available: status.available });
});

// =========================================================================
// Deep Research Endpoints (Durable Background Tasks)
// =========================================================================

import {
  buildDeepResearchStatusSnapshot,
  DeepResearchService,
  isDeepResearchHeartbeatStale,
} from "./tools/deepResearch/deepResearchService";
import {
  TavilyDeepResearchClient,
  TavilyDeepResearchError,
} from "./tools/deepResearch/tavilyDeepResearchClient";
import { DeepResearchQuotaLifecycle } from "./tools/deepResearch/deepResearchQuotaLifecycle";
import { startDeepResearchScaleGuard } from "./tools/deepResearch/deepResearchScaleGuard";
import { DeepResearchTaskCoordinator } from "./tools/deepResearch/deepResearchTaskCoordinator";
import type {
  DeepResearchEvent,
  DeepResearchReport,
  DeepResearchRuntimeMetadata,
  DeepResearchSource,
} from "./tools/deepResearch/deepResearchTypes";
import {
  renderDeepResearchDocx,
  renderDeepResearchPdf,
  sanitizeDeepResearchExportText,
} from "./tools/deepResearch/deepResearchExport";
import { getDeepResearchRoute } from "./billing/modelEntitlementRouter";

const deepResearchService = new DeepResearchService();
const tavilyDeepResearchClient = new TavilyDeepResearchClient();
const deepResearchTaskCoordinator = new DeepResearchTaskCoordinator();
const deepResearchWorkerId = randomUUID();
bootProfiler.mark("deepResearch.services.created");
const DEEP_RESEARCH_HEARTBEAT_MS = 15_000;
const DEEP_RESEARCH_STALE_AFTER_MS = (() => {
  const parsed = Number.parseInt(process.env.DEEP_RESEARCH_STALE_AFTER_MS || "90000", 10);
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : 90_000;
})();

type DeepResearchMessageStatus = "running" | "completed" | "failed" | "cancelled";

async function updateDeepResearchMessage(args: {
  userDb: any;
  messageId: string | null;
  conversationId: string;
  reportId: string;
  status: DeepResearchMessageStatus;
  title: string;
  content: string;
  sources?: Array<{ title: string; url: string }>;
}): Promise<void> {
  if (!args.messageId) return;
  const { error } = await args.userDb
    .from("messages")
    .update({
      content: args.content,
      preview_json: {
        report_id: args.reportId,
        status: args.status,
        title: args.title,
        sources: args.sources ?? [],
      },
    })
    .eq("id", args.messageId)
    .eq("conversation_id", args.conversationId)
    .eq("message_type", "deep_research");

  if (error) {
    console.error("[Deep Research] Failed to update persisted message metadata.");
  }
}

async function settleDeepResearchQuota(
  lifecycle: DeepResearchQuotaLifecycle,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await lifecycle.settle(metadata);
  } catch {
    // The lifecycle marks itself settled before attempting a commit so a
    // post-acceptance billing failure can never release consumed usage.
    console.error("[Deep Research] Failed to settle the quota reservation.");
  }
}

function getDeepResearchRuntime(report: DeepResearchReport): DeepResearchRuntimeMetadata {
  return report.request_metadata && typeof report.request_metadata === "object"
    ? report.request_metadata as DeepResearchRuntimeMetadata
    : {};
}

async function runDeepResearchTask(args: {
  userDb: any;
  userId: string;
  reportId: string;
  messageId: string | null;
  conversationId: string;
  title: string;
  prompt: string;
  quotaLifecycle: DeepResearchQuotaLifecycle;
  initialRuntime: DeepResearchRuntimeMetadata;
  signal: AbortSignal;
  publish: (event: DeepResearchEvent) => Promise<void>;
  wasExplicitlyCancelled: () => boolean;
}): Promise<void> {
  let partialContent = "";
  const discoveredSources = new Set<string>();
  const sourceList: DeepResearchSource[] = [];
  let searchCount = 0;
  let lastProgressWriteAt = 0;
  let lastCancellationCheckAt = 0;
  let progressWrite = Promise.resolve();
  const runtime: DeepResearchRuntimeMetadata = { ...args.initialRuntime };
  const scaleGuard = startDeepResearchScaleGuard();
  const stopScaleGuard = () => scaleGuard.stop();
  args.signal.addEventListener("abort", stopScaleGuard, { once: true });

  const persistProgress = async (force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastProgressWriteAt < 750) return progressWrite;
    lastProgressWriteAt = nowMs;
    runtime.heartbeat_at = new Date(nowMs).toISOString();
    const metadataSnapshot = { ...runtime };
    const contentSnapshot = partialContent;
    const sourcesSnapshot = [...sourceList];
    const searchCountSnapshot = searchCount;
    progressWrite = progressWrite
      .catch(() => undefined)
      .then(() => deepResearchService.updateProgress({
        userDb: args.userDb,
        userId: args.userId,
        reportId: args.reportId,
        partialContent: contentSnapshot,
        sources: sourcesSnapshot,
        searchCount: searchCountSnapshot,
        runtimeMetadata: metadataSnapshot,
      }));
    return progressWrite;
  };

  const heartbeat = setInterval(() => {
    void persistProgress(true).catch(() => {
      console.error("[Deep Research] Failed to persist background heartbeat.");
    });
  }, DEEP_RESEARCH_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    await args.publish({ type: "init", report_id: args.reportId });
    await tavilyDeepResearchClient.streamResearch(
      args.prompt,
      async (event) => {
        if (args.signal.aborted) return;
        const nowMs = Date.now();
        if (nowMs - lastCancellationCheckAt >= 2_000) {
          lastCancellationCheckAt = nowMs;
          const cancellationRequested = await deepResearchService.isCancellationRequested({
            userDb: args.userDb,
            userId: args.userId,
            reportId: args.reportId,
          });
          if (cancellationRequested) {
            deepResearchTaskCoordinator.cancel(args.reportId);
            return;
          }
        }

        if (event.type === "progress") {
          if (event.step === "plan") {
            runtime.progress_phase = "plan";
            runtime.progress_percent = 15;
            runtime.latest_status_text = "Planning research path...";
          } else if (event.step === "search") {
            searchCount += 1;
            runtime.progress_phase = "search";
            runtime.progress_percent = Math.min(70, 35 + searchCount * 5);
            runtime.latest_status_text = event.query ? `Searching: ${event.query}` : "Searching the web...";
          } else if (event.step === "synthesize") {
            runtime.progress_phase = "synthesize";
            runtime.progress_percent = 75;
            runtime.latest_status_text = "Synthesizing report...";
          }
          await persistProgress();
          await args.publish(event);
        } else if (event.type === "sources" && event.sources) {
          for (const source of event.sources) {
            if (!discoveredSources.has(source.url)) {
              discoveredSources.add(source.url);
              sourceList.push(source);
            }
          }
          runtime.latest_status_text = `Found ${sourceList.length} sources...`;
          await persistProgress(true);
          await args.publish({ type: "sources", sources: [...sourceList] });
        } else if (event.type === "content" && event.text) {
          partialContent += event.text;
          runtime.progress_phase = "synthesize";
          runtime.progress_percent = 90;
          runtime.latest_status_text = "Writing final report sections...";
          await persistProgress();
          await args.publish(event);
        }
      },
      args.signal,
      {
        onAccepted: () => {
          args.quotaLifecycle.markProviderAccepted();
          runtime.provider_accepted = true;
          void persistProgress(true).catch(() => undefined);
        },
      },
    );

    if (args.signal.aborted) {
      const abortError = new Error("Deep Research request cancelled.");
      abortError.name = "AbortError";
      throw abortError;
    }
    if (!partialContent.trim()) throw new Error("Deep Research returned no report content.");

    await progressWrite.catch(() => undefined);
    await deepResearchService.completeReport({
      userDb: args.userDb,
      userId: args.userId,
      reportId: args.reportId,
      content: partialContent,
      sources: sourceList,
      searchCount,
      runtimeMetadata: runtime,
    });
    await updateDeepResearchMessage({
      userDb: args.userDb,
      messageId: args.messageId,
      conversationId: args.conversationId,
      reportId: args.reportId,
      status: "completed",
      title: args.title,
      content: partialContent,
      sources: sourceList,
    });
    const report = await deepResearchService.getReport({
      userDb: args.userDb,
      userId: args.userId,
      reportId: args.reportId,
    });
    await settleDeepResearchQuota(args.quotaLifecycle, { report_id: args.reportId, outcome: "completed" });
    await args.publish({ type: "done", report: buildDeepResearchStatusSnapshot(report) });
  } catch (error: unknown) {
    const explicitlyCancelled = args.wasExplicitlyCancelled()
      || await deepResearchService.isCancellationRequested({
        userDb: args.userDb,
        userId: args.userId,
        reportId: args.reportId,
      });
    const safeCode = error instanceof TavilyDeepResearchError ? error.code : "research_failed";

    if (explicitlyCancelled) {
      runtime.cancellation_requested = true;
      try {
        await deepResearchService.cancelReport({
          userDb: args.userDb,
          userId: args.userId,
          reportId: args.reportId,
          partialContent,
          sources: sourceList,
          searchCount,
          runtimeMetadata: runtime,
        });
      } catch {
        console.error("[Deep Research] Failed to persist cancelled report status.");
      }
      await updateDeepResearchMessage({
        userDb: args.userDb,
        messageId: args.messageId,
        conversationId: args.conversationId,
        reportId: args.reportId,
        status: "cancelled",
        title: args.title,
        content: partialContent || "Research session cancelled.",
        sources: sourceList,
      });
      const report = await deepResearchService.getReport({ userDb: args.userDb, userId: args.userId, reportId: args.reportId });
      await settleDeepResearchQuota(args.quotaLifecycle, { report_id: args.reportId, outcome: "cancelled" });
      await args.publish({ type: "cancelled", report: buildDeepResearchStatusSnapshot(report) });
    } else {
      const statusText = "Research could not be completed. Please try again.";
      try {
        await deepResearchService.failReport({
          userDb: args.userDb,
          userId: args.userId,
          reportId: args.reportId,
          partialContent,
          sources: sourceList,
          searchCount,
          runtimeMetadata: runtime,
          statusText,
          errorCode: safeCode,
        });
      } catch {
        console.error("[Deep Research] Failed to persist failed report status.");
      }
      await updateDeepResearchMessage({
        userDb: args.userDb,
        messageId: args.messageId,
        conversationId: args.conversationId,
        reportId: args.reportId,
        status: "failed",
        title: args.title,
        content: statusText,
        sources: sourceList,
      });
      const report = await deepResearchService.getReport({ userDb: args.userDb, userId: args.userId, reportId: args.reportId });
      await settleDeepResearchQuota(args.quotaLifecycle, { report_id: args.reportId, outcome: "failed" });
      await args.publish({
        type: "error",
        error: statusText,
        code: safeCode,
        report: buildDeepResearchStatusSnapshot(report),
      });
    }
  } finally {
    clearInterval(heartbeat);
    args.signal.removeEventListener("abort", stopScaleGuard);
    scaleGuard.stop();
  }
}

async function startDeepResearchForRequest(req: Request, endpoint: string) {
  const { prompt, conversationId: conversationIdCandidate, clientRequestId } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) throw new HttpError(400, "Prompt is required.");
  const conversationId = getOptionalUuid(conversationIdCandidate, "conversationId");
  if (!conversationId) throw new HttpError(400, "Valid conversationId is required.");

  const normalizedPrompt = prompt.trim();
  const requestUser = getRequestUser(req);
  const userId = requestUser.sub;
  const billingIdentity = buildBillingIdentity(req, requestUser);
  const userDb = await resolveUserDatabaseOrThrow(userId, endpoint);
  await initializeUserSessionOrThrow(userDb, userId, endpoint);
  await ensureNamedWorkspaceProfile(userId, endpoint, userDb);
  const resolvedConversation = await resolveOrCreateConversationForRequest(
    userDb,
    userId,
    endpoint,
    conversationId,
    normalizedPrompt.slice(0, 50) || "New Chat",
    { clientRequestId: clientRequestId || undefined },
  );
  const activeConversationId = resolvedConversation.conversation.id;
  const normalizedClientRequestId = typeof clientRequestId === "string" ? clientRequestId.trim().slice(0, 120) : "";
  if (normalizedClientRequestId) {
    const existingReport = await deepResearchService.findByClientRequest({
      userDb,
      userId,
      conversationId: activeConversationId,
      clientRequestId: normalizedClientRequestId,
    });
    if (existingReport) {
      const recoveredReport = await recoverInterruptedDeepResearch(userDb, userId, existingReport);
      return {
        userDb,
        userId,
        report: recoveredReport,
        snapshot: buildDeepResearchStatusSnapshot(recoveredReport),
      };
    }
  }
  const reservation = await billingQuotaService.reserveFeature({
    identity: billingIdentity,
    feature: "deep_research",
    requestId: buildBillingRequestId("deep-research", userId, clientRequestId || undefined),
    route: getDeepResearchRoute(),
    conversationId: activeConversationId,
    clientRequestId: clientRequestId || null,
    metadata: { endpoint },
  });
  const quotaLifecycle = new DeepResearchQuotaLifecycle(billingQuotaService, reservation);
  const now = new Date().toISOString();
  const runtime: DeepResearchRuntimeMetadata = {
    prompt: normalizedPrompt,
    client_request_id: normalizedClientRequestId || undefined,
    progress_percent: 0,
    progress_phase: "queued",
    latest_status_text: "Queued for Deep Research.",
    started_at: now,
    heartbeat_at: now,
    worker_id: deepResearchWorkerId,
    cancellation_requested: false,
    provider_accepted: false,
  };
  let reportId: string | null = null;
  let messageId: string | null = null;

  try {
    reportId = await deepResearchService.createReport({
      userDb,
      userId,
      conversationId: activeConversationId,
      title: normalizedPrompt.slice(0, 150),
      requestMetadata: { prompt: normalizedPrompt },
      runtimeMetadata: runtime,
    });
    const messageInsertResult = await insertConversationMessage(userDb, {
      conversationId: activeConversationId,
      role: "assistant",
      content: "Initializing Deep Research report...",
      clientRequestId: clientRequestId || undefined,
      messageType: "deep_research",
      previewJson: {
        report_id: reportId,
        status: "running",
        title: normalizedPrompt.slice(0, 150),
        sources: [],
        progress_percent: 0,
        progress_phase: "queued",
        latest_status_text: "Queued for Deep Research.",
      },
    });
    if (messageInsertResult.error) throw new Error("Failed to persist the Deep Research message.");
    messageId = messageInsertResult.data?.id || null;
    if (messageId) {
      await deepResearchService.updateReportMessageId({ userDb, userId, reportId, messageId });
    }

    const started = deepResearchTaskCoordinator.start(reportId, (context) => runDeepResearchTask({
      userDb,
      userId,
      reportId: reportId as string,
      messageId,
      conversationId: activeConversationId,
      title: normalizedPrompt.slice(0, 150),
      prompt: normalizedPrompt,
      quotaLifecycle,
      initialRuntime: runtime,
      ...context,
    }));
    if (!started) throw new Error("Deep Research task already exists.");
  } catch (error) {
    await settleDeepResearchQuota(quotaLifecycle, { report_id: reportId || "", outcome: "failed_to_start" });
    if (reportId) {
      await deepResearchService.failReport({
        userDb,
        userId,
        reportId,
        runtimeMetadata: runtime,
        statusText: "Research could not be started. Please try again.",
        errorCode: "research_start_failed",
      }).catch(() => undefined);
    }
    throw new HttpError(500, "Deep Research could not be started.", { code: "research_start_failed" });
  }

  const report = await deepResearchService.getReport({ userDb, userId, reportId });
  return { userDb, userId, report, snapshot: buildDeepResearchStatusSnapshot(report) };
}

async function recoverInterruptedDeepResearch(
  userDb: any,
  userId: string,
  report: DeepResearchReport,
): Promise<DeepResearchReport> {
  if (report.status !== "running" || deepResearchTaskCoordinator.isActive(report.id)) return report;
  const runtime = getDeepResearchRuntime(report);
  if (!isDeepResearchHeartbeatStale(report, Date.now(), DEEP_RESEARCH_STALE_AFTER_MS)) return report;

  const statusText = "Research was interrupted by a server restart. Please start it again.";
  try {
    await deepResearchService.failReport({
      userDb,
      userId,
      reportId: report.id,
      partialContent: report.content || "",
      sources: report.sources || [],
      searchCount: report.search_count || 0,
      runtimeMetadata: runtime,
      statusText,
      errorCode: "research_interrupted",
    });
    await updateDeepResearchMessage({
      userDb,
      messageId: report.message_id,
      conversationId: report.conversation_id,
      reportId: report.id,
      status: "failed",
      title: report.title,
      content: statusText,
      sources: report.sources || [],
    });
  } catch {
    // Another backend instance may have completed or recovered it concurrently.
  }
  return deepResearchService.getReport({ userDb, userId, reportId: report.id });
}

async function openDeepResearchEventStream(args: {
  req: Request;
  res: Response;
  userDb: any;
  userId: string;
  report: DeepResearchReport;
}): Promise<void> {
  args.res.status(200);
  args.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  args.res.setHeader("Cache-Control", "no-cache, no-transform");
  args.res.setHeader("Connection", "keep-alive");
  args.res.setHeader("X-Accel-Buffering", "no");
  args.res.flushHeaders();
  const writer = createSseWriter(args.res, { maxBufferedBytes: 512 * 1024 });
  let closed = false;
  let interval: NodeJS.Timeout | null = null;
  let lastSnapshotSignature = "";
  let unsubscribe: () => void = () => undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    unsubscribe();
  };
  const writeEvent = async (event: DeepResearchEvent) => {
    if (closed) return;
    await writer.write(JSON.stringify(event));
    if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
      cleanup();
      writer.close();
    }
  };
  unsubscribe = deepResearchTaskCoordinator.subscribe(args.report.id, writeEvent);
  args.res.on("close", cleanup);

  const writeSnapshot = async () => {
    if (closed) return;
    let report = await deepResearchService.getReport({
      userDb: args.userDb,
      userId: args.userId,
      reportId: args.report.id,
    });
    report = await recoverInterruptedDeepResearch(args.userDb, args.userId, report);
    const snapshot = buildDeepResearchStatusSnapshot(report);
    const signature = `${snapshot.status}:${snapshot.updated_at}:${snapshot.progress_percent}:${snapshot.search_count}`;
    if (signature === lastSnapshotSignature) return;
    lastSnapshotSignature = signature;
    await writeEvent({ type: "snapshot", report: snapshot });
    if (snapshot.status === "completed") await writeEvent({ type: "done", report: snapshot });
    else if (snapshot.status === "cancelled") await writeEvent({ type: "cancelled", report: snapshot });
    else if (snapshot.status === "failed") {
      await writeEvent({ type: "error", error: snapshot.latest_status_text, code: "research_failed", report: snapshot });
    }
  };

  await writeSnapshot();
  if (!closed) {
    interval = setInterval(() => {
      void writeSnapshot().catch(() => {
        cleanup();
        writer.close();
      });
    }, 2_500);
    interval.unref?.();
  }
}

app.post(
  "/api/deep-research/start",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const started = await startDeepResearchForRequest(req, "deep-research.start");
    res.status(202).json(started.snapshot);
  }),
);

// Compatibility wrapper: starts a durable task and subscribes this response.
// Closing this response removes only the subscriber; it never cancels the task.
app.post(
  "/api/deep-research/stream",
  verifyJWT({ allowGuest: false }),
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const started = await startDeepResearchForRequest(req, "deep-research.stream");
    await openDeepResearchEventStream({ req, res, ...started });
  }),
);

/**
 * GET /api/deep-research/quota
 * Returns remaining and total quota configuration for Deep Research feature.
 */
app.get(
  "/api/deep-research/quota",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const requestUser = getRequestUser(req);
    const billingIdentity = buildBillingIdentity(req, requestUser);
    const summary = await billingQuotaService.getUsageSummary(billingIdentity);
    const quota = summary?.quotas?.deep_research;
    res.json({
      remaining: typeof quota?.remaining === "number" ? quota.remaining : 0,
      limit: typeof quota?.limit === "number" ? quota.limit : 0,
      reset_at: typeof quota?.reset_at === "string" ? quota.reset_at : null,
      plan_code: typeof summary?.plan_code === "string" ? summary.plan_code : "free",
    });
  }),
);

app.get(
  "/api/deep-research/:reportId/status",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;
    const userDb = await resolveUserDatabaseOrThrow(userId, "deep-research.status");
    let report = await deepResearchService.getReport({ userDb, userId, reportId: String(req.params.reportId) })
      .catch(() => { throw new HttpError(404, "Report not found.", { code: "report_not_found" }); });
    report = await recoverInterruptedDeepResearch(userDb, userId, report);
    res.json(buildDeepResearchStatusSnapshot(report));
  }),
);

app.get(
  "/api/deep-research/:reportId/events",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;
    const userDb = await resolveUserDatabaseOrThrow(userId, "deep-research.events");
    const report = await deepResearchService.getReport({ userDb, userId, reportId: String(req.params.reportId) })
      .catch(() => { throw new HttpError(404, "Report not found.", { code: "report_not_found" }); });
    await openDeepResearchEventStream({ req, res, userDb, userId, report });
  }),
);

app.post(
  "/api/deep-research/:reportId/cancel",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;
    const userDb = await resolveUserDatabaseOrThrow(userId, "deep-research.cancel");
    let report = await deepResearchService.getReport({ userDb, userId, reportId: String(req.params.reportId) })
      .catch(() => { throw new HttpError(404, "Report not found.", { code: "report_not_found" }); });
    if (report.status !== "running") {
      res.json(buildDeepResearchStatusSnapshot(report));
      return;
    }

    await deepResearchService.requestCancellation({ userDb, userId, report });
    const cancelledActiveTask = deepResearchTaskCoordinator.cancel(report.id);
    if (cancelledActiveTask) {
      await deepResearchTaskCoordinator.waitForIdle(report.id, 2_000);
      report = await deepResearchService.getReport({ userDb, userId, reportId: report.id });
    }

    if (report.status === "running") {
      const runtime = { ...getDeepResearchRuntime(report), cancellation_requested: true };
      await deepResearchService.cancelReport({
        userDb,
        userId,
        reportId: report.id,
        partialContent: report.content || "",
        sources: report.sources || [],
        searchCount: report.search_count || 0,
        runtimeMetadata: runtime,
      });
      await updateDeepResearchMessage({
        userDb,
        messageId: report.message_id,
        conversationId: report.conversation_id,
        reportId: report.id,
        status: "cancelled",
        title: report.title,
        content: report.content || "Research session cancelled.",
        sources: report.sources || [],
      });
      report = await deepResearchService.getReport({ userDb, userId, reportId: report.id });
    }
    res.json(buildDeepResearchStatusSnapshot(report));
  }),
);

/**
 * GET /api/deep-research/:reportId
 * Load report from metadata tables.
 */
app.get(
  "/api/deep-research/:reportId",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;

    const userDb = await resolveUserDatabaseOrThrow(userId, "deep-research.get");
    try {
      let report = await deepResearchService.getReport({
        userDb,
        userId,
        reportId: String(reportId),
      });
      report = await recoverInterruptedDeepResearch(userDb, userId, report);
      res.json(buildDeepResearchStatusSnapshot(report));
    } catch (err: any) {
      throw new HttpError(404, "Report not found.", { code: "report_not_found" });
    }
  }),
);

/**
 * GET /api/deep-research/:reportId/export
 * Downloads the report in Markdown format or placeholder formats.
 */
app.get(
  "/api/deep-research/:reportId/export",
  verifyJWT({ allowGuest: false }),
  asyncHandler(async (req, res) => {
    const { reportId } = req.params;
    const format = typeof req.query.format === "string" ? req.query.format.toLowerCase() : "md";
    const requestUser = getRequestUser(req);
    const userId = requestUser.sub;

    if (format !== "md" && format !== "docx" && format !== "pdf") {
      res.status(400).json({ error: "Invalid format. Supported formats: md, docx, pdf." });
      return;
    }

    const userDb = await resolveUserDatabaseOrThrow(userId, "deep-research.export");
    let report;
    try {
      report = await deepResearchService.getReport({
        userDb,
        userId,
        reportId: String(reportId),
      });
    } catch (err: any) {
      throw new HttpError(404, "Report not found.", { code: "report_not_found" });
    }

    if (report.status !== "completed" || typeof report.content !== "string" || !report.content.trim()) {
      res.status(409).json({
        error: "The report is not ready for export.",
        code: "report_not_ready",
      });
      return;
    }
    const sanitizedTitle = sanitizeDeepResearchExportText(report.title) || "Deep Research Report";
    const sanitizedContent = sanitizeDeepResearchExportText(report.content);

    if (format === "md") {
      res.setHeader("Content-Type", "text/markdown");
      res.setHeader("Content-Disposition", `attachment; filename="report-${reportId}.md"`);
      res.send(sanitizedContent);
    } else if (format === "docx") {
      try {
        const buffer = await renderDeepResearchDocx({
          title: sanitizedTitle,
          content: sanitizedContent,
        });
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        res.setHeader("Content-Disposition", `attachment; filename="report-${reportId}.docx"`);
        res.send(buffer);
      } catch (err: any) {
        console.error(`[Deep Research] Export docx failed: ${err.message}`);
        res.status(500).json({ error: "Failed to generate Word document." });
      }
    } else if (format === "pdf") {
      try {
        const buffer = await renderDeepResearchPdf({
          title: sanitizedTitle,
          content: sanitizedContent,
        });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="report-${reportId}.pdf"`);
        res.send(buffer);
      } catch (err: any) {
        console.error(`[Deep Research] Export pdf failed: ${err.message}`);
        res.status(500).json({ error: "Failed to generate PDF document." });
      }
    }
  }),
);

// ===============================
// GET /api/config — Server capabilities
// ===============================
app.get("/api/config", (_req, res) => {
  const searchStatus = getTavilyPipelineStatus();
  res.json({
    version: "2.0.0",
    features: {
      chat: true,
      memory: true,
      file_upload: true,
      image_generation: true,
      chart_generation: true,
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
    console.warn(`${LOG_PREFIX} Auth error: ${err.code}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(err.status).json({ error: err.message });
    }
    return;
  }

  if (err instanceof BillingQuotaError) {
    console.warn(`${LOG_PREFIX} Billing quota error: ${err.code} policy=${err.policyVersion ?? "v1"} plan=${err.planCode ?? "unknown"}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(err.statusCode).json(quotaErrorToPublicResponse(err));
    }
    return;
  }

  if (err instanceof ModelCapabilityUnavailableError) {
    console.warn(`${LOG_PREFIX} Model capability unavailable`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return;
  }

  if (err instanceof ModelToolTransportError || (err as { code?: string }).code === "model_tool_capability_unavailable") {
    console.warn(`${LOG_PREFIX} Model tool transport unavailable`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(503).json({
        error: "A compatible tool-capable model is temporarily unavailable. Please try again later.",
        code: "model_tool_capability_unavailable",
      });
    }
    return;
  }

  // Handle multer errors (file too large, etc.) with clear messages
  if (err && (err as any).code === "LIMIT_FILE_SIZE") {
    console.warn(`${LOG_PREFIX} File upload rejected: file too large`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    }
    return;
  }
  if (err && err.message && err.message.includes("Multipart")) {
    console.warn(`${LOG_PREFIX} Multer error: ${err.message}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(400).json({ error: "Invalid file upload. Please try again." });
    }
    return;
  }

  const { statusCode, headers, body } = buildHttpErrorResponse(err);
  const logMethod = statusCode >= 500 ? console.error : console.warn;
  logMethod(`${LOG_PREFIX} Unhandled error:`, err.message);
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
let httpServer: ReturnType<typeof app.listen> | null = null;
let shutdownStarted = false;

function shutdownProcess(reason: string, exitCode: number, error?: unknown): void {
  if (shutdownStarted) return;
  shutdownStarted = true;

  if (error) {
    console.error(`${LOG_PREFIX} ${reason}:`, error);
  } else {
    console.log(`${LOG_PREFIX} ${reason} received - shutting down gracefully`);
  }

  const forceExitTimer = setTimeout(() => {
    console.error(`${LOG_PREFIX} forced shutdown after ${SHUTDOWN_GRACE_MS}ms active_requests=${activeRequests}`);
    process.exit(exitCode);
  }, SHUTDOWN_GRACE_MS);
  forceExitTimer.unref();

  const finish = () => {
    clearTimeout(forceExitTimer);
    console.log(`${LOG_PREFIX} HTTP server closed active_requests=${activeRequests}`);
    process.exit(exitCode);
  };

  if (!httpServer) {
    finish();
    return;
  }

  httpServer.close((closeError?: Error) => {
    if (closeError) {
      console.error(`${LOG_PREFIX} HTTP server close failed: ${closeError.message}`);
      process.exit(exitCode || 1);
      return;
    }
    finish();
  });
}

bootProfiler.measureSync("internalGateway.validation", validateInternalGatewayConfiguration);

bootProfiler.measure("verifyShardMigrations", verifyShardMigrations).then(() => {
  bootProfiler.mark("express.listen.begin");
  httpServer = app.listen(PORT, () => {
    bootProfiler.mark("express.listen.ready");
    console.log(`${LOG_PREFIX} Server running on port ${PORT}`);
    console.log(`${LOG_PREFIX} Architecture: Orchestrated Dual-Model (Gemini + Groq)`);
    console.log(`${LOG_PREFIX} LLM Service expected on port ${process.env.LLM_SERVICE_PORT || "3002"}`);

    const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
    if (!jwtSecret) {
      console.warn(`${LOG_PREFIX} WARNING: SUPABASE_JWT_SECRET is not set; auth will fall back to Supabase and add latency.`);
    }

    // Log Tavily availability for debugging
    const tavilyStatus = isTavilyAvailable();
    bootProfiler.mark("tavily.availability.checked");
    console.log(`${LOG_PREFIX} Tavily Web Search: ${tavilyStatus ? "ENABLED" : "DISABLED (set TAVILY_KEYS in env)"}`);
    bootProfiler.logSummary({
      ready: true,
      measures: [
        { key: "verifyShardMigrations", label: "verifyShardMigrations" },
        { key: "dataShardsParallel", label: "verifyShardMigrations.data-shards.parallel" },
      ],
    });
  });

  process.on("SIGTERM", () => shutdownProcess("SIGTERM", 0));
  process.on("SIGINT", () => shutdownProcess("SIGINT", 0));
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${LOG_PREFIX} FATAL: startup migration verification failed: ${message}`);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  shutdownProcess("FATAL uncaught exception", 1, err);
});
process.on("unhandledRejection", (reason) => {
  shutdownProcess("FATAL unhandled rejection", 1, reason);
});
