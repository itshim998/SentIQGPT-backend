import {
  DEFAULT_GEMINI_LIVE_MODEL,
  ORDERED_GEMINI_LIVE_MODELS,
  type GeminiLiveModel,
} from "./geminiLiveConfig";

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
  model: string;
};

type ModelHealth = {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastFailureClass?: GeminiLiveFailureClass;
};

type KeyState = {
  slot: number;
  apiKey: string;
  lastSelectedAt: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  activeSessions: number;
  lastFailureClass?: GeminiLiveFailureClass;
  modelHealth: Map<string, ModelHealth>;
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
        modelHealth: new Map<string, ModelHealth>(),
      }));
  }

  private getModelHealth(state: KeyState, model: string): ModelHealth {
    let health = state.modelHealth.get(model);
    if (!health) {
      health = { cooldownUntil: 0, consecutiveFailures: 0 };
      state.modelHealth.set(model, health);
    }
    return health;
  }

  get size(): number {
    return this.states.length;
  }

  get slots(): number[] {
    return this.states.map((state) => state.slot);
  }

  hasAvailableSlot(maxActivePerSlot: number | null = null): boolean {
    const now = this.now();
    return this.states.some((state) => {
      if (state.cooldownUntil > now) return false;
      if (maxActivePerSlot && state.activeSessions >= maxActivePerSlot) return false;
      return ORDERED_GEMINI_LIVE_MODELS.some((model) => {
        const health = this.getModelHealth(state, model);
        return health.cooldownUntil <= now;
      });
    });
  }

  acquire(
    excludedSlots: ReadonlySet<number> = new Set(),
    maxActivePerSlot: number | null = null,
    options?: {
      excludedResources?: ReadonlySet<string>;
      preferredModel?: string;
    },
  ): GeminiLiveKeyLease {
    const now = this.now();
    const candidateKeys = this.states
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

    const inFlightSlot = options?.excludedResources
      ? [...options.excludedResources]
          .map((r) => parseInt(r.split(":")[0], 10))
          .find((slot) => {
            const state = this.states.find((s) => s.slot === slot);
            if (!state || state.cooldownUntil > now) return false;
            return ORDERED_GEMINI_LIVE_MODELS.some((m) => {
              if (options.excludedResources?.has(`${slot}:${m}`)) return false;
              const h = this.getModelHealth(state, m);
              return h.cooldownUntil <= now;
            });
          })
      : undefined;

    const orderedKeys = inFlightSlot
      ? [
          ...candidateKeys.filter((k) => k.slot === inFlightSlot),
          ...candidateKeys.filter((k) => k.slot !== inFlightSlot),
        ]
      : candidateKeys;

    // Key-major traversal: for each key, evaluate models in priority order
    for (const key of orderedKeys) {
      const modelsToTry = options?.preferredModel
        ? [options.preferredModel, ...ORDERED_GEMINI_LIVE_MODELS.filter((m) => m !== options.preferredModel)]
        : ORDERED_GEMINI_LIVE_MODELS;

      for (const model of modelsToTry) {
        const resourceId = `${key.slot}:${model}`;
        if (options?.excludedResources?.has(resourceId)) {
          continue;
        }
        const health = this.getModelHealth(key, model);
        if (health.cooldownUntil > now) {
          continue;
        }
        key.lastSelectedAt = now;
        return { slot: key.slot, apiKey: key.apiKey, model };
      }
    }

    // If no candidate available, determine shortest retry cooldown
    const futureCooldowns: number[] = [];
    for (const state of this.states) {
      if (excludedSlots.has(state.slot)) continue;
      if (state.cooldownUntil > now) {
        futureCooldowns.push(state.cooldownUntil - now);
        continue;
      }
      for (const model of ORDERED_GEMINI_LIVE_MODELS) {
        const resourceId = `${state.slot}:${model}`;
        if (options?.excludedResources?.has(resourceId)) continue;
        const health = this.getModelHealth(state, model);
        if (health.cooldownUntil > now) {
          futureCooldowns.push(health.cooldownUntil - now);
        }
      }
    }
    throw new GeminiLiveCapacityError(futureCooldowns.length > 0 ? Math.min(...futureCooldowns) : 30_000);
  }

  markSuccess(slot: number, model?: string): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    if (model) {
      const health = this.getModelHealth(state, model);
      health.consecutiveFailures = 0;
      health.cooldownUntil = 0;
    }
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

  markFailure(slot: number, failureClass: GeminiLiveFailureClass, model?: string): void {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return;
    const now = this.now();
    const baseCooldownMs = failureClass === "auth" || failureClass === "configuration"
      ? 15 * 60_000
      : failureClass === "capacity"
        ? 60_000
        : failureClass === "unavailable"
          ? 30_000
          : 10_000;

    if (failureClass === "auth" || failureClass === "configuration" || !model) {
      // Slot-level failure applies to key slot and all models
      state.consecutiveFailures += 1;
      state.lastFailureClass = failureClass;
      const multiplier = Math.min(8, 2 ** Math.max(0, state.consecutiveFailures - 1));
      state.cooldownUntil = now + baseCooldownMs * multiplier;
      for (const m of ORDERED_GEMINI_LIVE_MODELS) {
        const health = this.getModelHealth(state, m);
        health.consecutiveFailures += 1;
        health.lastFailureClass = failureClass;
        health.cooldownUntil = state.cooldownUntil;
      }
    } else {
      // Model-specific failure (e.g. 429/capacity on that specific model)
      const health = this.getModelHealth(state, model);
      health.consecutiveFailures += 1;
      health.lastFailureClass = failureClass;
      const multiplier = Math.min(8, 2 ** Math.max(0, health.consecutiveFailures - 1));
      health.cooldownUntil = now + baseCooldownMs * multiplier;
      state.lastFailureClass = failureClass;
    }
  }

  getKeyBySlot(slot: number): GeminiLiveKeyLease | undefined {
    const state = this.states.find((entry) => entry.slot === slot);
    if (!state) return undefined;
    return { slot: state.slot, apiKey: state.apiKey, model: DEFAULT_GEMINI_LIVE_MODEL };
  }

  getDominantCooldownFailureClass(): GeminiLiveFailureClass | undefined {
    const now = this.now();
    const cooling = this.states.filter((state) => {
      if (state.cooldownUntil > now) return true;
      return ORDERED_GEMINI_LIVE_MODELS.every((m) => {
        const health = state.modelHealth.get(m);
        return health && health.cooldownUntil > now;
      });
    });
    if (cooling.length === 0 || cooling.length < this.states.length) return undefined;
    if (cooling.every((state) => state.lastFailureClass === "auth")) return "auth";
    if (cooling.every((state) => state.lastFailureClass === "capacity")) return "capacity";
    if (cooling.every((state) => state.lastFailureClass === "configuration")) return "configuration";
    if (cooling.every((state) => state.lastFailureClass === "unavailable")) return "unavailable";
    return cooling[0].lastFailureClass;
  }
}
