import express, { type Request, type Response } from "express";
import { getRequestUser } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";
import { openChatGenerationSession, claimChatGenerationRequest, heartbeatChatGenerationSession, closeChatGenerationSession } from "./services/chatGenerationSessionService";

const OPEN_PATH = "/api/chat/generation-sessions";
const CLAIM_PATH = "/api/chat/generation-sessions/:sessionId/claim-request";
const HEARTBEAT_PATH = "/api/chat/generation-sessions/:sessionId/heartbeat";
const CLOSE_PATH = "/api/chat/generation-sessions/:sessionId/close";
let installed = false;

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

function patchRoutes() {
  if (installed) return;
  installed = true;
  const application = (express as any).application;
  const originalPost = application.post;

  application.post = function patchedPost(path: string, ...handlers: any[]) {
    if (path !== OPEN_PATH && path !== CLAIM_PATH && path !== HEARTBEAT_PATH && path !== CLOSE_PATH) {
      return originalPost.call(this, path, ...handlers);
    }

    const middleware = handlers.slice();
    const replacement = async (req: Request, res: Response) => {
      try {
        const { userId, userDb, anonymousId: anon } = await context(req);
        const sessionId = String(req.params.sessionId || "").trim();

        if (path !== OPEN_PATH && !sessionId) {
          return res.status(400).json({ error: "sessionId is required", code: "generation_session_id_required" });
        }
        if (!userDb) {
          return res.status(200).json({ generation_session_id: sessionId || null, status: path === CLOSE_PATH ? "closed" : "open", client_only: true });
        }

        if (path === OPEN_PATH) {
          const result = await openChatGenerationSession(userDb, userId, anon);
          if (result.error || !result.data) throw result.error || new Error("Unable to open generation session");
          return res.status(201).json({ generation_session_id: result.data.id, session: result.data });
        }

        if (path === CLAIM_PATH) {
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
        }

        if (path === CLOSE_PATH) {
          // Close is intentionally graceful. It starts a short server-side grace
          // window so a page reload can heartbeat and reopen the same session.
          const result = await closeChatGenerationSession(userDb, sessionId, userId, anon);
          if (result.error || !result.data) throw result.error || new Error("Generation session close failed");
          return res.json({ generation_session_id: result.data.id, session: result.data, close_pending: true });
        }

        const result = await heartbeatChatGenerationSession(userDb, sessionId, userId, anon);
        if (result.error || !result.data) throw result.error || new Error("Generation session heartbeat failed");
        return res.json({ generation_session_id: result.data.id, session: result.data });
      } catch {
        return res.status(409).json({ error: "Generation session is no longer active", code: "generation_session_inactive" });
      }
    };

    return originalPost.call(this, path, ...middleware, replacement);
  };
}

patchRoutes();
export const CHAT_GENERATION_SESSION_ENDPOINTS = Object.freeze({ OPEN_PATH, CLAIM_PATH, HEARTBEAT_PATH, CLOSE_PATH });
