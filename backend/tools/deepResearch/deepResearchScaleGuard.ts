type IntervalHandle = ReturnType<typeof setInterval>;

export type DeepResearchScaleGuardConfig = {
  intervalMs: number;
  url: string;
};

export type DeepResearchScaleGuard = {
  enabled: boolean;
  intervalMs: number | null;
  ping: () => Promise<boolean>;
  stop: () => void;
};

type DeepResearchScaleGuardOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  warn?: (message: string) => void;
};

const DEFAULT_MIN_REPLICAS = 0;
const DEFAULT_MAX_REPLICAS = 1;
const DEFAULT_COOLDOWN_SECONDS = 900;
const MAX_KEEPALIVE_INTERVAL_MS = 60_000;
const MIN_KEEPALIVE_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function parseInteger(value: string | undefined, fallback: number): number {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function resolveDeepResearchScaleGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
): DeepResearchScaleGuardConfig | null {
  const minReplicas = parseInteger(env.SENTIQ_CONTAINER_MIN_REPLICAS, DEFAULT_MIN_REPLICAS);
  const maxReplicas = parseInteger(env.SENTIQ_CONTAINER_MAX_REPLICAS, DEFAULT_MAX_REPLICAS);
  const cooldownSeconds = Math.max(
    30,
    parseInteger(env.SENTIQ_CONTAINER_COOLDOWN_SECONDS, DEFAULT_COOLDOWN_SECONDS),
  );
  const hostname = env.CONTAINER_APP_HOSTNAME?.trim();

  if (minReplicas !== 0 || maxReplicas !== 1 || !hostname) return null;
  if (!/^[a-z0-9.-]+$/i.test(hostname)) return null;

  const intervalMs = Math.max(
    MIN_KEEPALIVE_INTERVAL_MS,
    Math.min(MAX_KEEPALIVE_INTERVAL_MS, Math.floor((cooldownSeconds * 1_000) / 3)),
  );
  return {
    intervalMs,
    url: `https://${hostname}/health`,
  };
}

export function startDeepResearchScaleGuard(
  options: DeepResearchScaleGuardOptions = {},
): DeepResearchScaleGuard {
  const config = resolveDeepResearchScaleGuardConfig(options.env);
  if (!config) {
    return {
      enabled: false,
      intervalMs: null,
      ping: async () => false,
      stop: () => undefined,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const activeRequests = new Set<AbortController>();
  let stopped = false;
  let interval: IntervalHandle | null = null;

  const ping = async (): Promise<boolean> => {
    if (stopped) return false;
    const controller = new AbortController();
    activeRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await fetchImpl(config.url, {
        method: "GET",
        headers: { "X-SentIQ-Scale-Guard": "deep-research" },
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error("non-success response");
      return true;
    } catch {
      if (!stopped) warn("[Deep Research] Azure scale guard keepalive failed; retrying.");
      return false;
    } finally {
      clearTimeout(timeout);
      activeRequests.delete(controller);
    }
  };

  void ping();
  interval = setIntervalImpl(() => {
    void ping();
  }, config.intervalMs);
  interval.unref?.();

  return {
    enabled: true,
    intervalMs: config.intervalMs,
    ping,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (interval) clearIntervalImpl(interval);
      interval = null;
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
    },
  };
}
