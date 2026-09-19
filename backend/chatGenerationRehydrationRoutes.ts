import express, { type Request, type Response } from "express";
import { getRequestUser, verifyJWT } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";

const PATH = "/api/conversations/:conversationId/generations";

export async function handleConversationGenerations(req: Request, res: Response) {
  try {
    const requestUser = getRequestUser(req);
    if (!requestUser?.sub || requestUser.isGuest) {
      return res.json({ conversation_id: String(req.params.conversationId || ""), generations: [] });
    }
    const userId = String(requestUser.sub);
    const conversationId = String(req.params.conversationId || "").trim();
    if (!conversationId) {
      return res.status(400).json({ error: "conversationId is required", code: "conversation_id_required" });
    }
    const userDb = await getOrAssignUserDatabase(userId);
    if (!userDb) {
      return res.status(503).json({ error: "User database unavailable", code: "user_database_unavailable" });
    }
    const result = await userDb
      .from("chat_generations")
      .select("id, conversation_id, user_id, client_request_id, status, execution_mode, model_route, started_at, completed_at, failed_at, cancelled_at, error_code, partial_text, tokens_generated, last_event_sequence, created_at, updated_at")
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (result.error) throw result.error;
    return res.json({ conversation_id: conversationId, generations: Array.isArray(result.data) ? result.data : [] });
  } catch (error) {
    console.warn(`[GenerationRehydration] Failed conversation generation lookup: ${error instanceof Error ? error.message : String(error)}`);
    return res.status(500).json({ error: "Unable to load generation state.", code: "generation_rehydration_failed" });
  }
}

export function installRehydrationRoutes(app: any) {
  if (!app || app.__sentiqRehydrationRoutesInstalled) return;
  app.__sentiqRehydrationRoutesInstalled = true;
  app.get(PATH, verifyJWT({ allowGuest: true }), handleConversationGenerations);
}

let installed = false;
function patchApplicationListen() {
  if (installed) return;
  installed = true;
  const application = (express as any).application;
  if (!application) return;
  const originalListen = application.listen;
  application.listen = function patchedListen(this: any, ...args: any[]) {
    installRehydrationRoutes(this);
    return originalListen.apply(this, args);
  };
}

patchApplicationListen();

export const CHAT_GENERATION_REHYDRATION_ENDPOINT = PATH;
