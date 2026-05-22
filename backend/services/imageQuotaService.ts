import type { SupabaseClient } from "@supabase/supabase-js";

export const IMAGE_GENERATION_DAILY_LIMIT = 30;

export class ImageQuotaError extends Error {
  readonly statusCode: number;
  readonly type: "quota_exceeded" | "quota_unavailable";
  readonly retryAfterMs?: number;
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetMs?: number;

  constructor(
    message: string,
    options: {
      readonly statusCode: number;
      readonly type: "quota_exceeded" | "quota_unavailable";
      readonly retryAfterMs?: number;
      readonly remaining?: number;
      readonly limit?: number;
      readonly resetMs?: number;
    },
  ) {
    super(message);
    this.name = "ImageQuotaError";
    this.statusCode = options.statusCode;
    this.type = options.type;
    this.retryAfterMs = options.retryAfterMs;
    this.remaining = options.remaining;
    this.limit = options.limit;
    this.resetMs = options.resetMs;
  }
}

export type ImageQuotaInfo = {
  readonly remaining: number;
  readonly limit: number;
  readonly used: number;
  readonly resetMs: number;
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function msUntilUtcMidnight(): number {
  const now = new Date();
  const nextUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(0, nextUtcMidnight - now.getTime());
}

function formatQuotaError(error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null): string {
  if (!error) return "unknown";
  return [
    error.code ? `code=${error.code}` : null,
    error.message ? `message=${error.message}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean).join(" ") || "unknown";
}

export async function getCentralImageQuotaInfo(
  userDb: SupabaseClient,
  userId: string,
  limit = IMAGE_GENERATION_DAILY_LIMIT,
): Promise<ImageQuotaInfo> {
  const { data, error } = await userDb
    .from("usage_logs")
    .select("images_generated")
    .eq("user_id", userId)
    .eq("date", todayIsoDate())
    .maybeSingle<{ images_generated: number | null }>();

  if (error) {
    throw new ImageQuotaError(
      "Image quota is temporarily unavailable. Please try again in a moment.",
      {
        statusCode: 503,
        type: "quota_unavailable",
        limit,
      },
    );
  }

  const used = Math.max(0, Number(data?.images_generated || 0));
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetMs: used >= limit ? msUntilUtcMidnight() : 0,
  };
}

export async function reserveCentralImageQuota(
  userDb: SupabaseClient,
  userId: string,
  limit = IMAGE_GENERATION_DAILY_LIMIT,
): Promise<void> {
  const { data, error } = await userDb.rpc("reserve_daily_image_generation", {
    p_user_id: userId,
    p_daily_limit: limit,
  });

  if (error) {
    console.error(`[IMAGE] quota.reserve.failed userId=${userId} ${formatQuotaError(error)}`);
    throw new ImageQuotaError(
      "Image quota is temporarily unavailable. Please try again in a moment.",
      {
        statusCode: 503,
        type: "quota_unavailable",
        limit,
      },
    );
  }

  if (data !== true) {
    throw new ImageQuotaError(
      `Daily image limit reached (${limit} images per day).`,
      {
        statusCode: 429,
        type: "quota_exceeded",
        remaining: 0,
        limit,
        resetMs: msUntilUtcMidnight(),
      },
    );
  }
}

export async function releaseCentralImageQuota(
  userDb: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await userDb.rpc("release_daily_image_generation", {
    p_user_id: userId,
  });

  if (error) {
    console.warn(`[IMAGE] quota.release.failed userId=${userId} ${formatQuotaError(error)}`);
  }
}
