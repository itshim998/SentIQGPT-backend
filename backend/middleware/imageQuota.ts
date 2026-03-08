// SentIQGPT v2 — Image Quota & Cooldown Middleware
//
// Enforces:
//   • 30 image generations per IP per 24 hours
//   • 5-second cooldown between image requests per IP
//
// Also exports:
//   • isImageRequest(text) — keyword-based auto-detection

import type { Request, Response, NextFunction } from "express";

// ==============================
// Configuration
// ==============================

const MAX_IMAGES_PER_DAY = 30;
const COOLDOWN_MS = 5_000; // 5 seconds
const WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ==============================
// In-memory tracking (per IP)
// ==============================

interface ImageTracker {
  /** Timestamps of image generations within the current window. */
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

function extractIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// ==============================
// Quota query (non-blocking)
// ==============================

/** Get remaining quota info for an IP. */
export function getQuotaInfo(ip: string): {
  remaining: number;
  limit: number;
  cooldownActive: boolean;
  resetMs: number;
} {
  const tracker = getTracker(ip);
  const now = Date.now();
  prune(tracker, now);

  const used = tracker.timestamps.length;
  const remaining = Math.max(0, MAX_IMAGES_PER_DAY - used);
  const cooldownActive =
    tracker.lastGeneration > 0 && now - tracker.lastGeneration < COOLDOWN_MS;

  // Time until oldest entry expires (i.e. a slot reopens)
  const resetMs =
    used >= MAX_IMAGES_PER_DAY && tracker.timestamps.length > 0
      ? WINDOW_MS - (now - tracker.timestamps[0])
      : 0;

  return { remaining, limit: MAX_IMAGES_PER_DAY, cooldownActive, resetMs };
}

// ==============================
// Middleware — enforce quota + cooldown
// ==============================

export function imageQuotaMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip = extractIp(req);
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

  // Check daily quota
  if (tracker.timestamps.length >= MAX_IMAGES_PER_DAY) {
    const resetMs = WINDOW_MS - (now - tracker.timestamps[0]);
    const resetMin = Math.ceil(resetMs / 60_000);
    console.log(`[IMAGE] quota: daily limit reached for ${ip} (resets in ${resetMin}min)`);
    res.status(429).json({
      error: `Daily image limit reached (${MAX_IMAGES_PER_DAY} images per 24 hours). Resets in ~${resetMin} minutes.`,
      type: "quota_exceeded",
      remaining: 0,
      limit: MAX_IMAGES_PER_DAY,
      resetMs,
    });
    return;
  }

  // Record this generation
  tracker.timestamps.push(now);
  tracker.lastGeneration = now;

  const remaining = MAX_IMAGES_PER_DAY - tracker.timestamps.length;
  console.log(`[IMAGE] quota: ${ip} used ${tracker.timestamps.length}/${MAX_IMAGES_PER_DAY} (${remaining} remaining)`);

  next();
}

// ==============================
// Image request auto-detection
// ==============================

const IMAGE_KEYWORDS = [
  /\b(generate|create|make|draw|paint|render|design|sketch|produce)\b.*\b(image|picture|photo|art|illustration|artwork|portrait|landscape|wallpaper|icon|logo|poster|banner)\b/i,
  /\b(image|picture|photo|art|illustration|artwork|portrait|landscape|wallpaper|icon|logo|poster|banner)\b.*\b(of|for|with|showing|depicting|featuring)\b/i,
  /\bgenerate\s+(an?\s+)?image\b/i,
  /\bcreate\s+(an?\s+)?image\b/i,
  /\bdraw\s+(me\s+)?(an?\s+)?/i,
  /\bpaint\s+(me\s+)?(an?\s+)?/i,
  /\brender\s+(an?\s+)?(3d\s+)?/i,
  /\bdesign\s+(an?\s+)?/i,
  /\bvisuali[sz]e\b/i,
  /\billustrate\b/i,
  /\bshow\s+me\s+(an?\s+)?(image|picture|photo)\b/i,
  /\bimage\s+of\b/i,
  /\bpicture\s+of\b/i,
];

/**
 * Detect whether a user message is requesting image generation.
 * Uses keyword pattern matching — no LLM call needed.
 */
export function isImageRequest(text: string): boolean {
  return IMAGE_KEYWORDS.some((pattern) => pattern.test(text));
}

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
