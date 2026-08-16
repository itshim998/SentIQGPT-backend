import {
  checkpointChatGeneration,
  cancelChatGeneration,
  markChatGenerationCompleted,
  markChatGenerationFailed,
  type ChatGenerationRow,
} from "./chatGenerationService";

export type ChatGenerationEvent = {
  generation_id: string;
  sequence: number;
  type: string;
  [key: string]: unknown;
};

export type ChatGenerationExecution = {
  cancel: () => void;
};

export type ChatGenerationTaskContext = {
  generationId: string;
  clientRequestId?: string | null;
  userId: string;
  userDb?: any;
  generation?: ChatGenerationRow | null;
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
  execution?: ChatGenerationExecution;
  runPromise?: Promise<void>;
  cleanupTimer?: NodeJS.Timeout;
};

const EVENT_BUFFER_LIMIT = 1000;
const CHECKPOINT_INTERVAL_MS = 750;
const CHECKPOINT_TOKEN_INTERVAL = 75;
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;

class ChatGenerationTaskCoordinator {
  private readonly tasks = new Map<string, Task>();

  has(generationId: string): boolean { return this.tasks.has(generationId); }
  get(generationId: string): Task | null { return this.tasks.get(generationId) ?? null; }

  findByClientRequestId(clientRequestId: string): Task | null {
    const normalized = String(clientRequestId || "").trim();
    if (!normalized) return null;
    return Array.from(this.tasks.values()).find((task) => task.clientRequestId === normalized) ?? null;
  }

  start(context: ChatGenerationTaskContext): Task {
    const existing = this.tasks.get(context.generationId);
    if (existing) {
      if (context.userDb && !existing.userDb) existing.userDb = context.userDb;
      if (context.generation && !existing.generation) existing.generation = context.generation;
      return existing;
    }
    const task: Task = {
      ...context,
      events: [],
      subscribers: new Set(),
      sequence: Number(context.generation?.last_event_sequence ?? 0),
      partialText: String(context.generation?.partial_text ?? ""),
      tokensGenerated: Number(context.generation?.tokens_generated ?? 0),
      status: context.generation?.status === "cancel_requested" ? "cancel_requested" : "queued",
      terminal: ["completed", "failed", "cancelled"].includes(String(context.generation?.status)),
      explicitCancelRequested: context.generation?.status === "cancel_requested",
      lastCheckpointAt: Date.now(),
      lastCheckpointTokens: Number(context.generation?.tokens_generated ?? 0),
      lastErrorCode: context.generation?.error_code ?? null,
    };
    this.tasks.set(task.generationId, task);
    return task;
  }

  async publish(generationId: string, payload: Record<string, unknown>): Promise<ChatGenerationEvent | null> {
    const task = this.tasks.get(generationId);
    if (!task || task.terminal) return null;

    if (payload.type === "token" && typeof payload.text === "string") {
      task.partialText += payload.text;
      task.tokensGenerated += 1;
      task.status = "running";
    } else if (payload.type === "error") {
      task.lastErrorCode = typeof payload.code === "string" && payload.code ? payload.code : "generation_failed";
      task.status = "failed";
    } else if (payload.type === "generation_snapshot") {
      task.status = typeof payload.status === "string" ? payload.status as Task["status"] : task.status;
      if (typeof payload.partial_text === "string") task.partialText = payload.partial_text;
      if (Number.isFinite(Number(payload.tokens_generated))) task.tokensGenerated = Number(payload.tokens_generated);
    } else {
      task.status = task.status === "queued" ? "running" : task.status;
    }

    task.sequence += 1;
    const event: ChatGenerationEvent = { ...payload, generation_id: task.generationId, sequence: task.sequence };
    task.events.push(event);
    if (task.events.length > EVENT_BUFFER_LIMIT) task.events.splice(0, task.events.length - EVENT_BUFFER_LIMIT);
    await this.checkpoint(task, false);
    await Promise.allSettled(Array.from(task.subscribers, (subscriber) => subscriber(event)));
    return event;
  }

  async snapshot(generationId: string, persisted?: ChatGenerationRow | null): Promise<Record<string, unknown>> {
    const task = this.tasks.get(generationId);
    if (task) {
      return {
        type: "generation_snapshot",
        generation_id: task.generationId,
        client_request_id: task.clientRequestId ?? null,
        status: task.status,
        partial_text: task.partialText,
        tokens_generated: task.tokensGenerated,
        last_event_sequence: task.sequence,
      };
    }
    return {
      type: "generation_snapshot",
      generation_id: generationId,
      client_request_id: persisted?.client_request_id ?? null,
      conversation_id: persisted?.conversation_id ?? null,
      execution_mode: persisted?.execution_mode ?? null,
      status: persisted?.status ?? "queued",
      partial_text: persisted?.partial_text ?? "",
      tokens_generated: Number(persisted?.tokens_generated ?? 0),
      last_event_sequence: Number(persisted?.last_event_sequence ?? 0),
    };
  }

