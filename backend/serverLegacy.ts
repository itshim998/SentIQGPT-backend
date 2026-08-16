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
        "memory",
        "memory_management",
        "selection",
        "tool",
      ]);
      output[key] = publicRoutes.has(nestedValue) ? nestedValue : "chat";
      continue;
    }
    output[key] = sanitizePublicPayload(nestedValue);
  }
  return output;
}

