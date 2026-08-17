import express, { type Request, type Response } from "express";
import { getRequestUser } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";
import { openChatGenerationSession, heartbeatChatGenerationSession, closeChatGenerationSession } from "./services/chatGenerationSessionService";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

const OPEN_PATH = "/api/chat/generation-sessions";
const HEARTBEAT_PATH = "/api/chat/generation-sessions/:sessionId/heartbeat";
const CLOSE_PATH = "/api/chat/generation-sessions/:sessionId/close";
let installed = false;
function anonymousId(req: Request): string | null { const value = req.get("X-SentIQ-Anonymous-Id"); return typeof value === "string" && value.trim() ? value.trim() : null; }
async function context(req: Request) {
  const user = getRequestUser(req);
  const userId = user?.sub && !user.isGuest ? String(user.sub) : null;
  const userDb = userId ? await getOrAssignUserDatabase(userId) : null;
  return { user, userId, userDb, anonymousId: anonymousId(req) };
}
function patchRoutes() {
  if (installed) return; installed = true;
  const application = (express as any).application; const originalPost = application.post;
  application.post = function patchedPost(path: string, ...handlers: any[]) {
    if (path === OPEN_PATH) {
      const middleware = handlers.slice();
      const replacement = async (req: Request, res: Response) => {
        try {
          const { userId, userDb, anonymousId: anon } = await context(req);
          if (!userDb) return res.status(200).json({ session_id: null, status: "open", client_only: true });
          const result = await openChatGenerationSession(userDb, userId, anon);
          if (result.error || !result.data) throw result.error || new Error("Unable to open generation session");
          return res.status(201).json({ generation_session_id: result.data.id, session: result.data });
        } catch { return res.status(500).json({ error: "Unable to open generation session", code: "generation_session_open_failed" }); }
      };
      return originalPost.call(this, path, ...middleware, replacement);
    }
    if (path === HEARTBEAT_PATH || path === CLOSE_PATH) {
      const middleware = handlers.slice();
      const replacement = async (req: Request, res: Response) => {
        try {
          const { userId, userDb, anonymousId: anon } = await context(req);
          const sessionId = String(req.params.sessionId || "").trim();
          if (!sessionId) return res.status(400).json({ error: "sessionId is required", code: "generation_session_id_required" });
          if (!userDb) return res.json({ generation_session_id: sessionId, status: path === CLOSE_PATH ? "closed" : "open", client_only: true });
          if (path === CLOSE_PATH) {
            const result = await closeChatGenerationSession(userDb, sessionId, userId, anon);
            if (result.error || !result.data) throw result.error || new Error("Generation session close failed");
            const { data: affected } = await userDb.from("chat_generations").select("id").eq("user_id", userId).eq("generation_session_id", sessionId).not("status", "in", "(completed,failed,cancelled)");
            for (const row of affected || []) await chatGenerationTaskCoordinator.requestCancel(String(row.id));
            return res.json({ generation_session_id: result.data.id, session: result.data, cancelled_generation_ids: (affected || []).map((row: any) => row.id) });
          }
          const result = await heartbeatChatGenerationSession(userDb, sessionId, userId, anon);
          if (result.error || !result.data) throw result.error || new Error("Generation session heartbeat failed");
          return res.json({ generation_session_id: result.data.id, session: result.data });
        } catch { return res.status(409).json({ error: "Generation session is no longer active", code: "generation_session_inactive" }); }
      };
      return originalPost.call(this, path, ...middleware, replacement);
    }
    return originalPost.call(this, path, ...handlers);
  };
}
patchRoutes();
export const CHAT_GENERATION_SESSION_ENDPOINTS = Object.freeze({ OPEN_PATH, HEARTBEAT_PATH, CLOSE_PATH });
