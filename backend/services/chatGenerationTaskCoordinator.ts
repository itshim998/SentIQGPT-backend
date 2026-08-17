import { cancelChatGeneration, type ChatGenerationRow } from "./chatGenerationService";
import { expireStaleChatGenerationSessions } from "./chatGenerationSessionService";
import { appendChatGenerationEventFenced, listChatGenerationEvents, normalizeStoredGenerationEvent } from "./chatGenerationEventService";
import { normalizeGenerationEventType, type CanonicalGenerationEvent } from "./generationEventTypes";

export type ChatGenerationEvent = CanonicalGenerationEvent;
export type ChatGenerationExecution = { cancel: () => void };
export type LiveExecutionSnapshot = { body: Record<string, unknown>; headers?: Record<string, string>; originalUrl?: string; user?: Record<string, unknown> | null };
export type ChatGenerationTaskContext = {
  generationId: string; clientRequestId?: string | null; userId: string; conversationId?: string | null; generationSessionId?: string | null; userDb?: any; generation?: ChatGenerationRow | null; liveExecutionSnapshot?: LiveExecutionSnapshot;
};
type SubscriberState = { callback: Subscriber; nextSequence: number };
type Subscriber = (event: ChatGenerationEvent) => void | Promise<void>;
type Task = ChatGenerationTaskContext & {
  events: ChatGenerationEvent[]; subscribers: Set<SubscriberState>; sequence: number; partialText: string; tokensGenerated: number;
  status: "queued" | "running" | "completed" | "failed" | "cancel_requested" | "cancelled"; terminal: boolean; explicitCancelRequested: boolean;
  lastErrorCode: string | null; executionLeaseId: string | null; execution?: ChatGenerationExecution; runPromise?: Promise<void>; cleanupTimer?: NodeJS.Timeout;
  deliveryChain: Promise<void>; pollTimer?: NodeJS.Timeout; pollInFlight: boolean;
};

