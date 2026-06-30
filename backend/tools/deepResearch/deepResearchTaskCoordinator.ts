import type { DeepResearchEvent, DeepResearchEventHandler } from "./deepResearchTypes";

export type DeepResearchTaskContext = {
  signal: AbortSignal;
  publish: (event: DeepResearchEvent) => Promise<void>;
  wasExplicitlyCancelled: () => boolean;
};

export type DeepResearchTaskRunner = (context: DeepResearchTaskContext) => Promise<void>;

type ActiveDeepResearchTask = {
  abortController: AbortController;
  completion: Promise<void>;
  explicitCancelRequested: boolean;
  subscribers: Set<DeepResearchEventHandler>;
};

/**
 * Owns backend Deep Research executions independently from HTTP subscribers.
 * Removing an SSE subscriber never aborts the task; only cancel() does.
 */
export class DeepResearchTaskCoordinator {
  private readonly tasks = new Map<string, ActiveDeepResearchTask>();

  start(reportId: string, runner: DeepResearchTaskRunner): boolean {
    if (!reportId || this.tasks.has(reportId)) return false;

    const abortController = new AbortController();
    const task = {
      abortController,
      completion: Promise.resolve(),
      explicitCancelRequested: false,
      subscribers: new Set<DeepResearchEventHandler>(),
    } satisfies ActiveDeepResearchTask;

    this.tasks.set(reportId, task);
    task.completion = Promise.resolve()
      .then(() => runner({
        signal: abortController.signal,
        publish: (event) => this.publish(reportId, event),
        wasExplicitlyCancelled: () => task.explicitCancelRequested,
      }))
      .catch(() => {
        console.error(`[Deep Research] background task failed reportId=${reportId}`);
      })
      .finally(() => {
        this.tasks.delete(reportId);
      });
    return true;
  }

  subscribe(reportId: string, handler: DeepResearchEventHandler): () => void {
    const task = this.tasks.get(reportId);
    if (!task) return () => undefined;
    task.subscribers.add(handler);
    return () => {
      task.subscribers.delete(handler);
    };
  }

  async publish(reportId: string, event: DeepResearchEvent): Promise<void> {
    const task = this.tasks.get(reportId);
    if (!task || task.subscribers.size === 0) return;
    await Promise.allSettled(
      [...task.subscribers].map((handler) => Promise.resolve(handler(event))),
    );
  }

  cancel(reportId: string): boolean {
    const task = this.tasks.get(reportId);
    if (!task) return false;
    task.explicitCancelRequested = true;
    task.abortController.abort();
    return true;
  }

  isActive(reportId: string): boolean {
    return this.tasks.has(reportId);
  }

  getSubscriberCount(reportId: string): number {
    return this.tasks.get(reportId)?.subscribers.size ?? 0;
  }

  async waitForIdle(reportId: string, timeoutMs = 2_000): Promise<boolean> {
    const task = this.tasks.get(reportId);
    if (!task) return true;
    let timeout: NodeJS.Timeout | null = null;
    const timedOut = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref?.();
    });
    const completed = task.completion.then(() => true);
    const result = await Promise.race([completed, timedOut]);
    if (timeout) clearTimeout(timeout);
    return result;
  }
}
