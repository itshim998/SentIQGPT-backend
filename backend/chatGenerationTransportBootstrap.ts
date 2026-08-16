import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { verifyJWT, getRequestUser } from "./middleware/auth";
import { getOrAssignUserDatabase } from "./dbRouter";
import { resolveConversationForTurn } from "./services/conversationService";
import {
  createChatGeneration,
  getChatGenerationByClientRequestId,
  getChatGenerationById,
  requestChatGenerationCancel,
} from "./services/chatGenerationService";
import { ChatRequestSchema } from "./validation/schemas";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";

const STREAM_PATH = "/api/chat/stream";
const BUFFERED_PATH = "/api/chat";
const EVENTS_PATH = "/api/chat/generations/:generationId/events";
const STATUS_PATH = "/api/chat/generations/:generationId";
const CANCEL_PATH = "/api/chat/generations/:generationId/cancel";
const CANCEL_ALL_PATH = "/api/chat/generations/cancel-all";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let bootstrapInstalled = false;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

function normalizeRequestId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || randomUUID();
}

function normalizeGenerationId(value: unknown): string {
  return isUuid(value) ? value.trim() : randomUUID();
}

function extractSsePayload(chunk: unknown): Record<string, unknown> | "[DONE]" | null {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const match = text.match(/(?:^|\n)data:\s*(.+?)(?:\n\n|$)/s);
  if (!match) return null;
  const payload = match[1].trim();
  if (payload === "[DONE]") return "[DONE]";
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

class GenerationResponseProxy {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private readonly generationId: string;
  private readonly onFrame: (frame: Record<string, unknown> | "[DONE]") => void;
  private readonly onError: (error: unknown) => void;

  constructor(generationId: string, onFrame: (frame: Record<string, unknown> | "[DONE]") => void, onError: (error: unknown) => void) {
    this.generationId = generationId;
    this.onFrame = onFrame;
    this.onError = onError;
  }

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name: string) { this.headers.delete(name.toLowerCase()); return this; }
  flushHeaders() { this.headersSent = true; }

  write(chunk: unknown) {
    if (this.writableEnded) return false;
    this.headersSent = true;
    const payload = extractSsePayload(chunk);
    if (payload) this.onFrame(payload);
    return true;
  }

  end(chunk?: unknown) {
    if (this.writableEnded) return this;
    if (typeof chunk !== "undefined") this.write(chunk);
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  status(code: number) { this.statusCode = code; return this; }

  json(body: unknown) {
    this.headersSent = true;
    this.onFrame({ type: "structured_response", response: body, generation_id: this.generationId });
    return this.end();
  }

  send(body: unknown) { return this.json(body); }

  on(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void) {
    const onceListener = (...args: any[]) => {
      this.removeListener(event, onceListener);
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  removeListener(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, list.filter((candidate) => candidate !== listener));
    return this;
  }

  emit(event: string, ...args: any[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      try { listener(...args); } catch (error) { this.onError(error); }
    }
    return true;
  }
}

async function resolveUserDatabase(requestUser: any): Promise<any | null> {
  if (!requestUser?.sub || requestUser.isGuest) return null;
  return getOrAssignUserDatabase(requestUser.sub);
}

async function prepareGeneration(request: Request) {
  const parsed = ChatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    const error = new Error("Invalid chat request");
    (error as any).statusCode = 400;
    (error as any).details = parsed.error.flatten();
    throw error;
  }

  const requestUser = getRequestUser(request);
  const userId = String(requestUser?.sub || "guest");
  const clientRequestId = normalizeRequestId(parsed.data.clientRequestId);
  const requestedGenerationId = normalizeGenerationId(parsed.data.generationId);
  let conversationId = parsed.data.conversationId || null;
  const executionMode = parsed.data.executionMode;

  if (requestUser && !requestUser.isGuest) {
    const userDb = await resolveUserDatabase(requestUser);
    if (!userDb) throw new Error("User database unavailable");
    const initialized = await userDb.rpc("initialize_user_session", { p_user_id: userId });
    if (initialized.error) throw initialized.error;

    const resolved = await resolveConversationForTurn(userDb, {
      userId,
      clientRequestId,
      conversationId,
      title: "New Chat",
    });
    if (resolved.error || !resolved.data?.conversation_id) throw resolved.error || new Error("Unable to resolve conversation");
    conversationId = resolved.data.conversation_id;

    const existing = await getChatGenerationByClientRequestId(userDb, userId, clientRequestId);
    if (existing.error) throw existing.error;
    let generation = existing.data;
    if (!generation) {
      const created = await createChatGeneration(userDb, {
        conversationId,
        userId,
        clientRequestId,
        generationId: requestedGenerationId,
        executionMode,
      });
      if (created.error || !created.data) throw created.error || new Error("Unable to create chat generation");
      generation = created.data;
    }

    request.body = {
      ...request.body,
      conversationId: generation.conversation_id,
      conversation_id: generation.conversation_id,
      clientRequestId: generation.client_request_id,
      client_request_id: generation.client_request_id,
      generationId: generation.id,
      generation_id: generation.id,
      executionMode: generation.execution_mode ?? executionMode,
      execution_mode: generation.execution_mode ?? executionMode,
    };

    return {
      requestUser,
      userId,
      userDb,
      generationId: generation.id,
      clientRequestId: generation.client_request_id || clientRequestId,
      conversationId: generation.conversation_id,
      status: generation.status,
      generation,
    };
  }

  const generationId = requestedGenerationId;
  request.body = {
    ...request.body,
    conversationId,
    conversation_id: conversationId,
    clientRequestId,
    client_request_id: clientRequestId,
    generationId,
    generation_id: generationId,
    executionMode,
    execution_mode: executionMode,
  };
  const task = chatGenerationTaskCoordinator.get(generationId);
  return {
    requestUser,
    userId,
    userDb: null,
    generationId,
    clientRequestId,
    conversationId,
    status: task?.status ?? "queued",
    generation: null,
  };
}

async function resolveOwnedGeneration(request: Request, generationId: string) {
  const requestUser = getRequestUser(request);
  const userId = String(requestUser?.sub || "guest");
  if (!requestUser || requestUser.isGuest) {
    const task = chatGenerationTaskCoordinator.get(generationId);
    if (!task) return { requestUser, userId, userDb: null, generationId, generation: null, task: null };
    return { requestUser, userId, userDb: null, generationId, generation: null, task };
  }

  const userDb = await resolveUserDatabase(requestUser);
  if (!userDb) throw new Error("User database unavailable");
  const initialized = await userDb.rpc("initialize_user_session", { p_user_id: userId });
  if (initialized.error) throw initialized.error;
  const result = await getChatGenerationById(userDb, userId, generationId);
  if (result.error) throw result.error;
  return { requestUser, userId, userDb, generationId, generation: result.data, task: chatGenerationTaskCoordinator.get(generationId) };
}

async function startLegacyGeneration(legacyFinalHandler: any, context: Awaited<ReturnType<typeof prepareGeneration>>, request: Request): Promise<void> {
  const existing = chatGenerationTaskCoordinator.get(context.generationId);
  if (existing && !existing.terminal) return;
  if (["completed", "failed", "cancelled"].includes(context.status)) return;

  (request as any).__sentiqGenerationDetached = true;
  const task = chatGenerationTaskCoordinator.start({
    generationId: context.generationId,
    clientRequestId: context.clientRequestId,
    userId: context.userId,
    userDb: context.userDb,
    request,
  });
  task.status = "running";

  let runnerError: unknown = null;
  let sawDone = false;
  let sawError = false;
  let frameChain = Promise.resolve();

  const responseProxy = new GenerationResponseProxy(
    context.generationId,
    (frame) => {
      frameChain = frameChain.then(async () => {
        if (frame === "[DONE]") {
          sawDone = true;
          return;
        }
        if (frame.type === "error") sawError = true;
        await chatGenerationTaskCoordinator.publish(context.generationId, frame);
      }).catch((error) => { runnerError = error; });
    },
    (error) => { runnerError = error; },
  );

  const finished = new Promise<void>((resolve) => {
    responseProxy.once("finish", resolve);
    responseProxy.once("close", resolve);
    (responseProxy as any).__resolveGeneration = resolve;
  });
  const next = (error?: unknown) => {
    if (error) runnerError = error;
    (responseProxy as any).__resolveGeneration?.();
  };

  try {
    legacyFinalHandler(request, responseProxy as any as Response, next);
    await finished;
    await frameChain;
  } catch (error) {
    runnerError = error;
  }

  if (task.explicitCancelRequested) {
    await chatGenerationTaskCoordinator.cancelled(context.generationId);
  } else if (runnerError) {
    await chatGenerationTaskCoordinator.failed(context.generationId, String((runnerError as any)?.code || (runnerError as any)?.name || "generation_failed"));
  } else if (!task.terminal) {
    if (sawDone && !sawError) await chatGenerationTaskCoordinator.complete(context.generationId);
    else if (sawError) await chatGenerationTaskCoordinator.failed(context.generationId, task.lastErrorCode || "generation_failed");
    else await chatGenerationTaskCoordinator.complete(context.generationId);
  }
}

function formatGenerationEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function openGenerationSubscription(response: Response, generationId: string, context: any, afterSequence = 0) {
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();

  const emit = (event: Record<string, unknown>) => {
    if ((response as any).writableEnded) return;
    try { response.write(formatGenerationEvent(event)); } catch { /* subscriber detached */ }
  };
  const emitDoneAndClose = () => {
    if ((response as any).writableEnded) return;
    try { response.write("data: [DONE]\n\n"); response.end(); } catch { /* already closed */ }
  };

  let closed = false;
  let unsubscribe: (() => void) | null = null;
  const heartbeat = setInterval(() => {
    if (!closed && !(response as any).writableEnded) {
      try { response.write(": keepalive\n\n"); } catch { /* detached */ }
    }
  }, 15000);
  heartbeat.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    unsubscribe = null;
  };
  response.once("close", cleanup);
  response.once("finish", cleanup);

  const task = chatGenerationTaskCoordinator.get(generationId);
  void (async () => {
    let persisted = context.generation;
    if (context.userDb) {
      const result = await getChatGenerationById(context.userDb, context.userId, generationId);
      if (result.error) throw result.error;
      persisted = result.data;
      if (!persisted) throw Object.assign(new Error("Generation not found"), { code: "generation_not_found" });
    }

    emit(await chatGenerationTaskCoordinator.snapshot(generationId, persisted));
    if (task) {
      const baseline = task.sequence;
      unsubscribe = chatGenerationTaskCoordinator.subscribe(generationId, (event) => {
        emit(event);
        if (["generation_completed", "generation_failed", "generation_cancelled"].includes(String(event.type))) emitDoneAndClose();
      }, Math.max(afterSequence, baseline));
      if (task.terminal) {
        emit({
          generation_id: generationId,
          sequence: task.sequence + 1,
          type: task.status === "completed" ? "generation_completed" : task.status === "cancelled" ? "generation_cancelled" : "generation_failed",
          status: task.status,
          partial_text: task.partialText,
          error_code: task.lastErrorCode,
        });
        emitDoneAndClose();
      }
      return;
    }

    if (["completed", "failed", "cancelled"].includes(String(persisted?.status))) {
      const terminalType = persisted.status === "completed" ? "generation_completed" : persisted.status === "cancelled" ? "generation_cancelled" : "generation_failed";
      emit({
        generation_id: generationId,
        sequence: Number(persisted.last_event_sequence ?? 0) + 1,
        type: terminalType,
        status: persisted.status,
        partial_text: persisted.partial_text ?? "",
        error_code: persisted.error_code ?? null,
      });
      emitDoneAndClose();
    }
  })().catch((error) => {
    emit({ type: "error", code: String((error as any)?.code || "generation_subscription_failed"), error: "Generation subscription failed." });
    emitDoneAndClose();
  });
}

