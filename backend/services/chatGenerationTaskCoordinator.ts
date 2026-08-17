import { cancelChatGeneration, type ChatGenerationRow } from "./chatGenerationService";
import { expireStaleChatGenerationSessions } from "./chatGenerationSessionService";
import { checkpointChatGenerationFenced, finalizeChatGenerationFenced } from "./chatGenerationFencedService";
import { normalizeGenerationEventType, type CanonicalGenerationEvent } from "./generationEventTypes";

export type ChatGenerationEvent = CanonicalGenerationEvent;
export type ChatGenerationExecution = { cancel: () => void };
export type LiveExecutionSnapshot = { body: Record<string, unknown>; headers?: Record<string, string>; originalUrl?: string; user?: Record<string, unknown> | null };
export type ChatGenerationTaskContext = {
  generationId: string;
  clientRequestId?: string | null;
  userId: string;
  conversationId?: string | null;
  generationSessionId?: string | null;
  userDb?: any;
  generation?: ChatGenerationRow | null;
  liveExecutionSnapshot?: LiveExecutionSnapshot;
};
type Subscriber = (event: ChatGenerationEvent) => void | Promise<void>;
type Task = ChatGenerationTaskContext & {
  events: ChatGenerationEvent[];
  subscribers: Set<Subscriber>;
  sequence: number;
  partialText: string;
  tokensGenerated: number;
  status: "queued" | "running" | "completed" | "failed" | "cancel_requested" | "cancelled";
  terminal: boolean;
  explicitCancelRequested: boolean;
  lastCheckpointAt: number;
  lastCheckpointTokens: number;
  lastErrorCode: string | null;
  executionLeaseId: string | null;
  execution?: ChatGenerationExecution;
  runPromise?: Promise<void>;
  cleanupTimer?: NodeJS.Timeout;
};

const EVENT_BUFFER_LIMIT = 1000;
const CHECKPOINT_INTERVAL_MS = 750;
const CHECKPOINT_TOKEN_INTERVAL = 75;
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const SESSION_LEASE_SECONDS = 45;
const SESSION_LEASE_SWEEP_MS = 15000;

class ChatGenerationTaskCoordinator {
  private readonly tasks = new Map<string, Task>();
  private readonly leaseTimer: NodeJS.Timeout;
  constructor() { this.leaseTimer = setInterval(() => { void this.sweepExpiredGenerationSessions(); }, SESSION_LEASE_SWEEP_MS); this.leaseTimer.unref?.(); }
  has(generationId: string): boolean { return this.tasks.has(generationId); }
  get(generationId: string): Task | null { return this.tasks.get(generationId) ?? null; }
  findByClientRequestId(clientRequestId: string): Task | null { const normalized = String(clientRequestId || "").trim(); return normalized ? Array.from(this.tasks.values()).find((task) => task.clientRequestId === normalized) ?? null : null; }

  start(context: ChatGenerationTaskContext): Task {
    const existing = this.tasks.get(context.generationId);
    if (existing) {
      if (context.userDb && !existing.userDb) existing.userDb = context.userDb;
      if (context.generation && !existing.generation) existing.generation = context.generation;
      if (context.generationSessionId && !existing.generationSessionId) existing.generationSessionId = context.generationSessionId;
      if (context.conversationId && !existing.conversationId) existing.conversationId = context.conversationId;
      if (context.liveExecutionSnapshot && !existing.liveExecutionSnapshot) existing.liveExecutionSnapshot = context.liveExecutionSnapshot;
      return existing;
    }
    const persistedSequence = Math.max(0, Number(context.generation?.last_event_sequence ?? 0));
    const persistedStatus = String(context.generation?.status ?? "queued");
    const task: Task = {
      ...context,
      conversationId: context.conversationId ?? context.generation?.conversation_id ?? null,
      generationSessionId: context.generationSessionId ?? context.generation?.generation_session_id ?? null,
      events: [],
      subscribers: new Set(),
      sequence: persistedSequence,
      partialText: String(context.generation?.partial_text ?? ""),
      tokensGenerated: Number(context.generation?.tokens_generated ?? 0),
      status: persistedStatus === "cancel_requested" ? "cancel_requested" : ["completed","failed","cancelled"].includes(persistedStatus) ? persistedStatus as Task["status"] : "queued",
      terminal: ["completed","failed","cancelled"].includes(persistedStatus),
      explicitCancelRequested: persistedStatus === "cancel_requested",
      lastCheckpointAt: Date.now(),
      lastCheckpointTokens: Number(context.generation?.tokens_generated ?? 0),
      lastErrorCode: context.generation?.error_code ?? null,
      executionLeaseId: context.generation?.execution_lease_id ?? null,
    };
    this.tasks.set(task.generationId, task);
    return task;
  }

