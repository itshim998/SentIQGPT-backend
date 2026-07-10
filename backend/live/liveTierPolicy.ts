import type { BillingPlanCode } from "../billing/entitlementTypes";

export type LiveTierLimit = {
  enabled: boolean;
  dailySeconds: number;
  maxSessionSeconds: number;
  maxActiveSessions: number;
};

export type LiveTierPolicy = {
  plans: Record<BillingPlanCode, LiveTierLimit>;
  globalMaxActive: number | null;
  projectMaxActive: number | null;
  staleGraceSeconds: number;
};

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(env[name]?.trim() || "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function readOptionalPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  max: number,
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : null;
}

function buildTier(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaults: Omit<LiveTierLimit, "enabled"> & { enabled: boolean },
): LiveTierLimit {
  const dailyMinutes = readInteger(env, `${prefix}_DAILY_MINUTES`, defaults.dailySeconds / 60, 0, 1_440);
  return {
    enabled: defaults.enabled,
    dailySeconds: dailyMinutes * 60,
    maxSessionSeconds: readInteger(env, `${prefix}_MAX_SESSION_SECONDS`, defaults.maxSessionSeconds, 30, 900),
    maxActiveSessions: readInteger(env, `${prefix}_MAX_ACTIVE`, defaults.maxActiveSessions, 1, 100),
  };
}

export function loadLiveTierPolicy(env: NodeJS.ProcessEnv = process.env): LiveTierPolicy {
  const free = buildTier(env, "SENTIQ_LIVE_FREE", {
    enabled: readBoolean(env.SENTIQ_LIVE_FREE_ENABLED, true),
    dailySeconds: 2 * 60,
    maxSessionSeconds: 120,
    maxActiveSessions: 1,
  });

  return {
    plans: {
      free,
      student_core: buildTier(env, "SENTIQ_LIVE_STUDENT_CORE", {
        enabled: true,
        dailySeconds: 8 * 60,
        maxSessionSeconds: 300,
        maxActiveSessions: 1,
      }),
      premium: buildTier(env, "SENTIQ_LIVE_PREMIUM", {
        enabled: true,
        dailySeconds: 25 * 60,
        maxSessionSeconds: 600,
        maxActiveSessions: 1,
      }),
      pro: buildTier(env, "SENTIQ_LIVE_PRO", {
        enabled: true,
        dailySeconds: 75 * 60,
        maxSessionSeconds: 600,
        maxActiveSessions: 2,
      }),
    },
    globalMaxActive: readOptionalPositiveInteger(env, "SENTIQ_LIVE_GLOBAL_MAX_ACTIVE", 100_000),
    projectMaxActive: readOptionalPositiveInteger(env, "SENTIQ_LIVE_PROJECT_MAX_ACTIVE", 100_000),
    staleGraceSeconds: readInteger(env, "SENTIQ_LIVE_STALE_GRACE_SECONDS", 30, 5, 300),
  };
}
