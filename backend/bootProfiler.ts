import { performance } from "node:perf_hooks";

type BootProfileEntry = {
  readonly label: string;
  readonly deltaMs: number;
  readonly totalMs: number;
};

type BootSummaryMeasure = {
  readonly key: string;
  readonly label: string;
};

type MaybePromise<T> = T | Promise<T>;

function isDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0"
    || normalized === "false"
    || normalized === "off"
    || normalized === "no"
    || normalized === "disabled";
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 120) || "unknown";
}

class BootProfiler {
  readonly startedAtUnixMs = Date.now();

  private readonly startedAtMs = performance.now();
  private lastMarkMs = this.startedAtMs;
  private loggingReady = false;
  private readonly pendingEntries: BootProfileEntry[] = [];
  private readonly measureDurationsMs = new Map<string, number>();

  enable(): void {
    if (this.loggingReady) return;
    this.loggingReady = true;
    this.flushPendingEntries();
  }

  mark(label: string): void {
    this.recordMark(label);
  }

  markDuration(label: string, durationMs: number): void {
    const safeDurationMs = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.recordMark(label, safeDurationMs);
  }

  private recordMark(label: string, deltaOverrideMs?: number): void {
    const now = performance.now();
    const entry: BootProfileEntry = {
      label: safeLabel(label),
      deltaMs: deltaOverrideMs ?? now - this.lastMarkMs,
      totalMs: now - this.startedAtMs,
    };
    this.lastMarkMs = now;

    if (!this.loggingReady) {
      this.pendingEntries.push(entry);
      return;
    }

    this.logEntry(entry);
  }

  async measure<T>(label: string, fn: () => MaybePromise<T>): Promise<T> {
    this.mark(`${label}.begin`);
    const measureStartedAtMs = performance.now();
    try {
      const result = await fn();
      this.recordMeasure(label, "done", performance.now() - measureStartedAtMs);
      return result;
    } catch (error) {
      this.recordMeasure(label, "failed", performance.now() - measureStartedAtMs);
      throw error;
    }
  }

  measureSync<T>(label: string, fn: () => T): T {
    this.mark(`${label}.begin`);
    const measureStartedAtMs = performance.now();
    try {
      const result = fn();
      this.recordMeasure(label, "done", performance.now() - measureStartedAtMs);
      return result;
    } catch (error) {
      this.recordMeasure(label, "failed", performance.now() - measureStartedAtMs);
      throw error;
    }
  }

  getTotalMs(): number {
    return performance.now() - this.startedAtMs;
  }

  getMeasureDurationMs(label: string): number | undefined {
    return this.measureDurationsMs.get(label);
  }

  logSummary(args: {
    readonly ready: boolean;
    readonly measures?: readonly BootSummaryMeasure[];
  }): void {
    if (!this.isEnabled()) return;

    const fields = [`total=${Math.round(this.getTotalMs())}ms`];
    for (const measure of args.measures ?? []) {
      const durationMs = this.getMeasureDurationMs(measure.label);
      if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
        fields.push(`${safeLabel(measure.key)}=${Math.round(durationMs)}ms`);
      }
    }
    fields.push(`ready=${args.ready ? "true" : "false"}`);
    console.log(`[Boot] summary ${fields.join(" ")}`);
  }

  private recordMeasure(label: string, suffix: "done" | "failed", durationMs: number): void {
    this.measureDurationsMs.set(label, durationMs);
    this.recordMark(`${label}.${suffix}`, durationMs);
  }

  private flushPendingEntries(): void {
    if (!this.isEnabled()) {
      this.pendingEntries.length = 0;
      return;
    }

    for (const entry of this.pendingEntries.splice(0)) {
      this.writeEntry(entry);
    }
  }

  private logEntry(entry: BootProfileEntry): void {
    if (!this.isEnabled()) return;
    this.writeEntry(entry);
  }

  private isEnabled(): boolean {
    return !isDisabled(process.env.SENTIQ_BOOT_PROFILE ?? process.env.BOOT_PROFILE);
  }

  private writeEntry(entry: BootProfileEntry): void {
    console.log(
      `[Boot] ${entry.label} +${Math.round(entry.deltaMs)}ms total=${Math.round(entry.totalMs)}ms`,
    );
  }
}

export const bootProfiler = new BootProfiler();