function installGenerationRoutes(app: any) {
  if (app.__sentiqGenerationRoutesInstalled) return;
  app.__sentiqGenerationRoutesInstalled = true;

  app.get(EVENTS_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const context = await resolveOwnedGeneration(req, String(req.params.generationId || ""));
      if (!context.generation && !context.task) return res.status(404).json({ error: "Generation not found.", code: "generation_not_found" });
      const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0);
      openGenerationSubscription(res, context.generationId, context, Number.isFinite(after) ? Math.max(0, after) : 0);
    } catch {
      res.status(500).json({ error: "Unable to subscribe to generation.", code: "generation_subscription_failed" });
    }
  });

  app.get(STATUS_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const context = await resolveOwnedGeneration(req, String(req.params.generationId || ""));
      if (context.task) {
        res.json(await chatGenerationTaskCoordinator.snapshot(context.generationId, context.generation));
        return;
      }
      if (!context.generation) return res.status(404).json({ error: "Generation not found.", code: "generation_not_found" });
      res.json(context.generation);
    } catch {
      res.status(500).json({ error: "Unable to load generation status.", code: "generation_status_failed" });
    }
  });

  app.post(CANCEL_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    try {
      const generationId = String(req.params.generationId || "").trim();
      if (!generationId) return res.status(400).json({ error: "generationId is required" });
      const context = await resolveOwnedGeneration(req, generationId);
      if (!context.generation && !context.task) return res.status(404).json({ error: "Generation not found.", code: "generation_not_found" });
      if (context.userDb) {
        const cancel = await requestChatGenerationCancel(context.userDb, context.userId, generationId);
        if (cancel.error) throw cancel.error;
      }
      const requested = await chatGenerationTaskCoordinator.requestCancel(generationId);
      if (requested) await chatGenerationTaskCoordinator.cancelled(generationId);
      res.json({ generation_id: generationId, status: requested ? "cancelled" : context.generation?.status ?? "cancel_requested" });
    } catch {
      res.status(500).json({ error: "Unable to cancel generation.", code: "generation_cancel_failed" });
    }
  });

  app.post(CANCEL_ALL_PATH, verifyJWT({ allowGuest: true }), async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.generation_ids)
      ? req.body.generation_ids.map((id: unknown) => String(id || "").trim()).filter(Boolean).slice(0, 32)
      : [];
    const results: Array<{ generation_id: string; status: string }> = [];
    for (const generationId of ids) {
      try {
        const context = await resolveOwnedGeneration(req, generationId);
        if (!context.generation && !context.task) {
          results.push({ generation_id: generationId, status: "not_found" });
          continue;
        }
        if (context.userDb) await requestChatGenerationCancel(context.userDb, context.userId, generationId);
        const requested = await chatGenerationTaskCoordinator.requestCancel(generationId);
        if (requested) await chatGenerationTaskCoordinator.cancelled(generationId);
        results.push({ generation_id: generationId, status: requested ? "cancelled" : context.generation?.status ?? "cancel_requested" });
      } catch {
        results.push({ generation_id: generationId, status: "unavailable" });
      }
    }
    res.json({ results });
  });
}

