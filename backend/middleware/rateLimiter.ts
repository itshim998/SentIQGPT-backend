import rateLimit from "express-rate-limit";
import type { Request } from "express";

// SentIQGPT v1 — Rate Limiting Middleware
//
// Three tiers:
// 1. General API: 100 req/min per client
// 2. AI endpoints: 30 req/min per client
// 3. File uploads: 20 req/hour per client

function extractKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// General API rate limiter: 100 req/min
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: extractKey,
  message: { error: "Too many requests. Please try again later.", retryAfterMs: 60000 },
});

// AI endpoint rate limiter: 30 req/min
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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
