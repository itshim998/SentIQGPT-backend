import { randomUUID } from "crypto";
import {
  claimChatGenerationExecution,
  getChatGenerationById,
  releaseChatGenerationExecutionLease,
  markChatGenerationRunning,
  MAX_ACTIVE_GENERATIONS_PER_USER,
  type ChatGenerationRow,
} from "./chatGenerationService";
import { closeTokenAllowanceAccounting } from "../context/requestBudgetContext";
import { chatGenerationTaskCoordinator, type ChatGenerationExecution, type ChatGenerationTaskContext } from "./chatGenerationTaskCoordinator";
import { executeChatGeneration } from "./chatGenerationExecutor";

const CONCURRENCY_RETRY_MS = 2000;

export type GenerationExecutorHandler = (request: GenerationExecutionRequest, response: GenerationEventSink, next: (error?: unknown) => void) => unknown;
export type GenerationRequestSnapshot = {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  originalUrl?: string;
  user?: Record<string, unknown> | null;
};

export interface GenerationExecutionRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  originalUrl: string;
  user: Record<string, unknown> | null;
  complete: boolean;
  signal: AbortSignal;
  __sentiqGenerationDetached: true;
  once(event: "close" | "sentiq-generation-cancel", listener: () => void): this;
  on(event: "close" | "sentiq-generation-cancel", listener: () => void): this;
  emit(event: "close" | "sentiq-generation-cancel"): boolean;
  get(name: string): string | undefined;
}

export class GenerationEventSink {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  __sentiqGenerationDetached: true = true;
  private readonly headers = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  private buffer = "";
  private publishChain = Promise.resolve();
  private readonly onFrame: (frame: Record<string, unknown> | "[DONE]") => Promise<void> | void;
  private readonly onError: (error: unknown) => void;
  private readonly generationId: string;

  constructor(
    generationId: string,
    onFrame: (frame: Record<string, unknown> | "[DONE]") => Promise<void> | void,
    onError: (error: unknown) => void,
  ) {
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
  status(code: number) { this.statusCode = code; return this; }
  write(chunk: unknown) { if (this.writableEnded) return false; this.headersSent = true; this.ingest(chunk); return true; }
  end(chunk?: unknown) {
    if (this.writableEnded) return this;
    if (typeof chunk !== "undefined") this.ingest(chunk);
    this.flushBufferedFrame();
    this.writableEnded = true;
    void this.publishChain.finally(() => { this.emit("finish"); this.emit("close"); });
    return this;
  }
  json(body: unknown) { this.headersSent = true; this.queueFrame({ type: "structured_response", response: body, generation_id: this.generationId }); return this.end(); }
  send(body: unknown) { return this.json(body); }
  on(event: string, listener: (...args: any[]) => void) { const list = this.listeners.get(event) ?? []; list.push(listener); this.listeners.set(event, list); return this; }
  once(event: string, listener: (...args: any[]) => void) { const onceListener = (...args: any[]) => { this.removeListener(event, onceListener); listener(...args); }; return this.on(event, onceListener); }
  removeListener(event: string, listener: (...args: any[]) => void) { const list = this.listeners.get(event) ?? []; this.listeners.set(event, list.filter((candidate) => candidate !== listener)); return this; }
  emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) { try { listener(...args); } catch (error) { this.onError(error); } } return true; }
  async flush(): Promise<void> { this.flushBufferedFrame(); await this.publishChain; }

  private ingest(chunk: unknown): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    while (true) {
      const separatorIndex = this.buffer.indexOf("\n\n");
      if (separatorIndex < 0) break;
      const frameText = this.buffer.slice(0, separatorIndex);
      this.buffer = this.buffer.slice(separatorIndex + 2);
      this.parseFrame(frameText);
    }
  }
  private flushBufferedFrame(): void { const frameText = this.buffer.trim(); this.buffer = ""; if (frameText) this.parseFrame(frameText); }
  private parseFrame(frameText: string): void {
    const dataLine = frameText.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const payload = dataLine.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { this.publishChain = this.publishChain.then(() => this.onFrame("[DONE]")); return; }
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") this.queueFrame(parsed as Record<string, unknown>);
    } catch { /* legacy handler may emit non-JSON diagnostics */ }
  }
  private queueFrame(frame: Record<string, unknown>): void { this.publishChain = this.publishChain.then(() => this.onFrame(frame)).catch((error) => this.onError(error)); }
}

function toRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function snapshotFromGeneration(generation: ChatGenerationRow): GenerationRequestSnapshot | null {
  const snapshot = toRecord(generation.execution_snapshot);
  const body = toRecord(snapshot.body);
  if (!body.message && typeof snapshot.message === "string") body.message = snapshot.message;
  if (!body.message) return null;
  body.conversationId = generation.conversation_id;
  body.conversation_id = generation.conversation_id;
  body.clientRequestId = generation.client_request_id ?? body.clientRequestId;
  body.client_request_id = generation.client_request_id ?? body.client_request_id;
  body.generationId = generation.id;
  body.generation_id = generation.id;
  body.executionMode = generation.execution_mode ?? body.executionMode ?? "fast";
  body.execution_mode = generation.execution_mode ?? body.execution_mode ?? "fast";
  return {
    body,
    originalUrl: typeof snapshot.originalUrl === "string" ? snapshot.originalUrl : "/api/chat",
    user: snapshot.user && typeof snapshot.user === "object" ? snapshot.user as Record<string, unknown> : { sub: generation.user_id, isGuest: false },
  };
}

function buildExecutionRequest(snapshot: GenerationRequestSnapshot, generation: ChatGenerationRow): GenerationExecutionRequest {
  const listeners = new Map<string, Array<() => void>>();
  const abortController = new AbortController();
  const body = {
    ...toRecord(snapshot.body),
    conversationId: generation.conversation_id,
    conversation_id: generation.conversation_id,
    clientRequestId: generation.client_request_id ?? snapshot.body.clientRequestId,
    client_request_id: generation.client_request_id ?? snapshot.body.client_request_id,
    generationId: generation.id,
    generation_id: generation.id,
    executionMode: generation.execution_mode ?? snapshot.body.executionMode ?? "fast",
    execution_mode: generation.execution_mode ?? snapshot.body.execution_mode ?? "fast",
  };
  const headers = { ...(snapshot.headers ?? {}) };
  const request: GenerationExecutionRequest = {
    body,
    headers,
    originalUrl: snapshot.originalUrl || "/api/chat",
    user: snapshot.user ?? { sub: generation.user_id, isGuest: false },
    complete: true,
    signal: abortController.signal,
    __sentiqGenerationDetached: true,
    once(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    on(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    emit(event) { for (const listener of listeners.get(event) ?? []) { try { listener(); } catch {} } return true; },
    get(name) {
      const normalized = name.toLowerCase();
      return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1];
    },
  };
  request.once("sentiq-generation-cancel", () => abortController.abort(new Error("Generation cancelled by user.")));
  request.once("close", () => {
    if (!abortController.signal.aborted && request.__sentiqGenerationDetached !== true) abortController.abort();
  });
  return request;
}

function buildGuestGenerationRow(task: ReturnType<typeof chatGenerationTaskCoordinator.get>): ChatGenerationRow | null {
  if (!task) return null;
  const now = new Date().toISOString();
  return {
    id: task.generationId,
    conversation_id: task.conversationId ?? "guest-conversation",
    user_id: task.userId,
    client_request_id: task.clientRequestId ?? null,
    generation_session_id: task.generationSessionId ?? null,
    status: task.status as ChatGenerationRow["status"],
    execution_mode: "fast",
    model_route: null,
    execution_snapshot: {},
    started_at: now,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    error_code: task.lastErrorCode,
    partial_text: task.partialText,
    tokens_generated: task.tokensGenerated,
    last_event_sequence: task.sequence,
    created_at: now,
    updated_at: now,
    execution_lease_id: null,
    execution_lease_expires_at: null,
    recovery_attempts: 0,
    last_execution_error: null,
  };
}

export async function runGeneration(generationId: string): Promise<void> {
  const existingTask = chatGenerationTaskCoordinator.get(generationId);
  if (existingTask?.terminal) return;
  if (existingTask?.runPromise) return existingTask.runPromise;

  const runPromise = (async () => {
    let userDb: any = existingTask?.userDb ?? null;
    let generation: ChatGenerationRow | null = existingTask?.generation ?? null;
    if (!generation && existingTask?.userDb) {
      const loaded = await getChatGenerationById(existingTask.userDb, existingTask.userId, generationId);
      if (loaded.error) throw loaded.error;
      generation = loaded.data;
    }
    if (!generation) generation = buildGuestGenerationRow(existingTask);
    if (!generation) throw Object.assign(new Error("Generation execution context is unavailable"), { code: "generation_execution_context_unavailable" });
    if (["completed", "failed", "cancelled"].includes(generation.status)) return;

    const requestSnapshot = snapshotFromGeneration(generation);
    if (!requestSnapshot) throw Object.assign(new Error("Generation request snapshot is unavailable"), { code: "generation_snapshot_unavailable" });

    const taskContext: ChatGenerationTaskContext = {
      generationId: generation.id,
      clientRequestId: generation.client_request_id,
      generationSessionId: generation.generation_session_id,
      conversationId: generation.conversation_id,
      userId: generation.user_id,
      userDb,
      generation,
    };
    const task = chatGenerationTaskCoordinator.start(taskContext);
    if (task.explicitCancelRequested || generation.status === "cancel_requested") { await chatGenerationTaskCoordinator.cancelled(generation.id); return; }

    const leaseId = randomUUID();
    if (userDb) {
      const claimed = await claimChatGenerationExecution(userDb, {
        userId: generation.user_id,
        generationId: generation.id,
        leaseId,
        leaseSeconds: 60,
        maxActiveGenerations: MAX_ACTIVE_GENERATIONS_PER_USER,
      });
      if (claimed.error || !claimed.data) {
        if (claimed.error?.code === "55P03") {
          task.status = "queued";
          setTimeout(() => {
            if (!chatGenerationTaskCoordinator.get(generationId)?.terminal) void runGeneration(generationId).catch(() => undefined);
          }, CONCURRENCY_RETRY_MS).unref?.();
          return;
        }
        throw Object.assign(new Error("Generation execution lease unavailable"), { code: "generation_execution_lease_unavailable", cause: claimed.error });
      }
      generation = claimed.data;
      task.generation = generation;
    }

    await chatGenerationTaskCoordinator.publish(generation.id, {
      type: "generation_started",
      conversation_id: generation.conversation_id,
      status: "running",
    });

    const request = buildExecutionRequest(requestSnapshot, generation);
    let runnerError: unknown = null;
    const sink = new GenerationEventSink(
      generation.id,
      async (frame) => { if (frame !== "[DONE]") await chatGenerationTaskCoordinator.publish(generation!.id, frame); },
      (error) => { runnerError = runnerError ?? error; },
    );
    const executionHandle: ChatGenerationExecution = {
      cancel: () => { request.emit("sentiq-generation-cancel"); request.emit("close"); },
    };
    task.execution = executionHandle;

    const renewTimer = userDb
      ? setInterval(() => {
          void import("./chatGenerationService")
            .then(({ renewChatGenerationExecutionLease }) => renewChatGenerationExecutionLease(userDb, { userId: generation!.user_id, generationId: generation!.id, leaseId, leaseSeconds: 60 }))
            .catch(() => undefined);
        }, 20_000)
      : null;
    renewTimer?.unref?.();

    task.runPromise = (async () => {
      try {
        if (userDb) await markChatGenerationRunning(userDb, generation!.user_id, generation!.id).catch(() => undefined);
        task.status = "running";
        await executeChatGeneration(request, sink);
        await sink.flush();
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else if (runnerError) await chatGenerationTaskCoordinator.failed(generation!.id, String((runnerError as any)?.code || (runnerError as any)?.name || "generation_failed"));
        else await chatGenerationTaskCoordinator.complete(generation!.id);
      } catch (error) {
        runnerError = error;
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else await chatGenerationTaskCoordinator.failed(generation!.id, String((error as any)?.code || (error as any)?.name || "generation_failed"));
      } finally {
        if (renewTimer) clearInterval(renewTimer);
        if (userDb) await releaseChatGenerationExecutionLease(userDb, { userId: generation!.user_id, generationId: generation!.id, leaseId }).catch(() => undefined);
        if (generation?.client_request_id) {
          try { closeTokenAllowanceAccounting({ requestId: generation.client_request_id, releasePending: true }); }
          catch (error) { console.warn(`[GenerationQuota] settlement cleanup failed generation=${generation.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        task.execution = undefined;
        task.runPromise = undefined;
      }
    })();

    await task.runPromise;
  })();

  if (existingTask) existingTask.runPromise = runPromise;
  return runPromise;
}
