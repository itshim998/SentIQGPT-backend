import express, { type Request, type Response } from "express";
import { getRequestUser, verifyJWT } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";
import { openChatGenerationSession, claimChatGenerationRequest, heartbeatChatGenerationSession, closeChatGenerationSession } from "./services/chatGenerationSessionService";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

const OPEN_PATH = "/api/chat/generation-sessions";
const CLAIM_PATH = "/api/chat/generation-sessions/:sessionId/claim-request";
const HEARTBEAT_PATH = "/api/chat/generation-sessions/:sessionId/heartbeat";
const CLOSE_PATH = "/api/chat/generation-sessions/:sessionId/close";

function anonymousId(req: Request): string | null {
  const value = req.get("X-SentIQ-Anonymous-Id");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function context(req: Request) {
  const user = getRequestUser(req);
  const userId = user?.sub && !user.isGuest ? String(user.sub) : null;
  const userDb = userId ? await getOrAssignUserDatabase(userId) : null;
  return { user, userId, userDb, anonymousId: anonymousId(req) };
}

export function installSessionRoutes(app: any) {
  if (!app || app.__sentiqSessionRoutesInstalled) return;
  app.__sentiqSessionRoutesInstalled = true;

  app.post(OPEN_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const { userId, userDb, anonymousId: anon } = await context(req);
      if (!userDb) {
        return res.status(200).json({ generation_session_id: null, status: "open", client_only: true });
      }
      const result = await openChatGenerationSession(userDb, userId, anon);
      if (result.error || !result.data) throw result.error || new Error("Unable to open generation session");
      return res.status(201).json({ generation_session_id: result.data.id, session: result.data });
    } catch (err: any) {
      console.warn("[generation_sessions] open error (falling back to client_only):", err?.message || err);
      return res.status(200).json({ generation_session_id: null, status: "open", client_only: true, degraded: true });
    }
  });

  app.post(CLAIM_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const { userId, userDb } = await context(req);
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required", code: "generation_session_id_required" });
      }
      if (!userDb) {
        return res.status(200).json({ generation_session_id: sessionId, status: "claimed", client_only: true });
      }
      const clientRequestId = typeof req.body?.client_request_id === "string"
        ? req.body.client_request_id.trim()
        : typeof req.body?.clientRequestId === "string"
          ? req.body.clientRequestId.trim()
          : "";
      if (!clientRequestId) {
        return res.status(400).json({ error: "clientRequestId is required", code: "client_request_id_required" });
      }
      const result = await claimChatGenerationRequest(userDb, sessionId, String(userId), clientRequestId);
      if (result.error || !result.data) throw result.error || new Error("Generation request claim failed");
      return res.json({ generation_session_id: sessionId, client_request_id: clientRequestId, claimed: true });
    } catch (err: any) {
      const errorMessage = err?.message || err?.code || String(err);
      console.warn("[generation_sessions] claim-request error (falling back to client_only):", {
        sessionId: req.params.sessionId,
        error: errorMessage,
      });
      return res.status(200).json({ generation_session_id: req.params.sessionId, status: "claimed", client_only: true, degraded: true });
    }
  });

  app.post(HEARTBEAT_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const { userId, userDb, anonymousId: anon } = await context(req);
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required", code: "generation_session_id_required" });
      }
      if (!userDb) {
        return res.status(200).json({ generation_session_id: sessionId, status: "open", client_only: true });
      }
      const result = await heartbeatChatGenerationSession(userDb, sessionId, userId, anon);
      if (result.error || !result.data) throw result.error || new Error("Generation session heartbeat failed");
      return res.json({ generation_session_id: result.data.id, session: result.data });
    } catch (err: any) {
      console.warn("[generation_sessions] heartbeat error:", {
        sessionId: req.params.sessionId,
        error: err?.message || err?.code || String(err),
      });
      return res.status(409).json({ error: "Generation session is no longer active", code: "generation_session_inactive" });
    }
  });

  app.post(CLOSE_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const { userId, userDb, anonymousId: anon } = await context(req);
      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "sessionId is required", code: "generation_session_id_required" });
      }
      if (!userDb) {
        return res.status(200).json({ generation_session_id: sessionId, status: "closed", client_only: true });
      }
      const result = await closeChatGenerationSession(userDb, sessionId, userId, anon);
      if (result.error || !result.data) throw result.error || new Error("Generation session close failed");
      return res.json({ generation_session_id: result.data.id, session: result.data, close_pending: true });
    } catch (err: any) {
      console.warn("[generation_sessions] close error:", {
        sessionId: req.params.sessionId,
        error: err?.message || err?.code || String(err),
      });
      return res.status(409).json({ error: "Generation session is no longer active", code: "generation_session_inactive" });
    }
  });
}

let installed = false;
function patchApplicationListen() {
  if (installed) return;
  installed = true;
  const application = (express as any).application;
  if (!application) return;
  const originalListen = application.listen;
  application.listen = function patchedListen(this: any, ...args: any[]) {
    installSessionRoutes(this);
    return originalListen.apply(this, args);
  };
}

patchApplicationListen();

// Expose coordinator helper for session cancellation contract reference
export const requestSessionGenerationCancel = (id: string) => chatGenerationTaskCoordinator.requestCancel(id);

export const CHAT_GENERATION_SESSION_ENDPOINTS = Object.freeze({ OPEN_PATH, CLAIM_PATH, HEARTBEAT_PATH, CLOSE_PATH });