const EVENT_BUFFER_LIMIT = 1000;
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const SESSION_LEASE_SECONDS = 45;
const SESSION_LEASE_SWEEP_MS = 15000;
const DURABLE_EVENT_POLL_MS = 1000;
const TERMINAL_EVENT_TYPES = new Set(["generation_completed", "generation_failed", "generation_cancelled"]);

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
      if (context.generation?.execution_lease_id && !existing.executionLeaseId) existing.executionLeaseId = context.generation.execution_lease_id;
      return existing;
    }
    const persistedSequence = Math.max(0, Number(context.generation?.last_event_sequence ?? 0));
    const persistedStatus = String(context.generation?.status ?? "queued");
    const task: Task = {
      ...context, conversationId: context.conversationId ?? context.generation?.conversation_id ?? null, generationSessionId: context.generationSessionId ?? context.generation?.generation_session_id ?? null,
      events: [], subscribers: new Set(), sequence: persistedSequence, partialText: String(context.generation?.partial_text ?? ""), tokensGenerated: Number(context.generation?.tokens_generated ?? 0),
      status: persistedStatus === "cancel_requested" ? "cancel_requested" : ["completed","failed","cancelled"].includes(persistedStatus) ? persistedStatus as Task["status"] : "queued",
      terminal: ["completed","failed","cancelled"].includes(persistedStatus), explicitCancelRequested: persistedStatus === "cancel_requested", lastErrorCode: context.generation?.error_code ?? null,
      executionLeaseId: context.generation?.execution_lease_id ?? null, deliveryChain: Promise.resolve(), pollInFlight: false,
    };
    this.tasks.set(task.generationId, task); return task;
  }

  private appendEvent(task: Task, payload: Record<string, unknown>, explicitSequence?: number): ChatGenerationEvent {
    const originalType = typeof payload.type === "string" ? payload.type : "";
    const canonicalType = normalizeGenerationEventType(originalType);
    const event: ChatGenerationEvent = { ...payload, generation_id: task.generationId, conversation_id: task.conversationId ?? task.generation?.conversation_id ?? null, sequence: explicitSequence ?? ++task.sequence, type: canonicalType ?? (originalType || "generation_event") as ChatGenerationEvent["type"], ...(canonicalType && canonicalType !== originalType ? { original_type: originalType } : {}) } as ChatGenerationEvent;
    task.sequence = Math.max(task.sequence, Number(event.sequence));
    if (!task.events.some((candidate) => candidate.sequence === event.sequence)) task.events.push(event);
    task.events.sort((left, right) => left.sequence - right.sequence);
    if (task.events.length > EVENT_BUFFER_LIMIT) task.events.splice(0, task.events.length - EVENT_BUFFER_LIMIT);
    return event;
  }

  private enqueue(task: Task, job: () => Promise<void>): Promise<void> { task.deliveryChain = task.deliveryChain.then(job, job); return task.deliveryChain; }

  private async notify(task: Task, event: ChatGenerationEvent): Promise<void> {
    const states = Array.from(task.subscribers);
    await Promise.allSettled(states.filter((state) => Number(event.sequence) > state.nextSequence).map(async (state) => { await state.callback(event); state.nextSequence = Number(event.sequence); }));
  }

  private async persistEvent(task: Task, event: ChatGenerationEvent, state?: { partialText?: string; tokensGenerated?: number; status?: string; errorCode?: string | null }): Promise<void> {
    if (!task.userDb || !task.executionLeaseId) return;
    const terminal = TERMINAL_EVENT_TYPES.has(String(event.type));
    const durableStatus = terminal ? (state?.status ?? task.status) : (["failed", "cancelled"].includes(String(state?.status ?? task.status)) ? "running" : (state?.status ?? task.status));
    const result = await appendChatGenerationEventFenced(task.userDb, {
      userId: task.userId, generationId: task.generationId, leaseId: task.executionLeaseId, event,
      partialText: state?.partialText ?? task.partialText, tokensGenerated: state?.tokensGenerated ?? task.tokensGenerated,
      status: durableStatus, errorCode: state?.errorCode ?? task.lastErrorCode,
    });
    if (result.error || !result.data) throw result.error || new Error("Generation event persistence failed");
  }

  private async importDurableEvents(task: Task, afterSequence: number): Promise<ChatGenerationEvent[]> {
    if (!task.userDb) return [];
    const result = await listChatGenerationEvents(task.userDb, { userId: task.userId, generationId: task.generationId, afterSequence, limit: EVENT_BUFFER_LIMIT });
    if (result.error) throw result.error;
    return result.data.map(normalizeStoredGenerationEvent).filter((event): event is ChatGenerationEvent => Boolean(event));
  }

  private startPolling(task: Task): void {
    if (!task.userDb || task.pollTimer || task.terminal) return;
    task.pollTimer = setInterval(() => { if (!task.subscribers.size || task.terminal) return; void this.enqueue(task, () => this.pollDurableEvents(task)).catch((error) => console.warn(`[GenerationEvents] durable poll failed generation=${task.generationId}: ${error instanceof Error ? error.message : String(error)}`)); }, DURABLE_EVENT_POLL_MS);
    task.pollTimer.unref?.();
  }
  private stopPolling(task: Task): void { if (task.pollTimer) clearInterval(task.pollTimer); task.pollTimer = undefined; }

  private async pollDurableEvents(task: Task): Promise<void> {
    if (task.pollInFlight || !task.subscribers.size || !task.userDb) return;
    task.pollInFlight = true;
    try {
      const events = await this.importDurableEvents(task, task.sequence);
      for (const event of events) {
        this.appendEvent(task, event, Number(event.sequence));
        if (typeof event.partial_text === "string") task.partialText = event.partial_text;
        if (Number.isFinite(Number(event.tokens_generated))) task.tokensGenerated = Number(event.tokens_generated);
        if (typeof event.status === "string") task.status = event.status as Task["status"];
        if (typeof event.error_code === "string") task.lastErrorCode = event.error_code;
        await this.notify(task, event);
        if (TERMINAL_EVENT_TYPES.has(String(event.type))) { task.terminal = true; this.stopPolling(task); break; }
      }
    } finally { task.pollInFlight = false; }
  }

  async publish(generationId: string, payload: Record<string, unknown>): Promise<ChatGenerationEvent | null> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return null;
    if (payload.type === "token" && typeof payload.text === "string") { task.partialText += payload.text; task.tokensGenerated += 1; task.status = "running"; }
    else if (payload.type === "error") { task.lastErrorCode = typeof payload.code === "string" && payload.code ? payload.code : "generation_failed"; task.status = "failed"; }
    else if (payload.type === "generation_snapshot") { task.status = typeof payload.status === "string" ? payload.status as Task["status"] : task.status; if (typeof payload.partial_text === "string") task.partialText = payload.partial_text; if (Number.isFinite(Number(payload.tokens_generated))) task.tokensGenerated = Number(payload.tokens_generated); }
    else task.status = task.status === "queued" ? "running" : task.status;
    const event = this.appendEvent(task, payload);
    const eventState = { partialText: task.partialText, tokensGenerated: task.tokensGenerated, status: task.status, errorCode: task.lastErrorCode };
    await this.enqueue(task, async () => { await this.persistEvent(task, event, eventState); await this.notify(task, event); });
    return event;
  }

  async snapshot(generationId: string, persisted?: ChatGenerationRow | null): Promise<Record<string, unknown>> {
    const task = this.tasks.get(generationId);
    if (task) return { type: "generation_snapshot", generation_id: task.generationId, conversation_id: task.conversationId ?? task.generation?.conversation_id ?? null, client_request_id: task.clientRequestId ?? null, generation_session_id: task.generationSessionId ?? null, status: task.status, partial_text: task.partialText, tokens_generated: task.tokensGenerated, last_event_sequence: task.sequence, sequence: task.sequence, terminal: task.terminal, error_code: task.lastErrorCode };
    const sequence = Number(persisted?.last_event_sequence ?? 0);
    return { type: "generation_snapshot", generation_id: generationId, conversation_id: persisted?.conversation_id ?? null, client_request_id: persisted?.client_request_id ?? null, generation_session_id: persisted?.generation_session_id ?? null, execution_mode: persisted?.execution_mode ?? null, status: persisted?.status ?? "queued", partial_text: persisted?.partial_text ?? "", tokens_generated: Number(persisted?.tokens_generated ?? 0), last_event_sequence: sequence, sequence, terminal: ["completed","failed","cancelled"].includes(String(persisted?.status ?? "")), error_code: persisted?.error_code ?? null };
  }

  getReplayInfo(generationId: string, afterSequence = 0): { canReplay: boolean; oldestSequence: number | null; latestSequence: number } {
    const task = this.tasks.get(generationId); if (!task) return { canReplay: false, oldestSequence: null, latestSequence: 0 };
    const normalizedAfter = Math.max(0, Math.floor(afterSequence)); const oldestSequence = task.events.length ? task.events[0].sequence : null; const latestSequence = task.sequence;
    return { canReplay: normalizedAfter >= latestSequence || oldestSequence === null || normalizedAfter >= oldestSequence - 1, oldestSequence, latestSequence };
  }

  subscribe(generationId: string, subscriber: Subscriber, afterSequence = 0): () => void {
    const task = this.tasks.get(generationId); if (!task) return () => undefined;
    const state: SubscriberState = { callback: subscriber, nextSequence: Math.max(0, Math.floor(afterSequence)) };
    task.subscribers.add(state); this.startPolling(task);
    void this.enqueue(task, async () => {
      const durable = await this.importDurableEvents(task, state.nextSequence);
      for (const event of durable) { if (Number(event.sequence) <= state.nextSequence) continue; this.appendEvent(task, event, Number(event.sequence)); await state.callback(event); state.nextSequence = Number(event.sequence); if (TERMINAL_EVENT_TYPES.has(String(event.type))) task.terminal = true; }
      const local = task.events.filter((event) => Number(event.sequence) > state.nextSequence).sort((left, right) => left.sequence - right.sequence);
      for (const event of local) { await state.callback(event); state.nextSequence = Number(event.sequence); if (TERMINAL_EVENT_TYPES.has(String(event.type))) task.terminal = true; }
      if (task.terminal) this.stopPolling(task);
    }).catch((error) => console.warn(`[GenerationEvents] replay failed generation=${generationId}: ${error instanceof Error ? error.message : String(error)}`));
    return () => { task.subscribers.delete(state); if (!task.subscribers.size) this.stopPolling(task); };
  }

  async complete(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return; if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "completed"; const event = this.appendEvent(task, { type: "generation_completed", status: "completed", partial_text: task.partialText }); const eventState = { partialText: task.partialText, tokensGenerated: task.tokensGenerated, status: "completed", errorCode: task.lastErrorCode }; task.terminal = true;
    await this.enqueue(task, async () => { await this.persistEvent(task, event, eventState); await this.notify(task, event); }); this.stopPolling(task); task.subscribers.clear(); this.scheduleCleanup(task);
  }

  async failed(generationId: string, errorCode = "generation_failed"): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return; if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "failed"; task.lastErrorCode = errorCode || "generation_failed"; const event = this.appendEvent(task, { type: "generation_failed", status: "failed", partial_text: task.partialText, error_code: task.lastErrorCode }); const eventState = { partialText: task.partialText, tokensGenerated: task.tokensGenerated, status: "failed", errorCode: task.lastErrorCode }; task.terminal = true;
    await this.enqueue(task, async () => { await this.persistEvent(task, event, eventState); await this.notify(task, event); }); this.stopPolling(task); task.subscribers.clear(); this.scheduleCleanup(task);
  }

  async cancelled(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId); if (!task || task.terminal) return;
    task.status = "cancelled"; task.explicitCancelRequested = true; const event = this.appendEvent(task, { type: "generation_cancelled", status: "cancelled", partial_text: task.partialText }); const eventState = { partialText: task.partialText, tokensGenerated: task.tokensGenerated, status: "cancelled", errorCode: task.lastErrorCode }; task.terminal = true;
    if (task.userDb && task.executionLeaseId) await this.enqueue(task, async () => { await this.persistEvent(task, event, eventState); await this.notify(task, event); }); else { await this.enqueue(task, async () => { await this.notify(task, event); }); if (task.userDb) await cancelChatGeneration(task.userDb, task.userId, task.generationId).catch(() => undefined); }
    this.stopPolling(task); task.subscribers.clear(); this.scheduleCleanup(task);
  }

  async requestCancel(generationId: string): Promise<boolean> { const task = this.tasks.get(generationId); if (!task || task.terminal) return false; task.explicitCancelRequested = true; task.status = "cancel_requested"; task.execution?.cancel(); return true; }
  isExplicitCancelRequested(generationId: string): boolean { return Boolean(this.tasks.get(generationId)?.explicitCancelRequested); }

  private async sweepExpiredGenerationSessions(): Promise<void> {
    const byDb = new Map<any, Task[]>(); for (const task of this.tasks.values()) { if (task.terminal || !task.generationSessionId || !task.userDb) continue; const list = byDb.get(task.userDb) ?? []; list.push(task); byDb.set(task.userDb, list); }
    for (const [userDb, tasks] of byDb) { try { const expired = await expireStaleChatGenerationSessions(userDb, SESSION_LEASE_SECONDS); if (expired.error || !expired.data?.length) continue; const staleIds = new Set(expired.data.map((row: any) => String(row.session_id))); for (const task of tasks) if (task.generationSessionId && staleIds.has(task.generationSessionId)) await this.requestCancel(task.generationId); } catch (error) { console.warn(`[GenerationSessionLease] sweep failed: ${error instanceof Error ? error.message : String(error)}`); } }
  }

  private scheduleCleanup(task: Task): void { if (task.cleanupTimer) clearTimeout(task.cleanupTimer); task.cleanupTimer = setTimeout(() => { if (this.tasks.get(task.generationId) === task) this.tasks.delete(task.generationId); }, TERMINAL_RETENTION_MS); task.cleanupTimer.unref?.(); }
}

export const chatGenerationTaskCoordinator = new ChatGenerationTaskCoordinator();
