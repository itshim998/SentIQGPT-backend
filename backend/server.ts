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
import { callLLMAdapter, buildTitleGeneratePrompt, strictParseJsonObject, callLLMAdapterStream, buildChatPrompt } from "./ai/PromptBuilders";
import type { ChatContext } from "./ai/PromptBuilders";
import { buildContext, buildContextFast } from "./context/contextBuilder";
import { getOrAssignUserDatabase } from "./dbRouter";

// v2 Orchestrator
import { orchestrate } from "./orchestrator/aiOrchestrator";

import { detectCodeQuery, isMathQuery, selectModelForPrompt } from "./orchestrator/modelRouter";
import { detectExplicitMemoryWriteIntent } from "./orchestrator/queryClassifier";

// Middleware
import { generalRateLimiter, aiRateLimiter, uploadRateLimiter } from "./middleware/rateLimiter";
import { auditMiddleware, getRecentAuditEntries } from "./middleware/audit";
import { imageQuotaMiddleware, getQuotaInfo, isImageRequest } from "./middleware/imageQuota";

// Validation
import {
  ChatRequestSchema,
  MemoryClassifyRequestSchema,
  MemoryCompressRequestSchema,
  ImageGenerateRequestSchema,
  ChartGenerateRequestSchema,
  SelectionContextSchema,
  detectPromptInjection,
} from "./validation/schemas";
import { ZodError } from "zod";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

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
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

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

const GUEST_USER_ID = "guest";
const GUEST_MODEL_OVERRIDE = "gemini-fast";

async function getVerifiedUserId(req: Request): Promise<string> {
  const authHeader = req.header("Authorization") || req.header("authorization") || "";
  const bearerPrefix = "Bearer ";
  if (!authHeader.startsWith(bearerPrefix)) {
    throw new Error("Unauthorized");
  }

  const token = authHeader.slice(bearerPrefix.length).trim();
  if (!token) {
    throw new Error("Unauthorized");
  }

  const supabaseUrl = process.env.SUPABASE_URL_1?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY_1?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Unauthorized");
  }

  let response: globalThis.Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
      },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    throw new Error("Unauthorized");
  }

  const verifiedUser = await response.json() as { id?: string };
  const userId = typeof verifiedUser.id === "string" ? verifiedUser.id.trim() : "";
  if (!userId) {
    throw new Error("Unauthorized");
  }

  return userId;
}

async function getRequestIdentity(req: Request): Promise<{ userId: string; isGuest: boolean }> {
  const authHeader = req.header("Authorization") || req.header("authorization") || "";
  if (!authHeader.trim()) {
    return { userId: GUEST_USER_ID, isGuest: true };
  }
  return { userId: await getVerifiedUserId(req), isGuest: false };
}

type DbErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

type ConversationRow = {
  id: string;
  user_id: string;
  title?: string | null;
  created_at?: string;
};

type ConversationListRow = {
  id: string;
  title: string | null;
  created_at: string;
};

type ConversationMessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type MemoryScope = "global" | "chat";

type MemoryRow = {
  id: string;
  user_id: string;
  type: string;
  summary: string;
  importance: number;
  scope?: MemoryScope | null;
  chat_id?: string | null;
  created_at: string;
};

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

