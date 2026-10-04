export const LIVE_KEY_ENV_NAMES = [
  "GEMINI_API_KEY_1",
  "GEMINI_API_KEY_2",
  "GEMINI_API_KEY_3",
  "GEMINI_API_KEY_4",
  "GEMINI_API_KEY_5",
  "GEMINI_API_KEY_6",
] as const;

export type GeminiLiveFailureClass =
  | "auth"
  | "capacity"
  | "configuration"
  | "network"
  | "timeout"
  | "unavailable"
  | "unknown";

export type GeminiLiveKeyLease = {
  slot: number;
  apiKey: string;
};

type KeyState = {
  slot: number;
  apiKey: string;
  lastSelectedAt: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  activeSessions: number;
  lastFailureClass?: GeminiLiveFailureClass;
};

export class GeminiLiveCapacityError extends Error {
  readonly code = "live_capacity_unavailable";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Live capacity is temporarily unavailable.");
    this.name = "GeminiLiveCapacityError";
    this.retryAfterMs = Math.max(1_000, retryAfterMs);
  }
}

export class GeminiLiveKeyPool {
  private readonly states: KeyState[];
  private readonly now: () => number;

  constructor(args: { env?: NodeJS.ProcessEnv; now?: () => number; keys?: string[] } = {}) {
    this.now = args.now ?? Date.now;
    const env = args.env ?? process.env;
    let configuredKeys: Array<string | undefined>;
    if (args.keys) {
      configuredKeys = args.keys;
    } else {
      // Collect standard keys 1..6, plus any additional indexed keys
      const scannedKeys: Array<string | undefined> = [];
      for (const name of LIVE_KEY_ENV_NAMES) {
        scannedKeys.push(env[name]);
      }
      let extraIndex = LIVE_KEY_ENV_NAMES.length + 1;
      while (typeof env[`GEMINI_API_KEY_${extraIndex}`] === "string" && env[`GEMINI_API_KEY_${extraIndex}`]!.trim()) {
        scannedKeys.push(env[`GEMINI_API_KEY_${extraIndex}`]);
        extraIndex += 1;
      }
      configuredKeys = scannedKeys;
    }
    this.states = configuredKeys
      .map((apiKey, index) => ({ apiKey: apiKey?.trim() || "", slot: index + 1 }))
      .filter((entry) => Boolean(entry.apiKey))
      .map((entry) => ({
        ...entry,
        lastSelectedAt: 0,
        cooldownUntil: 0,
        consecutiveFailures: 0,
        activeSessions: 0,
      }));
  }

  get size(): number {
    return this.states.length;
  }

  get slots(): number[] {
    return this.states.map((state) => state.slot);
  }

  hasAvailableSlot(maxActivePerSlot: number | null = null): boolean {
    const now = this.now();
    return this.states.some((state) => (
      state.cooldownUntil <= now
      && (!maxActivePerSlot || state.activeSessions < maxActivePerSlot)
    ));
  }

  acquire(
    excludedSlots: ReadonlySet<number> = new Set(),
    maxActivePerSlot: number | null = null,
  ): GeminiLiveKeyLease {
    const now = this.now();
    const candidates = this.states
      .filter((state) => (
        !excludedSlots.has(state.slot)
        && state.cooldownUntil <= now
        && (!maxActivePerSlot || state.activeSessions < maxActivePerSlot)
      ))
      .sort((left, right) => (
        left.activeSessions - right.activeSessions
        || left.lastSelectedAt - right.lastSelectedAt
        || left.slot - right.slot
      ));

    const selected = candidates[0];
    if (!selected) {
      const futureCooldowns = this.states
        .filter((state) => !excludedSlots.has(state.slot) && state.cooldownUntil > now)
        .map((state) => state.cooldownUntil - now);
      throw new GeminiLiveCapacityError(futureCooldowns.length > 0 ? Math.min(...futureCooldowns) : 30_000);
    }

    selected.lastSelectedAt = now;
    return { slot: selected.slot, apiKey: selected.apiKey };
  }

  markSuccess(slot: number): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }

  markActive(slot: number): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (state) state.activeSessions += 1;
  }

  releaseActive(slot: number): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (state) state.activeSessions = Math.max(0, state.activeSessions - 1);
  }

  syncActiveCounts(counts: Map<number, number> | Record<number, number>): void {
    for (const state of this.states) {
      const count = counts instanceof Map ? counts.get(state.slot) : counts[state.slot];
      if (typeof count === "number") {
        state.activeSessions = Math.max(0, count);
      }
    }
  }

  getActiveCount(slot: number): number {
    return this.states.find((entry) => entry.slot === slot)?.activeSessions ?? 0;
  }

  markFailure(slot: number, failureClass: GeminiLiveFailureClass): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return;
    state.consecutiveFailures += 1;
    state.lastFailureClass = failureClass;
    const baseCooldownMs = failureClass === "auth" || failureClass === "configuration"
      ? 15 * 60_000
      : failureClass === "capacity"
        ? 60_000
        : failureClass === "unavailable"
          ? 30_000
          : 10_000;
    const multiplier = Math.min(8, 2 ** Math.max(0, state.consecutiveFailures - 1));
    state.cooldownUntil = this.now() + baseCooldownMs * multiplier;
  }

  getKeyBySlot(slot: number): GeminiLiveKeyLease | undefined {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return undefined;
    return { slot: state.slot, apiKey: state.apiKey };
  }

  getDominantCooldownFailureClass(): GeminiLiveFailureClass | undefined {
    const now = this.now();
    const cooling = this.states.filter((state) => state.cooldownUntil > now);
    if (cooling.length === 0 || cooling.length < this.states.length) return undefined;
    if (cooling.every((state) => state.lastFailureClass === "auth")) return "auth";
    if (cooling.every((state) => state.lastFailureClass === "capacity")) return "capacity";
    if (cooling.every((state) => state.lastFailureClass === "configuration")) return "configuration";
    if (cooling.every((state) => state.lastFailureClass === "unavailable")) return "unavailable";
    return cooling[0].lastFailureClass;
  }
}
