import rateLimit from "express-rate-limit";
import type { Request } from "express";
import type { AuthenticatedRequest } from "./auth";

// SentIQ Chat v1 — Rate Limiting Middleware
//
// Three tiers:
// 1. General API: 100 req/min per client
// 2. AI endpoints: 30 req/min per client
// 3. File uploads: 20 req/hour per client

function extractKey(req: Request): string {
  const user = (req as AuthenticatedRequest).user;
  if (user && !user.isGuest && user.sub) {
    return `user:${user.sub}`;
  }
  return req.ip || req.socket.remoteAddress || "unknown";
}

const envRpm = Number(process.env.SENTIQ_RPM) || 120;
const generalMax = Math.max(envRpm * 10, 1200);

// General API rate limiter: 1200 req/min (high headroom for SPA sync & status polling)
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: generalMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  skip: (req: Request) => {
    const path = req.path || req.originalUrl || "";
    return (
      path.endsWith("/health") ||
      path.includes("/live/status") ||
      path.includes("/chat/sync") ||
      path.includes("/billing/usage") ||
      path.includes("/billing/me")
    );
  },
  message: { error: "Too many requests. Please try again later.", retryAfterMs: 60000 },
});

// AI endpoint rate limiter: 60 req/min
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(envRpm, 60),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "AI request limit reached. Please wait before trying again.", retryAfterMs: 60000 },
});

// File upload rate limiter: 20 req/hour
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Upload limit reached. Maximum 20 uploads per hour.", retryAfterMs: 3600000 },
});