function installCompatibilityRouteInterceptors() {
  if (bootstrapInstalled) return;
  bootstrapInstalled = true;
  const application = (express as any).application;
  const originalPost = application.post;
  const originalListen = application.listen;

  application.post = function patchedPost(path: string, ...handlers: any[]) {
    if (path === STREAM_PATH || path === BUFFERED_PATH) {
      const legacyFinalHandler = handlers[handlers.length - 1];
      const middleware = handlers.slice(0, -1);
      const replacement = async (req: Request, res: Response, next: NextFunction) => {
        try {
          const context = await prepareGeneration(req);
          if (!chatGenerationTaskCoordinator.has(context.generationId) && !["completed", "failed", "cancelled"].includes(context.status)) {
            void startLegacyGeneration(legacyFinalHandler, context, req).catch(async (error) => {
              await chatGenerationTaskCoordinator.failed(context.generationId, String((error as any)?.code || "generation_start_failed"));
            });
          }

          if (path === BUFFERED_PATH) {
            res.status(202).json({ generation_id: context.generationId, conversation_id: context.conversationId, client_request_id: context.clientRequestId, status: context.status === "completed" ? "completed" : "running" });
            return;
          }

          const after = Number(req.headers["last-event-id"] ?? req.query?.after ?? 0);
          openGenerationSubscription(res, context.generationId, context, Number.isFinite(after) ? Math.max(0, after) : 0);
        } catch (error) {
          next(error);
        }
      };
      return originalPost.call(this, path, ...middleware, replacement);
    }
    return originalPost.call(this, path, ...handlers);
  };

  application.listen = function patchedListen(this: any, ...args: any[]) {
    installGenerationRoutes(this);
    return originalListen.apply(this, args);
  };
}

installCompatibilityRouteInterceptors();
