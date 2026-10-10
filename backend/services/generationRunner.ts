import { randomUUID } from "crypto";
import {
  claimChatGenerationExecution,
  getChatGenerationById,
  releaseChatGenerationExecutionLease,
  MAX_ACTIVE_GENERATIONS_PER_USER,
  type ChatGenerationRow,
} from "./chatGenerationService";
import { closeTokenAllowanceAccounting } from "../context/requestBudgetContext";
import { chatGenerationTaskCoordinator, type ChatGenerationExecution, type ChatGenerationTaskContext } from "./chatGenerationTaskCoordinator";
import { executeChatGeneration } from "./chatGenerationExecutor";

function getConcurrencyRetryMs(): number {
  const envVal = Number(process.env.SENTIQ_CONCURRENCY_RETRY_MS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 2000;
}
function getMaxConcurrencyRetries(): number {
  const envVal = Number(process.env.SENTIQ_MAX_CONCURRENCY_RETRIES);
  return Number.isFinite(envVal) && envVal >= 0 ? envVal : 30;
}
const CONTROL_POLL_MS = 2000;
const LEASE_RENEW_MS = 15000;
export type GenerationExecutorHandler = (request: GenerationExecutionRequest, response: GenerationEventSink, next: (error?: unknown) => void) => unknown;
export type GenerationRequestSnapshot = { body: Record<string, unknown>; headers?: Record<string, string>; originalUrl?: string; user?: Record<string, unknown> | null };
export interface GenerationExecutionRequest {
  userDb?: any;
  generation?: ChatGenerationRow;
  canonicalConversationId?: string | null;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  ip: string;
  socket: { remoteAddress: string; encrypted?: boolean };
  query: Record<string, unknown>;
  params: Record<string, string>;
  path: string;
  originalUrl: string;
  method?: string;
  user: Record<string, unknown> | null;
  complete: boolean;
  signal: AbortSignal;
  __sentiqGenerationDetached: true;
  once(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
  listeners?(event: string): Array<(...args: any[]) => void>;
  get(name: string): string | undefined;
  header?(name: string): string | undefined;
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
  constructor(generationId: string, onFrame: (frame: Record<string, unknown> | "[DONE]") => Promise<void> | void, onError: (error: unknown) => void) { this.generationId = generationId; this.onFrame = onFrame; this.onError = onError; }
  setHeader(name: string, value: string | number | readonly string[]) { this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name: string) { this.headers.delete(name.toLowerCase()); return this; }
  flushHeaders() { this.headersSent = true; }
  status(code: number) { this.statusCode = code; return this; }
  write(chunk: unknown) { if (this.writableEnded) return false; this.headersSent = true; this.ingest(chunk); return true; }
  writeEvent(event: Record<string, unknown>): boolean {
    if (this.writableEnded) return false;
    this.headersSent = true;
    if (event.type === "token") {
      try {
        void this.onFrame(event);
      } catch (error) {
        this.onError(error);
      }
      return true;
    }
    this.queueFrame(event);
    return true;
  }
  end(chunk?: unknown) { if (this.writableEnded) return this; if (typeof chunk !== "undefined") this.ingest(chunk); this.flushBufferedFrame(); this.writableEnded = true; void this.publishChain.finally(() => { this.emit("finish"); this.emit("close"); }); return this; }
  json(body: unknown) { this.headersSent = true; this.queueFrame({ type: "structured_response", response: body, generation_id: this.generationId }); return this.end(); }
  send(body: unknown) { return this.json(body); }
  on(event: string, listener: (...args: any[]) => void) { const list = this.listeners.get(event) ?? []; list.push(listener); this.listeners.set(event, list); return this; }
  once(event: string, listener: (...args: any[]) => void) { const onceListener = (...args: any[]) => { this.removeListener(event, onceListener); listener(...args); }; return this.on(event, onceListener); }
  removeListener(event: string, listener: (...args: any[]) => void) { const list = this.listeners.get(event) ?? []; this.listeners.set(event, list.filter((candidate) => candidate !== listener)); return this; }
  off(event: string, listener: (...args: any[]) => void) { return this.removeListener(event, listener); }
  emit(event: string, ...args: any[]) { for (const listener of this.listeners.get(event) ?? []) { try { listener(...args); } catch (error) { this.onError(error); } } return true; }
  async flush(): Promise<void> { this.flushBufferedFrame(); await this.publishChain; }
  private ingest(chunk: unknown): void { this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""); while (true) { const separatorIndex = this.buffer.indexOf("\n\n"); if (separatorIndex < 0) break; const frameText = this.buffer.slice(0, separatorIndex); this.buffer = this.buffer.slice(separatorIndex + 2); this.parseFrame(frameText); } }
  private flushBufferedFrame(): void { const frameText = this.buffer.trim(); this.buffer = ""; if (frameText) this.parseFrame(frameText); }
  private parseFrame(frameText: string): void { const dataLine = frameText.split("\n").find((line) => line.startsWith("data:")); if (!dataLine) return; const payload = dataLine.slice(5).trim(); if (!payload) return; if (payload === "[DONE]") { this.publishChain = this.publishChain.then(() => this.onFrame("[DONE]")); return; } try { const parsed = JSON.parse(payload); if (parsed && typeof parsed === "object") this.queueFrame(parsed as Record<string, unknown>); } catch {} }
  private queueFrame(frame: Record<string, unknown>): void { this.publishChain = this.publishChain.then(() => this.onFrame(frame)).catch((error) => this.onError(error)); }
}

function toRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function snapshotFromGeneration(generation: ChatGenerationRow): GenerationRequestSnapshot | null { const snapshot = toRecord(generation.execution_snapshot); const body = toRecord(snapshot.body); if (!body.message && typeof snapshot.message === "string") body.message = snapshot.message; if (!body.message) return null; body.conversationId = generation.conversation_id; body.conversation_id = generation.conversation_id; body.clientRequestId = generation.client_request_id ?? body.clientRequestId; body.client_request_id = generation.client_request_id ?? body.client_request_id; body.generationId = generation.id; body.generation_id = generation.id; body.executionMode = generation.execution_mode ?? body.executionMode ?? "fast"; body.execution_mode = generation.execution_mode ?? body.execution_mode ?? "fast"; return { body, originalUrl: typeof snapshot.originalUrl === "string" ? snapshot.originalUrl : "/api/chat", user: snapshot.user && typeof snapshot.user === "object" ? snapshot.user as Record<string, unknown> : { sub: generation.user_id, isGuest: false } }; }
function buildExecutionRequest(snapshot: GenerationRequestSnapshot, generation: ChatGenerationRow): GenerationExecutionRequest {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const abortController = new AbortController();
  const body = { ...toRecord(snapshot.body), conversationId: generation.conversation_id, conversation_id: generation.conversation_id, clientRequestId: generation.client_request_id ?? snapshot.body?.clientRequestId, client_request_id: generation.client_request_id ?? snapshot.body?.client_request_id, generationId: generation.id, generation_id: generation.id, executionMode: generation.execution_mode ?? snapshot.body?.executionMode ?? "fast", execution_mode: generation.execution_mode ?? snapshot.body?.execution_mode ?? "fast" };
  const headers = { ...(snapshot.headers ?? {}) };
  const ip = (snapshot as any)?.ip || (headers["x-forwarded-for"] || "").split(",")[0]?.trim() || "127.0.0.1";
  const query = (snapshot as any)?.query ?? {};
  const params = (snapshot as any)?.params ?? {};
  const path = (snapshot as any)?.path || snapshot.originalUrl || "/api/chat";
  const request: GenerationExecutionRequest = {
    body,
    headers,
    ip,
    socket: { remoteAddress: ip, encrypted: false },
    query,
    params,
    path,
    originalUrl: snapshot.originalUrl || "/api/chat",
    method: "POST",
    user: snapshot.user ?? { sub: generation.user_id, isGuest: false },
    complete: true,
    signal: abortController.signal,
    __sentiqGenerationDetached: true,
    once(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    on(event, listener) { const list = listeners.get(event) ?? []; list.push(listener); listeners.set(event, list); return request; },
    removeListener(event, listener) { const list = listeners.get(event) ?? []; listeners.set(event, list.filter((candidate) => candidate !== listener)); return request; },
    off(event, listener) { return request.removeListener(event, listener); },
    emit(event, ...args) { for (const listener of listeners.get(event) ?? []) { try { listener(...args); } catch {} } return true; },
    listeners(event) { return listeners.get(event) ?? []; },
    get(name) { const normalized = name.toLowerCase(); return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1]; },
    header(name) { return request.get(name); }
  };
  request.once("sentiq-generation-cancel", () => abortController.abort(new Error("Generation cancelled by user.")));
  request.once("close", () => { if (!abortController.signal.aborted && request.__sentiqGenerationDetached !== true) abortController.abort(); });
  return request;
}
function buildGuestGenerationRow(task: ReturnType<typeof chatGenerationTaskCoordinator.get>): ChatGenerationRow | null { if (!task) return null; const now = new Date().toISOString(); return { id: task.generationId, conversation_id: task.conversationId ?? "guest-conversation", user_id: task.userId, client_request_id: task.clientRequestId ?? null, generation_session_id: task.generationSessionId ?? null, status: task.status as ChatGenerationRow["status"], execution_mode: "fast", model_route: null, execution_snapshot: {}, started_at: now, completed_at: null, failed_at: null, cancelled_at: null, error_code: task.lastErrorCode, partial_text: task.partialText, tokens_generated: task.tokensGenerated, last_event_sequence: task.sequence, created_at: now, updated_at: now, execution_lease_id: null, execution_lease_expires_at: null, recovery_attempts: 0, last_execution_error: null }; }

export async function runGeneration(generationId: string): Promise<void> {
  const existingTask = chatGenerationTaskCoordinator.get(generationId);
  if (existingTask?.terminal) return;
  if (existingTask?.runPromise) return existingTask.runPromise;

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

  const taskContext: ChatGenerationTaskContext = {
    generationId: generation.id,
    clientRequestId: generation.client_request_id,
    generationSessionId: generation.generation_session_id,
    conversationId: generation.conversation_id,
    userId: generation.user_id,
    userDb,
    generation,
    liveExecutionSnapshot: existingTask?.liveExecutionSnapshot,
  };
  const task = chatGenerationTaskCoordinator.start(taskContext);
  if (task.terminal) return;
  if (task.runPromise) return task.runPromise;

  let currentRunPromise: Promise<void> | undefined = undefined;
  currentRunPromise = (async () => {
    try {
      if (task.explicitCancelRequested || generation.status === "cancel_requested") {
        await chatGenerationTaskCoordinator.cancelled(generation.id);
        return;
      }
      const requestSnapshot = task.liveExecutionSnapshot ?? snapshotFromGeneration(generation);
      if (!requestSnapshot) throw Object.assign(new Error("Generation request snapshot is unavailable"), { code: "generation_snapshot_unavailable" });
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
            await chatGenerationTaskCoordinator.publish(generation.id, {
              type: "generation_snapshot",
              status: "queued",
              reason: "concurrency_limit",
            });
            task.concurrencyRetries = (task.concurrencyRetries ?? 0) + 1;
            const maxRetries = getMaxConcurrencyRetries();
            if (task.concurrencyRetries > maxRetries) {
              await chatGenerationTaskCoordinator.failed(generation.id, "generation_concurrency_timeout");
              return;
            }
            const retryMs = getConcurrencyRetryMs();
            setTimeout(() => {
              if (!chatGenerationTaskCoordinator.get(generationId)?.terminal) {
                void runGeneration(generationId).catch(() => undefined);
              }
            }, retryMs).unref?.();
            return;
          }
          throw Object.assign(new Error("Generation execution lease unavailable"), {
            code: "generation_execution_lease_unavailable",
            cause: claimed.error,
          });
        }
        generation = claimed.data;
        task.generation = generation;
        task.executionLeaseId = leaseId;
      }

      await chatGenerationTaskCoordinator.publish(generation.id, {
        type: "generation_started",
        conversation_id: generation.conversation_id,
        status: "running",
      });
      const request = buildExecutionRequest(requestSnapshot, generation);
      request.userDb = userDb;
      request.generation = generation;
      request.canonicalConversationId = generation.conversation_id;
      let runnerError: unknown = null;
      let executionOwnershipLost = false;
      const sink = new GenerationEventSink(generation.id, async (frame) => {
        if (frame !== "[DONE]") {
          if (frame.type === "token" && typeof frame.text === "string") {
            chatGenerationTaskCoordinator.publishTokenFast(generation!.id, frame.text);
            return;
          }
          await chatGenerationTaskCoordinator.publish(generation!.id, frame);
        }
      }, (error) => {
        runnerError = runnerError ?? error;
        if (String((error as any)?.message || "").includes("lease lost")) {
          executionOwnershipLost = true;
          task.execution?.cancel();
        }
      });
      task.execution = { cancel: () => { request.emit("sentiq-generation-cancel"); request.emit("close"); } };

      const controlTimer = userDb ? setInterval(() => {
        void getChatGenerationById(userDb, generation!.user_id, generation!.id).then((latest) => {
          if (latest.error || !latest.data) return;
          const currentLeaseId = latest.data.execution_lease_id;
          const currentStatus = String(latest.data.status || "");
          if (currentLeaseId !== leaseId) {
            executionOwnershipLost = true;
            task.execution?.cancel();
            return;
          }
          if (["cancel_requested", "cancelled"].includes(currentStatus)) {
            task.explicitCancelRequested = true;
            task.status = "cancel_requested";
            task.execution?.cancel();
          }
        }).catch(() => undefined);
      }, CONTROL_POLL_MS) : null;
      controlTimer?.unref?.();

      const renewTimer = userDb ? setInterval(() => {
        void import("./chatGenerationService").then(({ renewChatGenerationExecutionLease }) =>
          renewChatGenerationExecutionLease(userDb, { userId: generation!.user_id, generationId: generation!.id, leaseId, leaseSeconds: 60 }),
        ).then((renewed) => {
          if (renewed.error || !renewed.data) {
            executionOwnershipLost = true;
            task.execution?.cancel();
          }
        }).catch(() => {
          executionOwnershipLost = true;
          task.execution?.cancel();
        });
      }, LEASE_RENEW_MS) : null;
      renewTimer?.unref?.();

      try {
        task.status = "running";
        await executeChatGeneration(request, sink);
        await sink.flush();
        if (executionOwnershipLost) {
          if (userDb) {
            const latest = await getChatGenerationById(userDb, generation!.user_id, generation!.id).catch(() => ({ data: null }));
            if (latest?.data && ["completed", "failed", "cancelled"].includes(latest.data.status)) {
              if (latest.data.status === "completed") {
                await chatGenerationTaskCoordinator.complete(generation!.id);
                return;
              } else if (latest.data.status === "cancelled") {
                await chatGenerationTaskCoordinator.cancelled(generation!.id);
                return;
              } else {
                await chatGenerationTaskCoordinator.failed(generation!.id, latest.data.error_code || "generation_failed");
                return;
              }
            }
          }
          return;
        }
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else if (runnerError) await chatGenerationTaskCoordinator.failed(generation!.id, String((runnerError as any)?.code || (runnerError as any)?.name || "generation_failed"));
        else await chatGenerationTaskCoordinator.complete(generation!.id);
      } catch (error) {
        runnerError = error;
        if (executionOwnershipLost) {
          if (userDb) {
            const latest = await getChatGenerationById(userDb, generation!.user_id, generation!.id).catch(() => ({ data: null }));
            if (latest?.data && ["completed", "failed", "cancelled"].includes(latest.data.status)) {
              if (latest.data.status === "completed") {
                await chatGenerationTaskCoordinator.complete(generation!.id);
                return;
              } else if (latest.data.status === "cancelled") {
                await chatGenerationTaskCoordinator.cancelled(generation!.id);
                return;
              } else {
                await chatGenerationTaskCoordinator.failed(generation!.id, latest.data.error_code || "generation_failed");
                return;
              }
            }
          }
          return;
        }
        if (task.explicitCancelRequested || request.signal.aborted) await chatGenerationTaskCoordinator.cancelled(generation!.id);
        else await chatGenerationTaskCoordinator.failed(generation!.id, String((error as any)?.code || (error as any)?.name || "generation_failed"));
      } finally {
        if (controlTimer) clearInterval(controlTimer);
        if (renewTimer) clearInterval(renewTimer);
        if (userDb) await releaseChatGenerationExecutionLease(userDb, { userId: generation!.user_id, generationId: generation!.id, leaseId }).catch(() => undefined);
        if (generation?.client_request_id) {
          try { closeTokenAllowanceAccounting({ requestId: generation.client_request_id, releasePending: true }); }
          catch (error) { console.warn(`[GenerationQuota] settlement cleanup failed generation=${generation.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        task.execution = undefined;
        task.executionLeaseId = null;
      }
    } finally {
      if (task.runPromise === currentRunPromise) {
        task.runPromise = undefined;
      }
    }
  })();

  task.runPromise = currentRunPromise;
  return currentRunPromise;
}
