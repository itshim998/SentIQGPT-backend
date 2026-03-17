import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import multer from "multer";
import { existsSync } from "fs";
import { resolve as pathResolve } from "path";

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
import { buildContext } from "./context/contextBuilder";

// v2 Orchestrator
import { orchestrate } from "./orchestrator/aiOrchestrator";

import { detectCodeQuery, isMathQuery, selectModelForPrompt } from "./orchestrator/modelRouter";

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
  methods: ["GET", "POST", "OPTIONS"],
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

    const result = await orchestrate({
      userMessage: parsed.data.message,
      context: {
        recent_messages: parsed.data.context?.recent_messages,
        memories: parsed.data.context?.memories,
        file_references: orcFileRefs,
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
// POST /api/chat/stream — SSE streaming chat endpoint
// ===============================
app.post(
  "/api/chat/stream",
  aiRateLimiter,
  asyncHandler(async (req, res) => {
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
    if (isChartRequest(parsed.data.message)) {
      console.log(`[Stream] chart request detected — redirecting to orchestrator`);
      try {
        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: parsed.data.context?.recent_messages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
          },
        });
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
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Stream] chart orchestration failed: ${message}`);
        res.status(500).json({ error: message });
      }
      return;
    }

    // ── Safety gate: math queries use two-model verification via orchestrator ──
    // Math queries need the verification pipeline (deepseek + verifier), which
    // is only available through the orchestrator.  Redirect like chart requests.
    const isCodingQuery = detectCodeQuery(parsed.data.message);
    const isMathReasoningQuery = !isCodingQuery && isMathQuery(parsed.data.message);

    if (isMathReasoningQuery) {
      console.log(`[MathPipeline] streaming math query — redirecting to orchestrator`);
      try {
        // Send SSE headers early so frontend can detect route before answer arrives
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        // Emit route metadata so frontend can show "Reasoning..." indicator
        res.write(`data: ${JSON.stringify({ type: "route", route: "math_reasoning" })}\n\n`);

        const result = await orchestrate({
          userMessage: parsed.data.message,
          context: {
            recent_messages: parsed.data.context?.recent_messages,
            memories: parsed.data.context?.memories,
            file_references: parsed.data.context?.file_references,
          },
        });
        // Return as SSE stream so the frontend handles it uniformly
        if (result.reply) {
          // Stream the verified answer in chunks for smooth typing effect
          const CHUNK_SIZE = 24;
          for (let i = 0; i < result.reply.length; i += CHUNK_SIZE) {
            const chunk = result.reply.slice(i, i + CHUNK_SIZE);
            res.write(`data: ${JSON.stringify({ type: "token", text: chunk })}\n\n`);
          }
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[MathPipeline] streaming orchestration failed: ${message}`);
        res.status(500).json({ error: message });
      }
      return;
    }
    const requestStart = Date.now();
    console.log(`[Latency] user query received`);

    // Set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Track client disconnect
    let clientDisconnected = false;
    req.on("close", () => { clientDisconnected = true; });

    // Always include file_references when present — the frontend only sends
    // the current session file (scoped correctly), so no backend gating needed.
    const fileRefs = parsed.data.context?.file_references;
    const hasFile = Array.isArray(fileRefs) && fileRefs.length > 0;
    const hasImage = hasFile && fileRefs.some((f: { filename?: string }) =>
      /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(f.filename || "")
    );
    if (hasFile) console.log(`[File] stream: ${fileRefs.length} file(s) in context, hasImage: ${hasImage}`);

    const modelOverride = selectModelForPrompt(parsed.data.message, undefined, { hasImage, hasFile });

    // ── Build context (conversation compression + semantic memory search) ──
    const ctx = await buildContext({
      recent_messages: parsed.data.context?.recent_messages,
      memories: parsed.data.context?.memories,
      file_references: fileRefs,
      userMessage: parsed.data.message,
    });

    const chatCtx: ChatContext = {
      userMessage: parsed.data.message,
      recentMessages: ctx.recentMessages,
      memories: ctx.memories,
      fileReferences: ctx.fileReferences,
      conversationSummary: ctx.conversationSummary,
      modelOverride,
    };

    const call = buildChatPrompt(chatCtx);
    console.log(`[Latency] LLM request started (+${Date.now() - requestStart}ms)`);
    console.log(`[Stream] model=${chatCtx.modelOverride} hasFiles=${ctx.hasFileContext} msgLen=${parsed.data.message.length}`);

    // Run memory pipeline in background (non-blocking) — never delays the LLM response
    processMessageForMemory({
      message: parsed.data.message,
      recentMessages: [...ctx.recentMessages],
      existingMemories: [...ctx.memories],
    })
      .then((memResult) => {
        if (memResult.stored) {
          if (!clientDisconnected) {
            const memEvent = JSON.stringify({
              type: "memory",
              memory: {
                stored: true,
                type: memResult.memory?.type,
                summary: memResult.memory?.summary,
                importance: memResult.memory?.importance,
              },
            });
            res.write(`data: ${memEvent}\n\n`);
          }
        }
      })
      .catch((err) => {
        console.log(`[Memory] background pipeline error: ${err instanceof Error ? err.message : err}`);
      });

    try {
      const streamStart = Date.now();
      const stream = await callLLMAdapterStream(call);
      const reader = stream.getReader();
      let tokenCount = 0;

      while (true) {
        if (clientDisconnected) {
          reader.cancel();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        tokenCount++;
        if (tokenCount === 1) {
          console.log(`[Latency] first token streamed (+${Date.now() - requestStart}ms)`);
        }
        res.write(`data: ${JSON.stringify({ type: "token", text: value })}\n\n`);
      }

      if (!clientDisconnected) {
        res.write("data: [DONE]\n\n");
      }
      console.log(`[Latency] response completed (+${Date.now() - requestStart}ms)`);
      console.log(`[Stream] completed: ${tokenCount} chunks in ${Date.now() - streamStart}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Stream] error: ${message}`);
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`);
      }
    } finally {
      res.end();
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
    const parsed = MemoryClassifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const result = await processMessageForMemory({
      message: parsed.data.message,
      recentMessages: parsed.data.recent_messages,
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
    const parsed = MemoryCompressRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(parsed.error) });
      return;
    }

    const result = await compressMemories({
      memories: parsed.data.memories,
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

    const result = await orchestrate({
      userMessage,
      context: {
        recent_messages: parsed.data.context?.recent_messages,
        memories: parsed.data.context?.memories,
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
    const { userMessage, assistantReply } = req.body;

    if (
      typeof userMessage !== "string" || !userMessage.trim() ||
      typeof assistantReply !== "string" || !assistantReply.trim()
    ) {
      res.status(400).json({ error: "userMessage and assistantReply are required." });
      return;
    }

    try {
      const call = buildTitleGeneratePrompt({
        userMessage: userMessage.slice(0, 500),
        assistantReply: assistantReply.slice(0, 500),
      });
      const raw = await callLLMAdapter(call);
      const parsed = strictParseJsonObject(raw);
      const title = typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 60)
        : userMessage.slice(0, 50);

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
    res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    return;
  }
  if (err && err.message && err.message.includes("Multipart")) {
    console.warn(`[SentIQGPT] Multer error: ${err.message}`);
    res.status(400).json({ error: "Invalid file upload. Please try again." });
    return;
  }

  console.error("[SentIQGPT] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error." });
});

// ===============================
// Start
// ===============================
const server = app.listen(PORT, () => {
  console.log(`[SentIQGPT v2] Server running on port ${PORT}`);
  console.log(`[SentIQGPT v2] Architecture: Orchestrated Dual-Model (Gemini + Groq)`);
  console.log(`[SentIQGPT v2] LLM Service expected on port ${process.env.LLM_SERVICE_PORT || "3002"}`);
  console.log(`[SentIQGPT v2] Pollinations key loaded: ${!!(process.env.POLLINATIONS_API_KEY || process.env.FLUX_API_KEY)} (source: ${process.env.POLLINATIONS_API_KEY ? "POLLINATIONS_API_KEY" : process.env.FLUX_API_KEY ? "FLUX_API_KEY" : "NONE"})`);
  console.log(`[SentIQGPT v2] HuggingFace key loaded: ${!!process.env.HUGGINGFACE_API_TOKEN}`);
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