  subscribe(generationId: string, subscriber: Subscriber, afterSequence = 0): () => void {
    const task = this.tasks.get(generationId);
    if (!task) return () => undefined;
    for (const event of task.events) {
      if (event.sequence > afterSequence) void Promise.resolve(subscriber(event));
    }
    if (!task.terminal) task.subscribers.add(subscriber);
    return () => { task.subscribers.delete(subscriber); };
  }

  async complete(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId);
    if (!task || task.terminal) return;
    if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "completed";
    task.terminal = true;
    await this.checkpoint(task, true);
    if (task.userDb) {
      await markChatGenerationCompleted(task.userDb, {
        userId: task.userId,
        generationId: task.generationId,
        partialText: task.partialText,
        tokensGenerated: task.tokensGenerated,
        lastEventSequence: task.sequence,
      }).catch(() => undefined);
    }
    await this.emitTerminal(task, "generation_completed", "completed");
  }

  async failed(generationId: string, errorCode = "generation_failed"): Promise<void> {
    const task = this.tasks.get(generationId);
    if (!task || task.terminal) return;
    if (task.explicitCancelRequested) return this.cancelled(generationId);
    task.status = "failed";
    task.terminal = true;
    task.lastErrorCode = errorCode || "generation_failed";
    await this.checkpoint(task, true);
    if (task.userDb) {
      await markChatGenerationFailed(task.userDb, {
        userId: task.userId,
        generationId: task.generationId,
        errorCode: task.lastErrorCode,
        partialText: task.partialText,
        tokensGenerated: task.tokensGenerated,
        lastEventSequence: task.sequence,
      }).catch(() => undefined);
    }
    await this.emitTerminal(task, "generation_failed", "failed");
  }

  async cancelled(generationId: string): Promise<void> {
    const task = this.tasks.get(generationId);
    if (!task || task.terminal) return;
    task.status = "cancelled";
    task.terminal = true;
    task.explicitCancelRequested = true;
    await this.checkpoint(task, true);
    if (task.userDb) {
      await cancelChatGeneration(task.userDb, task.userId, task.generationId).catch(() => undefined);
    }
    await this.emitTerminal(task, "generation_cancelled", "cancelled");
  }

  async requestCancel(generationId: string): Promise<boolean> {
    const task = this.tasks.get(generationId);
    if (!task || task.terminal) return false;
    task.explicitCancelRequested = true;
    task.status = "cancel_requested";
    task.execution?.cancel();
    return true;
  }

  isExplicitCancelRequested(generationId: string): boolean {
    return Boolean(this.tasks.get(generationId)?.explicitCancelRequested);
  }

  private async emitTerminal(task: Task, type: "generation_completed" | "generation_failed" | "generation_cancelled", status: string) {
    task.sequence += 1;
    const event: ChatGenerationEvent = {
      generation_id: task.generationId,
      sequence: task.sequence,
      type,
      status,
      partial_text: task.partialText,
      ...(task.lastErrorCode ? { error_code: task.lastErrorCode } : {}),
    };
    task.events.push(event);
    await Promise.allSettled(Array.from(task.subscribers, (subscriber) => subscriber(event)));
    task.subscribers.clear();
    this.scheduleCleanup(task);
  }

  private async checkpoint(task: Task, force: boolean): Promise<void> {
    if (!task.userDb) return;
    const now = Date.now();
    const tokenDelta = task.tokensGenerated - task.lastCheckpointTokens;
    if (!force && now - task.lastCheckpointAt < CHECKPOINT_INTERVAL_MS && tokenDelta < CHECKPOINT_TOKEN_INTERVAL) return;
    task.lastCheckpointAt = now;
    task.lastCheckpointTokens = task.tokensGenerated;
    await checkpointChatGeneration(task.userDb, {
      userId: task.userId,
      generationId: task.generationId,
      checkpoint: {
        partialText: task.partialText,
        tokensGenerated: task.tokensGenerated,
        lastEventSequence: task.sequence,
        status: task.status === "queued" ? "running" : task.status,
      },
    }).catch((error) => {
      console.warn(`[GenerationCheckpoint] failed generation=${task.generationId} error=${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private scheduleCleanup(task: Task): void {
    if (task.cleanupTimer) clearTimeout(task.cleanupTimer);
    task.cleanupTimer = setTimeout(() => {
      if (this.tasks.get(task.generationId) === task) this.tasks.delete(task.generationId);
    }, TERMINAL_RETENTION_MS);
    task.cleanupTimer.unref?.();
  }
}

export const chatGenerationTaskCoordinator = new ChatGenerationTaskCoordinator();