async function resolveUserDatabaseOrThrow(userId: string, scope: string) {
  logDbEvent(`${scope}.resolve-db.start`, userId);
  try {
    const userDb = await getOrAssignUserDatabase(userId);
    logDbEvent(`${scope}.resolve-db.ok`, userId);
    return userDb;
  } catch (error) {
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
  const { data, error } = await userDb
    .from("conversations")
    .select("id, user_id, title, created_at")
    .eq("id", conversationId)
    .single();

  if (error || !data || data.user_id !== userId) {
    if (error) {
      logDbFailure(`${scope}.conversation-owner`, userId, error, { conversationId });
    } else {
      logDbFailure(`${scope}.conversation-owner`, userId, new Error("Unauthorized conversation access"), { conversationId });
    }
    throw new Error("Unauthorized conversation access");
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
  const { data, error } = await userDb
    .from("conversations")
    .insert({ user_id: userId, title })
    .select("id, title, created_at")
    .single();

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
): Promise<void> {
  logDbEvent(`${scope}.message-insert.start`, userId, { conversationId, role });
  const { error } = await userDb
    .from("messages")
    .insert({ conversation_id: conversationId, role, content });
  if (error) {
    logDbFailure(`${scope}.message-insert`, userId, error, { conversationId, role });
    throw new Error(error.message);
  }
  logDbEvent(`${scope}.message-insert.ok`, userId, { conversationId, role });
}

async function insertMemoryOrThrow(
  userDb: any,
  userId: string,
  memory: { type?: string; summary?: string; importance?: number; scope?: MemoryScope; chat_id?: string | null },
  scope: string,
): Promise<MemoryRow> {
  logDbEvent(`${scope}.memory-insert.start`, userId, { type: memory.type || null });
  const normalizedScope: MemoryScope = memory.scope === "chat" ? "chat" : "global";
  const { data, error } = await userDb
    .from("memories")
    .insert({
      user_id: userId,
      type: memory.type,
      summary: memory.summary,
      importance: memory.importance,
      scope: normalizedScope,
      chat_id: normalizedScope === "chat" ? memory.chat_id ?? null : null,
    })
    .select("id, user_id, type, summary, importance, scope, chat_id, created_at")
    .single();
  if (error) {
    logDbFailure(`${scope}.memory-insert`, userId, error, { type: memory.type || null });
    throw new Error(error.message);
  }
  if (!data?.id) {
    throw new Error("Failed to create memory");
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
  const { data, error } = await userDb
    .from("memories")
    .select("id, user_id, type, summary, importance, scope, chat_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

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
  const { error } = await userDb
    .from("memories")
    .delete()
    .eq("id", memoryId)
    .eq("user_id", userId);

  if (error) {
    logDbFailure(`${scope}.memory-delete`, userId, error, { memoryId });
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.memory-delete.ok`, userId, { memoryId });
}

async function listConversationsOrThrow(userDb: any, userId: string, scope: string): Promise<ConversationListRow[]> {
  logDbEvent(`${scope}.conversation-list.start`, userId);
  const startedAt = Date.now();
  const { data, error } = await userDb
    .from("conversations")
    .select("id, title, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    logDbFailure(`${scope}.conversation-list`, userId, error);
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.conversation-list.ok`, userId, {
    count: data?.length || 0,
    duration_ms: Date.now() - startedAt,
  });
  return (data || []) as ConversationListRow[];
}

async function listConversationMessagesOrThrow(
  userDb: any,
  userId: string,
  conversationId: string,
  scope: string,
): Promise<ConversationMessageRow[]> {
  await getOwnedConversationOrThrow(userDb, userId, conversationId, scope);
  logDbEvent(`${scope}.message-list.start`, userId, { conversationId });
  const startedAt = Date.now();
  const { data, error } = await userDb
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) {
    logDbFailure(`${scope}.message-list`, userId, error, { conversationId });
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.message-list.ok`, userId, {
    conversationId,
    count: data?.length || 0,
    duration_ms: Date.now() - startedAt,
  });
  return (data || []) as ConversationMessageRow[];
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
  const { error } = await userDb
    .from("conversations")
    .update({ title })
    .eq("id", conversationId)
    .eq("user_id", userId);

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
  const { error } = await userDb
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .eq("user_id", userId);

  if (error) {
    logDbFailure(`${scope}.conversation-delete`, userId, error, { conversationId });
    throw new Error(error.message);
  }

  logDbEvent(`${scope}.conversation-delete.ok`, userId, { conversationId });
}

// ---- File Session Manager ----
// Maintains the most recently uploaded file per IP to prevent old file references.
interface FileSession {
  filename: string;
  type: string;
  extractedText: string;
  uploadTime: number;
}
const fileSessionMap: Map<string, FileSession> = new Map();

// Clean up sessions older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [ip, session] of fileSessionMap) {
    if (session.uploadTime < cutoff) fileSessionMap.delete(ip);
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
// GET /api/conversations
// ===============================
app.get(
  "/api/conversations",
  asyncHandler(async (req, res) => {
    const requestStartedAt = Date.now();
    const userId = await getVerifiedUserId(req);
    const userDb = await resolveUserDatabaseOrThrow(userId, "conversations.list");
    await initializeUserSessionOrThrow(userDb, userId, "conversations.list");
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
    const conversation = await createConversationOrThrow(userDb, userId, "conversations.create", requestedTitle);
    logDbEvent("conversations.create.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId: conversation.id,
    });
    res.json({ conversation });
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
    const messages = await listConversationMessagesOrThrow(
      userDb,
      userId,
      conversationId,
      "conversations.messages",
    );
    logDbEvent("conversations.messages.request.ok", userId, {
      duration_ms: Date.now() - requestStartedAt,
      conversationId,
      count: messages.length,
    });
    res.json({ messages });
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
    await deleteMemoryIfOwned(userDb, userId, memoryId, "memories.delete");
    res.json({ success: true });
  }),
);

// ===============================
// POST /api/chat — Main conversation endpoint (v2: orchestrated)
// ===============================
app.post(
  "/api/chat",
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }
    const { userId, isGuest } = await getRequestIdentity(req);

    // Prompt injection detection
    if (detectPromptInjection(parsed.data.message)) {
      res.status(400).json({ error: "Message rejected by safety filter." });
      return;
    }

    // v2: Route through the AI orchestrator
    // Always include file_references when present — the frontend only sends
    // the current session file (scoped correctly), so no backend gating needed.
    const orcFileRefs = parsed.data.context?.file_references;
    if (Array.isArray(orcFileRefs) && orcFileRefs.length > 0) {
      console.log(`[File] orchestrator: ${orcFileRefs.length} file(s) included in context`);
    }

    if (isGuest) {
      const guestContext = await buildContext({
        recent_messages: parsed.data.context?.recent_messages,
        memories: [],
        file_references: orcFileRefs,
        userMessage: parsed.data.message,
      }, undefined, userId);

      const guestResult = await handleChat({
        userMessage: parsed.data.message,
        recentMessages: guestContext.recentMessages,
        memories: [],
        fileReferences: guestContext.fileReferences,
        conversationSummary: guestContext.conversationSummary,
        modelOverride: GUEST_MODEL_OVERRIDE,
        userId,
      });

      res.json({
        route: "chat",
        reply: guestResult.reply,
        disclaimer: guestResult.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
      });
      return;
    }

    const sync = {
      persisted: true,
      deferred: false,
      conversationId: undefined as string | undefined,
    };

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

    if (userDb && activeConversationId) {
      try {
        await getOwnedConversationOrThrow(userDb, userId, activeConversationId, "chat");
        sync.conversationId = activeConversationId;
      } catch (conversationLookupError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.conversation.resolve",
          userId,
          conversationLookupError instanceof Error ? conversationLookupError : new Error(String(conversationLookupError)),
          { conversationId: activeConversationId },
        );
        activeConversationId = null;
      }
    }
    if (userDb && !activeConversationId) {
      try {
        const conversationRow = await createConversationOrThrow(userDb, userId, "chat");
        activeConversationId = conversationRow.id;
        sync.conversationId = activeConversationId;
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
        );
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

    const result = await orchestrate({
      userMessage: parsed.data.message,
      context: {
        recent_messages: parsed.data.context?.recent_messages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
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

    res.json({
      route: result.route,
      reply: result.reply,
      disclaimer: result.disclaimer,
      image: result.image,
      chart: result.chart,
      memory: responseMemory,
      confidence: result.confidence,
      sync,
    });
  }),
);

// ===============================
// POST /api/chat/stream — SSE streaming chat endpoint
// ===============================
app.post(
  "/api/chat/stream",
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    const writeSseEvent = (payload: string) => {
      if (!res.writableEnded) {
        res.write(`data: ${payload}\n\n`);
      }
    };
    const finishSse = () => {
      if (!res.writableEnded) {
        res.end();
      }
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
    const { userId, isGuest } = await getRequestIdentity(req);
    if (isGuest) {
      const requestStart = Date.now();
      console.log(`[Latency] guest user query received`);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      let clientDisconnected = false;
      req.on("close", () => { clientDisconnected = true; });

      const fileRefs = parsed.data.context?.file_references;
      const guestCtx = await buildContextFast({
        recent_messages: parsed.data.context?.recent_messages,
        memories: [],
        file_references: fileRefs,
        userMessage: parsed.data.message,
      }, undefined, userId);

      const chatCtx: ChatContext = {
        userMessage: parsed.data.message,
        recentMessages: guestCtx.recentMessages,
        memories: [],
        fileReferences: guestCtx.fileReferences,
        conversationSummary: guestCtx.conversationSummary,
        modelOverride: GUEST_MODEL_OVERRIDE,
        userId,
      };

      const call = buildChatPrompt(chatCtx);
      console.log(`[Latency] guest LLM request started (+${Date.now() - requestStart}ms)`);
      console.log(`[Stream] guest model=${chatCtx.modelOverride} hasFiles=${guestCtx.hasFileContext} msgLen=${parsed.data.message.length}`);

      try {
        const streamStart = Date.now();
        const stream = await callLLMAdapterStream(call);
        const reader = stream.getReader();
        let tokenCount = 0;
        let firstTokenReceived = false;
        let streamTimedOut = false;

        const STREAM_TIMEOUT_MS = 60_000;
        const FIRST_TOKEN_SLOW_MS = 8_000;

        const firstTokenTimer = setTimeout(() => {
          if (!firstTokenReceived && !clientDisconnected) {
            console.log(`[Timeout] guest first token delayed beyond ${FIRST_TOKEN_SLOW_MS}ms`);
          }
        }, FIRST_TOKEN_SLOW_MS);

        const streamTimer = setTimeout(() => {
          if (!clientDisconnected && tokenCount > 0) {
            streamTimedOut = true;
            console.log(`[Timeout] guest stream timeout after ${tokenCount} chunks, completing gracefully`);
          }
        }, STREAM_TIMEOUT_MS);

        try {
          while (true) {
            if (clientDisconnected || streamTimedOut) {
              reader.cancel();
              break;
            }

            const result = await reader.read();
            if (result.done) break;

            const value = result.value;
            tokenCount++;

            if (tokenCount === 1) {
              firstTokenReceived = true;
              clearTimeout(firstTokenTimer);
              console.log(`[Latency] guest first token streamed (+${Date.now() - requestStart}ms)`);
            }

            writeSseEvent(JSON.stringify({ type: "token", text: value }));
          }
        } finally {
          clearTimeout(firstTokenTimer);
          clearTimeout(streamTimer);
        }

        if (!clientDisconnected) {
          if (streamTimedOut && tokenCount > 0) {
            writeSseEvent(JSON.stringify({
              type: "error",
              error: "Response interrupted after a long stream. Showing partial output.",
            }));
          }
          writeSseEvent("[DONE]");
        }
        console.log(`[Stream] guest completed: ${tokenCount} chunks in ${Date.now() - streamStart}ms`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] guest error: ${message}`);
        if (!clientDisconnected) {
          writeSseEvent(JSON.stringify({ type: "error", error: message }));
        }
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
    if (userDb && activeConversationId) {
      try {
        await getOwnedConversationOrThrow(userDb, userId, activeConversationId, "chat.stream");
      } catch (conversationOwnershipError) {
        sync.persisted = false;
        sync.deferred = true;
        logDbFailure(
          "chat.stream.conversation-resolve",
          userId,
          conversationOwnershipError instanceof Error ? conversationOwnershipError : new Error(String(conversationOwnershipError)),
          { conversationId: activeConversationId },
        );
        activeConversationId = null;
      }
    }
    if (userDb && !activeConversationId) {
      try {
        const conversationRow = await createConversationOrThrow(userDb, userId, "chat.stream");
        activeConversationId = conversationRow.id;
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
        );
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

    let clientDisconnected = false;
    req.on("close", () => { clientDisconnected = true; });

    if (detectExplicitMemoryWriteIntent(parsed.data.message)) {
      console.log(`[Stream] explicit memory write detected — redirecting to orchestrator`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: parsed.data.context?.recent_messages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        res.json({
          route: result.route,
          reply: result.reply,
          disclaimer: result.disclaimer,
          image: result.image,
          chart: result.chart,
          memory: result.memory,
          confidence: result.confidence,
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
            recent_messages: parsed.data.context?.recent_messages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        if (result.reply) {
          await persistAssistantMessage(result.reply);
        }
        await persistStoredMemory(result.memory);
        // Return the full orchestrator result as JSON (not SSE) so the frontend
        // can use deliverAssistantResponse to render the chart.
        res.json({
          route: result.route,
          reply: result.reply,
          disclaimer: result.disclaimer,
          image: result.image,
          chart: result.chart,
          memory: result.memory,
          confidence: result.confidence,
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
    // Math queries need the direct DeepSeek pipeline, which
    // is only available through the orchestrator.  Redirect like chart requests.
    const isCodingQuery = detectCodeQuery(parsed.data.message);
    const isMathReasoningQuery = !isCodingQuery && isMathQuery(parsed.data.message);

    if (isMathReasoningQuery) {
      console.log(`[MathPipeline] streaming math query — redirecting to orchestrator`);
      let sseStarted = false;
      try {
        // Send SSE headers early so frontend can detect route before answer arrives
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        sseStarted = true;
        // Emit route metadata so frontend can show "Reasoning..." indicator
        writeSseEvent(JSON.stringify({ type: "route", route: "math_reasoning" }));

        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: parsed.data.context?.recent_messages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
            conversationId: activeConversationId || undefined,
            userDb,
            userId,
          },
        });
        // Return as SSE stream so the frontend handles it uniformly
        if (result.reply) {
          // Stream the math answer in chunks for smooth typing effect
          const CHUNK_SIZE = 24;
          for (let i = 0; i < result.reply.length; i += CHUNK_SIZE) {
            const chunk = result.reply.slice(i, i + CHUNK_SIZE);
            writeSseEvent(JSON.stringify({ type: "token", text: chunk }));
          }
        }
        if (!clientDisconnected && result.reply) {
          await persistAssistantMessage(result.reply);
        }
        if (!clientDisconnected) {
          await persistStoredMemory(result.memory);
        }
        writeSseEvent("[DONE]");
        finishSse();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MathPipeline] streaming orchestration failed: ${message}`);
        if (sseStarted || res.headersSent) {
          writeSseEvent(JSON.stringify({ type: "error", error: message }));
          writeSseEvent("[DONE]");
          finishSse();
        } else {
          res.status(500).json({ error: message });
        }
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
    const hasFile = Array.isArray(fileRefs) && fileRefs.length > 0;
    const hasImage = hasFile && fileRefs.some((f: { filename?: string }) =>
      /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.filename || "")
    );
    if (hasFile) console.log(`[File] stream: ${fileRefs.length} file(s) in context, hasImage: ${hasImage}`);

    const modelOverride = selectModelForPrompt(parsed.data.message, undefined, { hasImage, hasFile });

    // ── FAST context build (NO LLM calls, minimal latency) ──
    // Use buildContextFast which skips conversation compression for speed.
    // This gets the model started ASAP while still providing recent context.
    const ctx = await buildContextFast({
      recent_messages: parsed.data.context?.recent_messages,
      memories: parsed.data.context?.memories,
      file_references: fileRefs,
      userMessage: parsed.data.message,
      conversationId: activeConversationId || undefined,
    }, userDb, userId);

    console.log(`[Latency] context built (+${Date.now() - requestStart}ms)`);

    const chatCtx: ChatContext = {
      userMessage: parsed.data.message,
      recentMessages: ctx.recentMessages,
      memories: ctx.memories,
      fileReferences: ctx.fileReferences,
      conversationSummary: ctx.conversationSummary,
      modelOverride,
      userId,
    };

    const call = buildChatPrompt(chatCtx);
    console.log(`[Latency] LLM request started (+${Date.now() - requestStart}ms)`);
    console.log(`[Stream] model=${chatCtx.modelOverride} hasFiles=${ctx.hasFileContext} msgLen=${parsed.data.message.length}`);

    try {
      const streamStart = Date.now();
      const stream = await callLLMAdapterStream(call);
      const reader = stream.getReader();
      let tokenCount = 0;
      let fullReply = "";

      // Timeout safety: allow buffered providers to deliver a late first chunk
      // without treating it as a fatal error. The hard request bound stays in
      // the LLM fetch timeout; this timer is only a soft observability signal.
      const STREAM_TIMEOUT_MS = 60_000; // 60s max streaming time
      const FIRST_TOKEN_SLOW_MS = 8_000; // soft threshold for late first token
      let firstTokenReceived = false;
      let streamTimedOut = false;

      // Slow-first-token note: useful for buffered models like Pollinations,
      // but it must not cancel the stream on its own.
      const firstTokenTimer = setTimeout(() => {
        if (!firstTokenReceived && !clientDisconnected) {
          console.log(`[Timeout] first token delayed beyond ${FIRST_TOKEN_SLOW_MS}ms`);
        }
      }, FIRST_TOKEN_SLOW_MS);

      // Overall stream timeout
      const streamTimer = setTimeout(() => {
        if (!clientDisconnected && tokenCount > 0) {
          streamTimedOut = true;
          console.log(`[Timeout] stream timeout after ${tokenCount} chunks, completing gracefully`);
        }
      }, STREAM_TIMEOUT_MS);

      try {
        while (true) {
          if (clientDisconnected || streamTimedOut) {
            reader.cancel();
            break;
          }

          const result = await reader.read();
          if (result.done) break;

          const value = result.value;
          tokenCount++;
          fullReply += value;

          if (tokenCount === 1) {
            firstTokenReceived = true;
            clearTimeout(firstTokenTimer);
            console.log(`[Latency] first token streamed (+${Date.now() - requestStart}ms)`);
          }
          writeSseEvent(JSON.stringify({ type: "token", text: value }));
        }
      } finally {
        clearTimeout(firstTokenTimer);
        clearTimeout(streamTimer);
      }

      if (!clientDisconnected) {
        if (!streamTimedOut && fullReply) {
          await persistAssistantMessage(fullReply);
        }
        if (streamTimedOut && tokenCount > 0) {
          writeSseEvent(JSON.stringify({
            type: "error",
            error: "Response interrupted after a long stream. Showing partial output.",
          }));
        }
        writeSseEvent("[DONE]");
        if (streamTimedOut && tokenCount > 0) {
          console.log(`[Latency] response completed (timeout, partial) (+${Date.now() - requestStart}ms)`);
        } else {
          console.log(`[Latency] response completed (+${Date.now() - requestStart}ms)`);
        }
      }
      console.log(`[Stream] completed: ${tokenCount} chunks in ${Date.now() - streamStart}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Stream] error: ${message}`);
      if (!clientDisconnected) {
        writeSseEvent(JSON.stringify({ type: "error", error: message }));
      }
    } finally {
      finishSse();
    }
  }),
);

// ===============================
// POST /api/memory/classify — Standalone memory classification
// ===============================
app.post(
  "/api/memory/classify",
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

    const result = await compressMemories({
      memories: parsed.data.memories,
      userId,
    });

    res.json(result);
  }),
);

// ===============================
// POST /api/files/upload — Upload & extract file
// ===============================
app.post(
  "/api/files/upload",
  uploadRateLimiter,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const userId = await getVerifiedUserId(req);
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded." });
      return;
    }

    const validation = validateFileUpload(file.mimetype, file.size, file.originalname);
    if (!validation.valid) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const result = await extractTextFromFile({
      buffer: file.buffer,
      filename: file.originalname,
      mimetype: file.mimetype,
      userId,
    });

    console.log(`[File Upload] ${result.filename} → type=${result.type}, extracted=${result.extracted_text.length} chars, size=${result.size_bytes}B`);
    if (result.type === "pdf") {
      console.log(`[PDF] chunks created: 1, context length sent to LLM: ${result.extracted_text.length}`);
    }

    // Update file session for this client
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";
    fileSessionMap.set(clientIp, {
      filename: result.filename,
      type: result.type,
      extractedText: result.extracted_text,
      uploadTime: Date.now(),
    });
    console.log(`[FileSession] stored for ${clientIp}: ${result.filename}`);

    res.json({
      filename: result.filename,
      type: result.type,
      extracted_text: result.extracted_text,
      size_bytes: result.size_bytes,
    });
  }),
);

// ===============================
// GET /api/images/quota — Check remaining image quota
// ===============================
app.get("/api/images/quota", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const info = getQuotaInfo(ip);
  res.json(info);
});

// ===============================
// POST /api/images/generate — Generate image from prompt
// ===============================
app.post(
  "/api/images/generate",
  aiRateLimiter,
  imageQuotaMiddleware,
  asyncHandler(async (req, res) => {
    await getVerifiedUserId(req);
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

    const result = await routeImageGeneration({
      prompt: parsed.data.prompt,
      size: parsed.data.size,
    });

    if (!result.success) {
      console.log(`[IMAGE] endpoint failed prompt="${parsed.data.prompt.slice(0, 40)}..." error="${result.error}"`);
      res.status(502).json({ error: result.error });
      return;
    }

    // Structured output with type field
    const imageUrl = result.image_url
      || (result.image_base64 ? `data:image/png;base64,${result.image_base64}` : undefined);

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const quota = getQuotaInfo(ip);

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
      image_url: result.image_url,
      image_base64: result.image_base64,
    });
  }),
);

// ===============================
// POST /api/charts/generate — Generate chart code from natural language
// ===============================
app.post(
  "/api/charts/generate",
  aiRateLimiter,
  asyncHandler(async (req, res) => {
    await getVerifiedUserId(req);
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

    if (isGuest) {
      const guestResult = await handleChat({
        userMessage,
        recentMessages: parsed.data.context?.recent_messages,
        memories: [],
        modelOverride: GUEST_MODEL_OVERRIDE,
        userId,
      });

      res.json({
        route: "chat",
        reply: guestResult.reply,
        disclaimer: guestResult.disclaimer,
        image: undefined,
        chart: undefined,
        memory: undefined,
        confidence: undefined,
      });
      return;
    }

    const result = await orchestrate({
      userMessage,
      context: {
        recent_messages: parsed.data.context?.recent_messages,
        memories: parsed.data.context?.memories,
        userId,
      },
    });

    res.json({
      route: result.route,
      reply: result.reply,
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

    try {
      const cacheScopedConversationId = rawConversationId
        ? rawConversationId
        : `title-${randomUUID()}`;
      const baseCall = buildTitleGeneratePrompt({
        userMessage: userMessage.slice(0, 500),
        assistantReply: assistantReply.slice(0, 500),
        conversationId: cacheScopedConversationId,
      });
      const call = isGuest
        ? { ...baseCall, user_id: userId, prefer: undefined, model_override: GUEST_MODEL_OVERRIDE }
        : { ...baseCall, user_id: userId };
      const raw = await callLLMAdapter(call);
      const parsed = strictParseJsonObject(raw);
      const title = typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 60)
        : userMessage.slice(0, 50);

      if (!isGuest && rawConversationId) {
        try {
          const userDb = await resolveUserDatabaseOrThrow(userId, "chat.title");
          await initializeUserSessionOrThrow(userDb, userId, "chat.title");
          await updateConversationTitleIfOwned(userDb, userId, rawConversationId, title, "chat.title");
        } catch (titlePersistError) {
          logDbFailure(
            "chat.title.persist",
            userId,
            titlePersistError instanceof Error ? titlePersistError : new Error(String(titlePersistError)),
            { conversationId: rawConversationId },
          );
        }
      }

      res.json({ title });
    } catch {
      // Fallback to truncated user message
      res.json({ title: userMessage.slice(0, 50) });
    }
  }),
);

// ===============================
// GET /api/config — Server capabilities
// ===============================
app.get("/api/config", (_req, res) => {
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
app.get("/api/audit", (_req, res) => {
  const entries = getRecentAuditEntries();
  // Redact IP addresses to prevent information disclosure
  const redacted = entries.map(({ ip, ...rest }) => rest);
  res.json(redacted);
});

// ===============================
// Global error handler
// ===============================
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
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

  console.error("[SentIQGPT] Unhandled error:", err.message);
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  res.status(500).json({ error: "Internal server error." });
});

// ===============================
// Start
// ===============================
const server = app.listen(PORT, () => {
  console.log(`[SentIQGPT v2] Server running on port ${PORT}`);
  console.log(`[SentIQGPT v2] Architecture: Orchestrated Dual-Model (Gemini + Groq)`);
  console.log(`[SentIQGPT v2] LLM Service expected on port ${process.env.LLM_SERVICE_PORT || "3002"}`);
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

// ---- Crash safety net ----
// Prevent stray async throws (e.g. from native addons) from killing the process.
process.on("uncaughtException", (err) => {
  console.error("[SentIQGPT] UNCAUGHT EXCEPTION (kept alive):", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[SentIQGPT] UNHANDLED REJECTION (kept alive):", reason);
});
