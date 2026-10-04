import type { Express, Request, RequestHandler, Response } from "express";
import { getRequestUser } from "../middleware/auth";
import { LiveSessionError, LiveSessionService, type LiveTranscriptTurn } from "./liveSessionService";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_TURNS = 100;
const MAX_TRANSCRIPT_TEXT_CHARS = 4_000;
const MAX_TRANSCRIPT_TOTAL_CHARS = 80_000;
const MAX_SUMMARY_CHARS = 12_000;

function asyncRoute(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

function normalizeOptionalUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new LiveSessionError("Invalid conversation id.", "live_invalid_request", 400);
  }
  return normalized;
}

function normalizeTranscript(value: unknown): LiveTranscriptTurn[] {
  if (!Array.isArray(value)) {
    throw new LiveSessionError("Transcript must be an array.", "live_invalid_request", 400);
  }
  const transcript: LiveTranscriptTurn[] = [];
  let totalChars = 0;
  for (const rawTurn of value.slice(0, MAX_TRANSCRIPT_TURNS)) {
    const role = rawTurn?.role === "assistant" ? "assistant" : rawTurn?.role === "user" ? "user" : null;
    const text = typeof rawTurn?.text === "string"
      ? rawTurn.text.replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_TEXT_CHARS)
      : "";
    if (!role || !text) continue;
    totalChars += text.length;
    if (totalChars > MAX_TRANSCRIPT_TOTAL_CHARS) {
      throw new LiveSessionError("Transcript is too large.", "live_invalid_request", 413);
    }
    transcript.push({ role, text });
  }
  return transcript;
}

function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_SUMMARY_CHARS) : undefined;
}

function sendRouteError(error: unknown, res: Response): boolean {
  if (!(error instanceof LiveSessionError)) return false;
  if (error.retryAfterSeconds) res.setHeader("Retry-After", String(error.retryAfterSeconds));
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

export function registerLiveRoutes(app: Express, dependencies: {
  service: LiveSessionService;
  requireAuth: RequestHandler;
  statusAuth?: RequestHandler;
  tokenRateLimiter?: RequestHandler;
}): void {
  const statusMiddleware = dependencies.statusAuth ? [dependencies.statusAuth] : [];
  app.get(
    "/api/live/status",
    ...statusMiddleware,
    asyncRoute(async (req, res) => {
      const requestUser = (req as Request & {
        user?: { sub?: string; isGuest?: boolean };
      }).user;
      const userId = requestUser?.sub && !requestUser.isGuest ? requestUser.sub : undefined;
      res.json(await dependencies.service.getStatus(userId));
    }),
  );

  const tokenMiddleware = dependencies.tokenRateLimiter
    ? [dependencies.requireAuth, dependencies.tokenRateLimiter]
    : [dependencies.requireAuth];

  app.post(
    "/api/live/session-token",
    ...tokenMiddleware,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        const sourceConversationId = normalizeOptionalUuid(
          req.body?.sourceConversationId
          ?? req.body?.source_conversation_id
          ?? req.body?.conversationId
          ?? req.body?.conversation_id,
        );
        const response = await dependencies.service.createSession({
          userId: requestUser.sub,
          sourceConversationId,
          conversationId: sourceConversationId,
        });
        res.status(201).json(response);
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );

  app.post(
    "/api/live/session/:sessionId/started",
    dependencies.requireAuth,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        const result = await dependencies.service.markSessionStarted({
          userId: requestUser.sub,
          sessionId: normalizeOptionalUuid(req.params.sessionId) || "",
        });
        res.json({ success: true, ...result });
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );

  app.post(
    "/api/live/session/:sessionId/commit",
    dependencies.requireAuth,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        const result = await dependencies.service.commitSession({
          userId: requestUser.sub,
          sessionId: normalizeOptionalUuid(req.params.sessionId) || "",
          transcript: normalizeTranscript(req.body?.transcript),
          summary: normalizeSummary(req.body?.summary),
        });
        res.json({ success: true, ...result });
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );

  app.post(
    "/api/live/session/:sessionId/end",
    dependencies.requireAuth,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        const result = await dependencies.service.endSession({
          userId: requestUser.sub,
          sessionId: normalizeOptionalUuid(req.params.sessionId) || "",
          reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        });
        res.json({ success: true, ...result });
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );

  app.post(
    "/api/live/session/:sessionId/report-error",
    dependencies.requireAuth,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        dependencies.service.reportClientError({
          userId: requestUser.sub,
          sessionId: normalizeOptionalUuid(req.params.sessionId) || "",
          errorType: typeof req.body?.errorType === "string" ? req.body.errorType : "unknown",
          code: typeof req.body?.code === "number" ? req.body.code : undefined,
          reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
        });
        res.json({ success: true });
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );
  app.post(
    "/api/live/session/:sessionId/resume-token",
    dependencies.requireAuth,
    asyncRoute(async (req, res) => {
      try {
        const requestUser = getRequestUser(req);
        const result = await dependencies.service.getResumeToken({
          userId: requestUser.sub,
          sessionId: normalizeOptionalUuid(req.params.sessionId) || "",
        });
        res.json({ success: true, ...result });
      } catch (error) {
        if (!sendRouteError(error, res)) throw error;
      }
    }),
  );
}
