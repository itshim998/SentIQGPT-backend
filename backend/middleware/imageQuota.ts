// SentIQ Chat — Image Burst Cooldown Middleware
//
// Enforces:
//   • 5-second burst cooldown between image requests per user/IP
//   • Authoritative image credit allowances are strictly governed by BillingQuotaService
//

import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "./auth";

// ==============================
// Configuration
// ==============================

const COOLDOWN_MS = 5_000; // 5 seconds
const WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ==============================
// In-memory tracking (per IP)
// ==============================

interface ImageTracker {
  /** Timestamps of successful image generations within the current window. */
  timestamps: number[];
  /** Last generation timestamp for cooldown enforcement. */
  lastGeneration: number;
}

const trackers = new Map<string, ImageTracker>();

/** Prune expired timestamps from a tracker. */
function prune(tracker: ImageTracker, now: number): void {
  tracker.timestamps = tracker.timestamps.filter(
    (ts) => now - ts < WINDOW_MS,
  );
}

function getTracker(ip: string): ImageTracker {
  let tracker = trackers.get(ip);
  if (!tracker) {
    tracker = { timestamps: [], lastGeneration: 0 };
    trackers.set(ip, tracker);
  }
  return tracker;
}

export function getImageQuotaKey(req: Request): string {
  const user = (req as AuthenticatedRequest).user;
  if (user && !user.isGuest && user.sub) {
    return `user:${user.sub}`;
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

// ==============================
// Quota query (non-blocking)
// ==============================

/** Get burst cooldown and status info for an IP or user key. */
export function getQuotaInfo(ip: string): {
  remaining: number;
  limit: number;
  cooldownActive: boolean;
  resetMs: number;
  cooldownResetMs: number;
} {
  const tracker = getTracker(ip);
  const now = Date.now();
  prune(tracker, now);

  const cooldownActive =
    tracker.lastGeneration > 0 && now - tracker.lastGeneration < COOLDOWN_MS;
  const cooldownResetMs =
    cooldownActive ? Math.max(0, COOLDOWN_MS - (now - tracker.lastGeneration)) : 0;

  return {
    remaining: 0,
    limit: 0,
    cooldownActive,
    resetMs: cooldownResetMs,
    cooldownResetMs,
  };
}

export function commitImageQuotaSuccess(key: string, committedAt = Date.now()): void {
  const tracker = getTracker(key);
  prune(tracker, committedAt);
  tracker.timestamps.push(committedAt);
  tracker.lastGeneration = committedAt;
}

// ==============================
// Middleware — enforce quota + cooldown
// ==============================

export function imageQuotaMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = getImageQuotaKey(req);
  const tracker = getTracker(ip);
  const now = Date.now();

  prune(tracker, now);

  // Check cooldown
  if (tracker.lastGeneration > 0 && now - tracker.lastGeneration < COOLDOWN_MS) {
    const waitSec = Math.ceil(
      (COOLDOWN_MS - (now - tracker.lastGeneration)) / 1000,
    );
    console.log(`[IMAGE] quota: cooldown active for ${ip} (${waitSec}s remaining)`);
    res.status(429).json({
      error: `Please wait ${waitSec} second${waitSec !== 1 ? "s" : ""} before generating another image.`,
      type: "cooldown",
      retryAfterMs: COOLDOWN_MS - (now - tracker.lastGeneration),
    });
    return;
  }

  next();
}

// ==============================
// Image request auto-detection
// ==============================


/**
 * Detect whether a user message is requesting image generation.
 * Uses keyword pattern matching — no LLM call needed.
 */

// ==============================
// Periodic cleanup (every 30 min)
// ==============================

setInterval(() => {
  const now = Date.now();
  for (const [ip, tracker] of trackers) {
    prune(tracker, now);
    if (tracker.timestamps.length === 0 && now - tracker.lastGeneration > WINDOW_MS) {
      trackers.delete(ip);
    }
  }
}, 30 * 60 * 1000).unref();
