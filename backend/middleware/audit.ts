import type { Request, Response, NextFunction } from "express";

// SentIQ Chat v1 — In-Memory Audit Logger
//
// Lightweight request auditing. Circular buffer of last N entries.

interface AuditEntry {
  timestamp: string;
  method: string;
  path: string;
  ip: string;
  statusCode: number;
  durationMs: number;
}

const MAX_ENTRIES = 500;
const entries: AuditEntry[] = [];

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.path,
      ip: req.ip || req.socket.remoteAddress || "unknown",
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
    };

    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
  });

  next();
}

export function getRecentAuditEntries(limit = 50): AuditEntry[] {
  return entries.slice(-limit).reverse();
}
