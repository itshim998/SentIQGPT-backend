import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { verifyJWT, getRequestUser } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";
import { resolveConversationForTurn } from "./services/conversationService";
import { createChatGeneration, getChatGenerationByClientRequestId, getChatGenerationById, requestChatGenerationCancel, updateChatGenerationExecutionSnapshot, type ChatGenerationRow } from "./services/chatGenerationService";
import { getGuestGenerationDatabase, getGuestGenerationOwnerKeyForRequest } from "./services/guestGenerationStore";
import { ChatRequestSchema } from "./validation/schemas";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";
import { registerChatGenerationExecutor, getChatGenerationExecutor } from "./services/chatGenerationExecutor";
import { runGeneration, type GenerationExecutorHandler } from "./services/generationRunner";

const STREAM_PATH = "/api/chat/stream";
const BUFFERED_PATH = "/api/chat";
const EVENTS_PATH = "/api/chat/generations/:generationId/events";
const STATUS_PATH = "/api/chat/generations/:generationId";
const CANCEL_PATH = "/api/chat/generations/:generationId/cancel";
const CANCEL_ALL_PATH = "/api/chat/generations/cancel-all";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let bootstrapInstalled = false;
function isUuid(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value.trim()); }
function normalizeRequestId(value: unknown): string { const normalized = typeof value === "string" ? value.trim() : ""; return normalized || randomUUID(); }
function normalizeGenerationId(value: unknown): string { return isUuid(value) ? value.trim() : randomUUID(); }
function compactExecutionSnapshot(body: Record<string, unknown>): Record<string, unknown> {
  const context = body.context && typeof body.context === "object" && !Array.isArray(body.context) ? body.context as Record<string, unknown> : undefined;
  return { version: 1, message: typeof body.message === "string" ? body.message : "", conversationId: typeof body.conversationId === "string" ? body.conversationId : body.conversation_id, clientRequestId: typeof body.clientRequestId === "string" ? body.clientRequestId : body.client_request_id, generationId: typeof body.generationId === "string" ? body.generationId : body.generation_id, executionMode: typeof body.executionMode === "string" ? body.executionMode : body.execution_mode, context: context ? { recent_messages: Array.isArray(context.recent_messages) ? context.recent_messages.slice(-50) : [], memories: Array.isArray(context.memories) ? context.memories.slice(-100) : [], file_references: Array.isArray(context.file_references) ? context.file_references.slice(-10).map((file: any) => ({ filename: file?.filename, extractedText: typeof file?.extractedText === "string" ? file.extractedText.slice(0, 16000) : "", analysis_id: file?.analysis_id, document_id: file?.document_id, sourceDocumentId: file?.sourceDocumentId, size_bytes: file?.size_bytes, mime_type: file?.mime_type })) : [], web_search_mode: context.web_search_mode, trustedProfile: context.trustedProfile, recovery_image_attachments_omitted: Array.isArray(context.image_attachments) && context.image_attachments.length > 0 } : undefined };
}
function buildRequestSnapshot(request: Request) { const requestUser = getRequestUser(request); return { persisted: compactExecutionSnapshot(request.body as Record<string, unknown>), live: { ...(request.body as Record<string, unknown>) }, originalUrl: request.originalUrl, user: requestUser ? { sub: requestUser.sub, isGuest: Boolean(requestUser.isGuest) } : null }; }
async function resolveUserDatabase(requestUser: any): Promise<any | null> { if (!requestUser?.sub || requestUser.isGuest) return null; return getOrAssignUserDatabase(requestUser.sub); }
function requireConversationId(value: unknown, source: string): string { const normalized = typeof value === "string" ? value.trim() : ""; if (!normalized) throw new Error(`${source} conversationId is required`); return normalized; }
async function prepareGeneration(request: Request) {
  const parsed = ChatRequestSchema.safeParse(request.body); if (!parsed.success) { const error = new Error("Invalid chat request"); (error as any).statusCode = 400; (error as any).details = parsed.error.flatten(); throw error; }
  const requestUser = getRequestUser(request); const authenticatedUser = Boolean(requestUser && !requestUser.isGuest); const clientRequestId = normalizeRequestId(parsed.data.clientRequestId); const requestedGenerationId = normalizeGenerationId(parsed.data.generationId); let conversationId = typeof parsed.data.conversationId === "string" ? parsed.data.conversationId.trim() || null : null; const executionMode = parsed.data.executionMode; const snapshot = buildRequestSnapshot(request);
  if (authenticatedUser) {
    const userId = String(requestUser!.sub); const userDb = await resolveUserDatabase(requestUser); if (!userDb) throw new Error("User database unavailable");
    const initialized = await userDb.rpc("initialize_user_session", { p_user_id: userId }); if (initialized.error) throw initialized.error;
    const resolved = await resolveConversationForTurn(userDb, { userId, clientRequestId, conversationId, title: "New Chat" }); if (resolved.error || !resolved.data?.conversation_id) throw resolved.error || new Error("Unable to resolve conversation"); conversationId = requireConversationId(resolved.data.conversation_id, "Resolved");
    const existing = await getChatGenerationByClientRequestId(userDb, userId, clientRequestId); if (existing.error) throw existing.error;
    let generation: ChatGenerationRow;
    if (existing.data) {
      generation = existing.data;
      if (Object.keys(generation.execution_snapshot || {}).length === 0) { const updated = await updateChatGenerationExecutionSnapshot(userDb, { userId, generationId: generation.id, executionSnapshot: snapshot.persisted }); if (updated.error) throw updated.error; if (updated.data) generation = updated.data; }
    } else {
      const created = await createChatGeneration(userDb, { conversationId, userId, clientRequestId, generationId: requestedGenerationId, executionMode, executionSnapshot: snapshot.persisted }); if (created.error || !created.data) throw created.error || new Error("Unable to create chat generation"); generation = created.data;
    }
    conversationId = requireConversationId(generation.conversation_id, "Generation");
    request.body = { ...request.body, conversationId, conversation_id: conversationId, clientRequestId: generation.client_request_id, client_request_id: generation.client_request_id, generationId: generation.id, generation_id: generation.id, executionMode: generation.execution_mode ?? executionMode, execution_mode: generation.execution_mode ?? executionMode };
    return { requestUser, userId, userDb, generationId: generation.id, clientRequestId: generation.client_request_id || clientRequestId, conversationId, status: generation.status, generation, persistedSnapshot: snapshot.persisted, liveSnapshot: { body: request.body as Record<string, unknown>, headers: {}, originalUrl: snapshot.originalUrl, user: snapshot.user } };
  }

  if (!requestUser?.isGuest) throw new Error("Guest authentication context unavailable");
  const guestOwnerKey = getGuestGenerationOwnerKeyForRequest(request);
  const userDb = getGuestGenerationDatabase(guestOwnerKey);
  const userId = guestOwnerKey;
  conversationId = requireConversationId(conversationId || randomUUID(), "Guest");
  const existing = await getChatGenerationByClientRequestId(userDb, userId, clientRequestId); if (existing.error) throw existing.error;
  let generation: ChatGenerationRow;
  if (existing.data) {
    generation = existing.data;
    if (Object.keys(generation.execution_snapshot || {}).length === 0) { const updated = await updateChatGenerationExecutionSnapshot(userDb, { userId, generationId: generation.id, executionSnapshot: snapshot.persisted }); if (updated.error) throw updated.error; if (updated.data) generation = updated.data; }
  } else {
    const created = await createChatGeneration(userDb, { conversationId, userId, clientRequestId, generationId: requestedGenerationId, executionMode, executionSnapshot: snapshot.persisted }); if (created.error || !created.data) throw created.error || new Error("Unable to create guest chat generation"); generation = created.data;
  }
  conversationId = requireConversationId(generation.conversation_id, "Generation");
  request.body = { ...request.body, conversationId, conversation_id: conversationId, clientRequestId: generation.client_request_id, client_request_id: generation.client_request_id, generationId: generation.id, generation_id: generation.id, executionMode: generation.execution_mode ?? executionMode, execution_mode: generation.execution_mode ?? executionMode };
  return { requestUser, userId, userDb, generationId: generation.id, clientRequestId: generation.client_request_id || clientRequestId, conversationId, status: generation.status, generation, persistedSnapshot: snapshot.persisted, liveSnapshot: { body: request.body as Record<string, unknown>, headers: {}, originalUrl: snapshot.originalUrl, user: snapshot.user } };
}
async function resolveOwnedGeneration(request: Request, generationId: string) {
  const requestUser = getRequestUser(request);
  if (requestUser?.isGuest) {
    const userId = getGuestGenerationOwnerKeyForRequest(request); const userDb = getGuestGenerationDatabase(userId);
    const result = await getChatGenerationById(userDb, userId, generationId); if (result.error) throw result.error;
    return { requestUser, userId, userDb, generationId, generation: result.data, task: chatGenerationTaskCoordinator.get(generationId) };
  }
  const userId = String(requestUser?.sub || "guest");
  if (!requestUser) { const task = chatGenerationTaskCoordinator.get(generationId); if (!task) return { requestUser, userId, userDb: null, generationId, generation: null, task: null }; return { requestUser, userId, userDb: null, generationId, generation: task.generation ?? null, task }; }
  const userDb = await resolveUserDatabase(requestUser); if (!userDb) throw new Error("User database unavailable"); const initialized = await userDb.rpc("initialize_user_session", { p_user_id: userId }); if (initialized.error) throw initialized.error; const result = await getChatGenerationById(userDb, userId, generationId); if (result.error) throw result.error; return { requestUser, userId, userDb, generationId, generation: result.data, task: chatGenerationTaskCoordinator.get(generationId) };
}
async function startGeneration(_legacyFinalHandler: GenerationExecutorHandler, context: Awaited<ReturnType<typeof prepareGeneration>>): Promise<void> {
  const existing = chatGenerationTaskCoordinator.get(context.generationId); if (existing?.runPromise) return existing.runPromise; if (["completed", "failed", "cancelled"].includes(context.status)) return;
  if (!getChatGenerationExecutor()) registerChatGenerationExecutor(_legacyFinalHandler);
  const task = chatGenerationTaskCoordinator.start({ generationId: context.generationId, clientRequestId: context.clientRequestId, generationSessionId: context.generation.generation_session_id, conversationId: context.conversationId, userId: context.userId, userDb: context.userDb, generation: context.generation, liveExecutionSnapshot: context.liveSnapshot });
  if (task.runPromise) return task.runPromise; return runGeneration(context.generationId);
}
function formatGenerationEvent(event: Record<string, unknown>): string { return `data: ${JSON.stringify(event)}\n\n`; }
function openGenerationSubscription(response: Response, generationId: string, context: any, afterSequence = 0) {
  response.status(200); response.setHeader("Content-Type", "text/event-stream; charset=utf-8"); response.setHeader("Cache-Control", "no-cache, no-transform"); response.setHeader("Connection", "keep-alive"); response.setHeader("X-Accel-Buffering", "no"); response.flushHeaders?.();
  const emit = (event: Record<string, unknown>) => { if (!(response as any).writableEnded) { try { response.write(formatGenerationEvent(event)); } catch {} } }; const emitDoneAndClose = () => { if (!(response as any).writableEnded) { try { response.write("data: [DONE]\n\n"); response.end(); } catch {} } };
  let closed = false; let unsubscribe: (() => void) | null = null; const heartbeat = setInterval(() => { if (!closed && !(response as any).writableEnded) { try { response.write(": keepalive\n\n"); } catch {} } }, 15000); heartbeat.unref?.(); const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe?.(); unsubscribe = null; }; response.once("close", cleanup); response.once("finish", cleanup);
  void (async () => {
    let persisted = context.generation;
    if (context.userDb) { const result = await getChatGenerationById(context.userDb, context.userId, generationId); if (result.error) throw result.error; persisted = result.data; if (!persisted) throw Object.assign(new Error("Generation not found"), { code: "generation_not_found" }); }
    const task = context.userDb && persisted ? chatGenerationTaskCoordinator.start({ generationId, clientRequestId: persisted.client_request_id, generationSessionId: persisted.generation_session_id, conversationId: persisted.conversation_id, userId: context.userId, userDb: context.userDb, generation: persisted }) : chatGenerationTaskCoordinator.get(generationId);
    if (context.userDb && persisted && task) { const restartable = ["queued", "running", "generating", "persisting", "waiting_for_tool", "cancel_requested"].includes(String(persisted.status)); if (!task.terminal && !task.runPromise && restartable) void runGeneration(generationId).catch((error) => { void chatGenerationTaskCoordinator.failed(generationId, String((error as any)?.code || "generation_restart_failed")); }); }
    if (!task) { if (["completed", "failed", "cancelled"].includes(String(persisted?.status))) { emit({ type: "generation_snapshot", generation_id: generationId, conversation_id: persisted?.conversation_id ?? null, sequence: Number(persisted?.last_event_sequence ?? 0), status: persisted?.status, partial_text: persisted?.partial_text ?? "", terminal: true, error_code: persisted?.error_code ?? null }); emitDoneAndClose(); } return; }
    const cursor = Math.max(0, afterSequence);
    const subscriptionAfter = cursor > 0 ? cursor : Number(persisted?.last_event_sequence ?? task.sequence);
    unsubscribe = chatGenerationTaskCoordinator.subscribe(generationId, (event) => { emit(event); if (["generation_completed", "generation_failed", "generation_cancelled"].includes(String(event.type))) emitDoneAndClose(); }, subscriptionAfter);
    if (cursor === 0) emit(await chatGenerationTaskCoordinator.snapshot(generationId, persisted));
    if (task.terminal && cursor >= Number(persisted?.last_event_sequence ?? task.sequence)) emitDoneAndClose();
  })().catch((error) => { emit({ type: "error", code: String((error as any)?.code || "generation_subscription_failed"), error: "Generation subscription failed." }); emitDoneAndClose(); });
}
function installGenerationRoutes(app: any) {
  if (app.__sentiqGenerationRoutesInstalled) return; app.__sentiqGenerationRoutesInstalled = true; const application = app; const originalPost = application.post;
  app.get(EVENTS_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => { try { const context = await resolveOwnedGeneration(req, String(req.params.generationId || "")); if (!context.generation && !context.task) return res.status(404).json({ error: "Generation not found.", code: "generation_not_found" }); const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0); openGenerationSubscription(res, context.generationId, context, Number.isFinite(after) ? Math.max(0, after) : 0); } catch { res.status(500).json({ error: "Unable to subscribe to generation.", code: "generation_subscription_failed" }); } });
  app.get(STATUS_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => { try { const context = await resolveOwnedGeneration(req, String(req.params.generationId || "")); if (context.task) { res.json(await chatGenerationTaskCoordinator.snapshot(context.generationId, context.generation)); return; } if (!context.generation) return res.status(404).json({ error: "Generation not found", code: "generation_not_found" }); res.json(context.generation); } catch { res.status(500).json({ error: "Unable to load generation status", code: "generation_status_failed" }); } });
  app.post(CANCEL_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => { try { const generationId = String(req.params.generationId || "").trim(); if (!generationId) return res.status(400).json({ error: "generationId is required" }); const context = await resolveOwnedGeneration(req, generationId); if (!context.generation && !context.task) return res.status(404).json({ error: "Generation not found", code: "generation_not_found" }); if (context.userDb) { const cancel = await requestChatGenerationCancel(context.userDb, context.userId, generationId); if (cancel.error) throw cancel.error; } const requested = await chatGenerationTaskCoordinator.requestCancel(generationId); res.status(202).json({ generation_id: generationId, status: requested ? "cancel_requested" : context.generation?.status ?? "cancel_requested" }); } catch { res.status(500).json({ error: "Unable to cancel generation", code: "generation_cancel_failed" }); } });
  app.post(CANCEL_ALL_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    const intent = typeof req.body?.intent === "string" ? req.body.intent : "";
    if (intent !== "explicit_bulk_stop") return res.status(202).json({ results: [], ignored: true, reason: "bulk_cancellation_requires_explicit_intent" });
    const ids = Array.isArray(req.body?.generation_ids) ? req.body.generation_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean).slice(0, 32) : [];
    const results: Array<{ generation_id: string; status: string }> = [];
    for (const generationId of ids) { try { const context = await resolveOwnedGeneration(req, generationId); if (!context.generation && !context.task) { results.push({ generation_id: generationId, status: "not_found" }); continue; } if (context.userDb) await requestChatGenerationCancel(context.userDb, context.userId, generationId); const requested = await chatGenerationTaskCoordinator.requestCancel(generationId); results.push({ generation_id: generationId, status: requested ? "cancel_requested" : context.generation?.status ?? "cancel_requested" }); } catch { results.push({ generation_id: generationId, status: "unavailable" }); } }
    res.json({ results });
  });
  void originalPost;
}
function installCompatibilityRouteInterceptors() {
  if (bootstrapInstalled) return; bootstrapInstalled = true; const application = (express as any).application; const originalPost = application.post; const originalListen = application.listen;
  application.post = function patchedPost(path: string, ...handlers: any[]) {
    if (path === STREAM_PATH || path === BUFFERED_PATH) { const legacyFinalHandler = handlers[handlers.length - 1] as GenerationExecutorHandler; const middleware = handlers.slice(0, -1); const replacement = async (req: Request, res: Response, next: NextFunction) => { try { const context = await prepareGeneration(req); if (!chatGenerationTaskCoordinator.has(context.generationId) && !["completed", "failed", "cancelled"].includes(context.status)) void startGeneration(legacyFinalHandler, context).catch(async (error) => { await chatGenerationTaskCoordinator.failed(context.generationId, String((error as any)?.code || "generation_start_failed")); }); if (path === BUFFERED_PATH) { res.status(202).json({ generation_id: context.generationId, conversation_id: context.conversationId, client_request_id: context.clientRequestId, status: context.status === "completed" ? "completed" : context.status === "queued" ? "queued" : "running" }); return; } const after = Number(req.headers["last-event-id"] ?? req.query?.after ?? 0); openGenerationSubscription(res, context.generationId, context, Number.isFinite(after) ? Math.max(0, after) : 0); } catch (error) { next(error); } }; return originalPost.call(this, path, ...middleware, replacement); }
    return originalPost.call(this, path, ...handlers);
  };
  application.listen = function patchedListen(this: any, ...args: any[]) { installGenerationRoutes(this); return originalListen.apply(this, args); };
}
installCompatibilityRouteInterceptors();
