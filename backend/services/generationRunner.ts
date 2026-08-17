import { getChatGenerationById, markChatGenerationRunning, type ChatGenerationRow } from "./chatGenerationService";
import { closeTokenAllowanceAccounting } from "../context/requestBudgetContext";
import {
  chatGenerationTaskCoordinator,
  type ChatGenerationExecution,
  type ChatGenerationTaskContext,
} from "./chatGenerationTaskCoordinator";

export type GenerationExecutorHandler = (
  request: GenerationExecutionRequest,
  response: GenerationEventSink,
  next: (error?: unknown) => void,
) => unknown;

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

  constructor(generationId: string, onFrame: (frame: Record<string, unknown> | "[DONE") => Promise<void> | void, onError: (error: unknown) => void) {
    this.generationId = generationId;
    this.onFrame = onFrame;
    this.onError = onError;
  }

  setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)); return this; }
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
    try { const parsed = JSON.parse(payload); if (parsed && typeof parsed === "object") this.queueFrame(parsed as Record<string, unknown>); } catch {}
  }
  private queueFrame(frame: Record<string, unknown>): void { this.publishChain = this.publishChain.then(() => this.onFrame(frame)).catch((error) => this.onError(error)); }
}

type RegisteredExecution = { handler: GenerationExecutorHandler; snapshot: GenerationRequestSnapshot };
const registeredExecutions = new Map<string, RegisteredExecution>();
let defaultGenerationExecutor: GenerationExecutorHandler | null = null;

export function registerGenerationExecutor(handler: GenerationExecutorHandler): void { defaultGenerationExecutor = handler; }
export function registerGenerationExecution(generationId: string, execution: RegisteredExecution): void { registeredExecutions.set(generationId, execution); }
export function unregisterGenerationExecution(generationId: string): void { registeredExecutions.delete(generationId); }

function toRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function snapshotFromGeneration(generation: ChatGenerationRow): GenerationRequestSnapshot | null {
  const snapshot = toRecord((generation as any).execution_snapshot);
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
  return { body, originalUrl: typeof snapshot.originalUrl === "string" ? snapshot.originalUrl : "/api/chat", user: snapshot.user && typeof snapshot.user === "object" ? snapshot.user as Record<string, unknown> : { sub: generation.user_id, isGuest: false } };
}

function buildExecutionRequest(snapshot: GenerationRequestSnapshot, generation: ChatGenerationRow): { request: GenerationExecutionRequest; abortController: AbortController } {
  const listeners = new Map<string, Array<() => void>>();
  const abortController = new AbortController();
  const body = { ...toRecord(snapshot.body), conversationId: generation.conversation_id, conversation_id: generation.conversation_id, clientRequestId: generation.client_request_id ?? snapshot.body.clientRequestId, client_request_id: generation.client_request_id ?? snapshot.body.client_request_id, generationId: generation.id, generation_id: generation.id, executionMode: generation.execution_mode ?? snapshot.body.executionMode ?? "fast", execution_mode: generation.execution_mode ?? snapshot.body.execution_mode ?? "fast" };
  const headers = { ...(snapshot.headers ?? {}) };
  const request: GenerationExecutionRequest = {
    body, headers, originalUrl: snapshot.originalUrl || "/api/chat", user: snapshot.user ?? { sub: generation.user_id, isGuest: false }, complete: true, signal: abortController.signal, __sentiqGenerationDetached: true,
    once(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    on(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    emit(event) { for (const listener of listeners.get(event) ?? []) { try { listener(); } catch {} } return true; },
    get(name) { const normalized = name.toLowerCase(); return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1]; },
  };
  request.once("sentiq-generation-cancel", () => abortController.abort(new Error("Generation cancelled by user.")));
  request.once("close", () => { if (!abortController.signal.aborted && request.__sentiqGenerationDetached !== true) abortController.abort(); });
  return { request, abortController };
}

function buildGuestGenerationRow(task: ReturnType<typeof chatGenerationTaskCoordinator.get>): ChatGenerationRow | null {
  if (!task) return null;
  const body = toRecord(registeredExecutions.get(task.generationId)?.snapshot.body);
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : typeof body.conversation_id === "string" ? body.conversation_id : "guest-conversation";
  const now = new Date().toISOString();
  return { id: task.generationId, conversation_id: conversationId, user_id: task.userId, client_request_id: task.clientRequestId ?? null, status: task.status, execution_mode: body.executionMode === "intuitive" ? "intuitive" : "fast", model_route: null, execution_snapshot: {}, started_at: now, completed_at: null, failed_at: null, cancelled_at: null, error_code: task.lastErrorCode, partial_text: task.partialText, tokens_generated: task.tokensGenerated, last_event_sequence: task.sequence, created_at: now, updated_at: now } as ChatGenerationRow;
}

export async function runGeneration(generationId: string): Promise<void> {
  const existingTask = chatGenerationTaskCoordinator.get(generationId);
  if (existingTask?.terminal) return;
  if (existingTask?.runPromise) return existingTask.runPromise;

  const execution = registeredExecutions.get(generationId);
  const handler = execution?.handler ?? defaultGenerationExecutor;
  if (!handler) throw Object.assign(new Error("No generation executor is registered"), { code: "generation_executor_unavailable" });

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

    const requestSnapshot = execution?.snapshot ?? snapshotFromGeneration(generation);
    if (!requestSnapshot) throw Object.assign(new Error("Generation request snapshot is unavailable"), { code: "generation_snapshot_unavailable" });

    const taskContext: ChatGenerationTaskContext = { generationId: generation.id, clientRequestId: generation.client_request_id, userId: generation.user_id, userDb, generation };
    const task = chatGenerationTaskCoordinator.start(taskContext);
    if (task.explicitCancelRequested || generation.status === "cancel_requested") {
      await chatGenerationTaskCoordinator.cancelled(generation.id);
      return;
    }

    const { request } = buildExecutionRequest(requestSnapshot, generation);
    let runnerError: unknown = null;
    const sink = new GenerationEventSink(generation.id, async (frame) => { if (frame !== "[DONE]") await chatGenerationTaskCoordinator.publish(generation!.id, frame); }, (error) => { runnerError = runnerError ?? error; });
    const executionHandle: ChatGenerationExecution = { cancel: () => { request.emit("sentiq-generation-cancel"); request.emit("close"); } };
    task.execution = executionHandle;
    task.runPromise = (async () => {
      try {
        if (userDb) await markChatGenerationRunning(userDb, generation!.user_id, generation!.id).catch(() => undefined);
        task.status = "running";
        await Promise.resolve(handler(request, sink, (error) => { if (error) runnerError = error; }));
        await sink.flush();
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else if (runnerError) await chatGenerationTaskCoordinator.failed(generation!.id, String((runnerError as any)?.code || (runnerError as any)?.name || "generation_failed"));
        else await chatGenerationTaskCoordinator.complete(generation!.id);
      } catch (error) {
        runnerError = error;
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else await chatGenerationTaskCoordinator.failed(generation!.id, String((error as any)?.code || (error as any)?.name || "generation_failed"));
      } finally {
        if (generation?.client_request_id) {
          try { closeTokenAllowanceAccounting({ requestId: generation.client_request_id, releasePending: true }); } catch (error) { console.warn(`[GenerationQuota] settlement cleanup failed generation=${generation.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        task.execution = undefined;
        task.runPromise = undefined;
        unregisterGenerationExecution(generation!.id);
      }
    })();
    await task.runPromise;
  })();

  if (existingTask) existingTask.runPromise = runPromise;
  return runPromise;
}