  private appendEvent(task: Task, payload: Record<string, unknown>): ChatGenerationEvent {
    const originalType = typeof payload.type === "string" ? payload.type : "";
    const canonicalType = normalizeGenerationEventType(originalType);
    const event: ChatGenerationEvent = {
      ...payload,
      generation_id: task.generationId,
      conversation_id: task.conversationId ?? task.generation?.conversation_id ?? null,
      sequence: ++task.sequence,
      type: canonicalType ?? (originalType || "generation_checkpoint") as ChatGenerationEvent["type"],
      ...(canonicalType && canonicalType !== originalType ? { original_type: originalType } : {}),
    } as ChatGenerationEvent;
    task.events.push(event);
    if (task.events.length > EVENT_BUFFER_LIMIT) task.events.splice(0, task.events.length - EVENT_BUFFER_LIMIT);
    return event;
  }

  private async notify(task: Task, event: ChatGenerationEvent): Promise<void> { await Promise.allSettled(Array.from(task.subscribers, (subscriber) => subscriber(event))); }

  async publish(generationId: string, payload: Record<string, unknown>): Promise<ChatGenerationEvent | null> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return null;
    if (payload.type === "token" && typeof payload.text === "string") { task.partialText += payload.text; task.tokensGenerated += 1; task.status = "running"; }
    else if (payload.type === "error") { task.lastErrorCode = typeof payload.code === "string" && payload.code ? payload.code : "generation_failed"; task.status = "failed"; }
    else if (payload.type === "generation_snapshot") { task.status = typeof payload.status === "string" ? payload.status as Task["status"] : task.status; if (typeof payload.partial_text === "string") task.partialText = payload.partial_text; if (Number.isFinite(Number(payload.tokens_generated))) task.tokensGenerated = Number(payload.tokens_generated); }
    else task.status = task.status === "queued" ? "running" : task.status;
    const event = this.appendEvent(task, payload);
    const checkpointEvent = await this.checkpoint(task, false);
    await this.notify(task, event);
    if (checkpointEvent) await this.notify(task, checkpointEvent);
    return event;
  }

  async snapshot(generationId: string, persisted?: ChatGenerationRow | null): Promise<Record<string, unknown>> {
    const task = this.tasks.get(generationId);
    if (task) return { type: "generation_snapshot", generation_id: task.generationId, conversation_id: task.conversationId ?? task.generation?.conversation_id ?? null, client_request_id: task.clientRequestId ?? null, generation_session_id: task.generationSessionId ?? null, status: task.status, partial_text: task.partialText, tokens_generated: task.tokensGenerated, last_event_sequence: task.sequence, sequence: task.sequence, terminal: task.terminal, error_code: task.lastErrorCode };
    const sequence = Number(persisted?.last_event_sequence ?? 0);
    return { type: "generation_snapshot", generation_id: generationId, conversation_id: persisted?.conversation_id ?? null, client_request_id: persisted?.client_request_id ?? null, generation_session_id: persisted?.generation_session_id ?? null, execution_mode: persisted?.execution_mode ?? null, status: persisted?.status ?? "queued", partial_text: persisted?.partial_text ?? "", tokens_generated: Number(persisted?.tokens_generated ?? 0), last_event_sequence: sequence, sequence, terminal: ["completed","failed","cancelled"].includes(String(persisted?.status ?? "")), error_code: persisted?.error_code ?? null };
  }
  getReplayInfo(generationId: string, afterSequence = 0): { canReplay: boolean; oldestSequence: number | null; latestSequence: number } { const task = this.tasks.get(generationId); if (!task) return { canReplay: false, oldestSequence: null, latestSequence: 0 }; const normalizedAfter = Math.max(0, Math.floor(afterSequence)); const oldestSequence = task.events.length ? task.events[0].sequence : null; const latestSequence = task.sequence; if (normalizedAfter >= latestSequence) return { canReplay: true, oldestSequence, latestSequence }; if (oldestSequence === null) return { canReplay: normalizedAfter === latestSequence, oldestSequence, latestSequence }; return { canReplay: normalizedAfter >= oldestSequence - 1, oldestSequence, latestSequence }; }
  subscribe(generationId: string, subscriber: Subscriber, afterSequence = 0): () => void { const task = this.tasks.get(generationId); if (!task) return () => undefined; if (!task.terminal) task.subscribers.add(subscriber); const replay = task.events.filter((event) => event.sequence > Math.max(0, Math.floor(afterSequence))); for (const event of replay) void Promise.resolve(subscriber(event)).catch(() => undefined); return () => { task.subscribers.delete(subscriber); }; }

  async complete(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return;
    if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "completed"; task.terminal = true;
    if (task.userDb && task.executionLeaseId) {
      const fenced = await finalizeChatGenerationFenced(task.userDb, { userId: task.userId, generationId: task.generationId, leaseId: task.executionLeaseId, status: "completed", partialText: task.partialText, tokensGenerated: task.tokensGenerated, lastEventSequence: task.sequence });
      if (fenced.error || !fenced.data) throw fenced.error || new Error("Generation execution lease lost");
    }
    await this.emitTerminal(task, "generation_completed", "completed");
  }

  async failed(generationId: string, errorCode = "generation_failed"): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return;
    if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "failed"; task.terminal = true; task.lastErrorCode = errorCode || "generation_failed";
    if (task.userDb && task.executionLeaseId) {
      const fenced = await finalizeChatGenerationFenced(task.userDb, { userId: task.userId, generationId: task.generationId, leaseId: task.executionLeaseId, status: "failed", errorCode: task.lastErrorCode, partialText: task.partialText, tokensGenerated: task.tokensGenerated, lastEventSequence: task.sequence });
      if (fenced.error || !fenced.data) throw fenced.error || new Error("Generation execution lease lost");
    }
    await this.emitTerminal(task, "generation_failed", "failed");
  }

  async cancelled(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return;
    task.status = "cancelled"; task.terminal = true; task.explicitCancelRequested = true;
    if (task.userDb && task.executionLeaseId) {
      const fenced = await finalizeChatGenerationFenced(task.userDb, { userId: task.userId, generationId: task.generationId, leaseId: task.executionLeaseId, status: "cancelled", partialText: task.partialText, tokensGenerated: task.tokensGenerated, lastEventSequence: task.sequence });
      if (fenced.error || !fenced.data) throw fenced.error || new Error("Generation execution lease lost");
    } else if (task.userDb) {
      await cancelChatGeneration(task.userDb, task.userId, task.generationId).catch(() => undefined);
    }
    await this.emitTerminal(task, "generation_cancelled", "cancelled");
  }

  async requestCancel(generationId: string): Promise<boolean> { const task = this.tasks.get(generationId); if (!task || task.terminal) return false; task.explicitCancelRequested = true; task.status = "cancel_requested"; task.execution?.cancel(); return true; }
  isExplicitCancelRequested(generationId: string): boolean { return Boolean(this.tasks.get(generationId)?.explicitCancelRequested); }

  private async sweepExpiredGenerationSessions(): Promise<void> {
    const byDb = new Map<any, Task[]>();
    for (const task of this.tasks.values()) { if (task.terminal || !task.generationSessionId || !task.userDb) continue; const list = byDb.get(task.userDb) ?? []; list.push(task); byDb.set(task.userDb, list); }
    for (const [userDb, tasks] of byDb) {
      try {
        const expired = await expireStaleChatGenerationSessions(userDb, SESSION_LEASE_SECONDS);
        if (expired.error || !expired.data?.length) continue;
        const staleIds = new Set(expired.data.map((row: any) => String(row.session_id)));
        for (const task of tasks) if (task.generationSessionId && staleIds.has(task.generationSessionId)) await this.requestCancel(task.generationId);
      } catch (error) { console.warn(`[GenerationSessionLease] sweep failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async emitTerminal(task: Task, type: "generation_completed" | "generation_failed" | "generation_cancelled", status: string) {
    const event = this.appendEvent(task, { type, status, partial_text: task.partialText, ...(task.lastErrorCode ? { error_code: task.lastErrorCode } : {}) });
    await this.notify(task, event); task.subscribers.clear(); this.scheduleCleanup(task);
  }

  private async checkpoint(task: Task, force: boolean): Promise<ChatGenerationEvent | null> {
    if (!task.userDb || !task.executionLeaseId) return null;
    const now = Date.now(); const tokenDelta = task.tokensGenerated - task.lastCheckpointTokens;
    if (!force && now - task.lastCheckpointAt < CHECKPOINT_INTERVAL_MS && tokenDelta < CHECKPOINT_TOKEN_INTERVAL) return null;
    task.lastCheckpointAt = now; task.lastCheckpointTokens = task.tokensGenerated;
    const checkpointEvent = task.terminal ? null : this.appendEvent(task, { type: "generation_checkpoint", status: task.status, partial_text: task.partialText, tokens_generated: task.tokensGenerated, last_event_sequence: task.sequence });
    const fenced = await checkpointChatGenerationFenced(task.userDb, { userId: task.userId, generationId: task.generationId, leaseId: task.executionLeaseId, partialText: task.partialText, tokensGenerated: task.tokensGenerated, lastEventSequence: checkpointEvent?.sequence ?? task.sequence, status: task.status === "queued" ? "running" : task.status });
    if (fenced.error || !fenced.data) throw fenced.error || new Error("Generation execution lease lost");
    return checkpointEvent;
  }
  private scheduleCleanup(task: Task): void { if (task.cleanupTimer) clearTimeout(task.cleanupTimer); task.cleanupTimer = setTimeout(() => { if (this.tasks.get(task.generationId) === task) this.tasks.delete(task.generationId); }, TERMINAL_RETENTION_MS); task.cleanupTimer.unref?.(); }
}

export const chatGenerationTaskCoordinator = new ChatGenerationTaskCoordinator();
