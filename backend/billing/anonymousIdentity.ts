import { createHash, randomUUID } from "crypto";
import type { Request } from "express";
import type { VerifiedRequestUser } from "../middleware/auth";
import type { BillingIdentity } from "./entitlementTypes";

const ANON_HEADER = "x-sentiq-anonymous-id";

function readSecret(): string {
  const secret = process.env.SENTIQ_ANON_USAGE_HASH_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    console.warn("[billing] SENTIQ_ANON_USAGE_HASH_SECRET missing in production; anonymous quotas will use process-local fallback salt.");
  }
  return "sentiq-dev-anonymous-quota-salt";
}

function normalizeHeader(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return typeof value === "string" ? value.trim() : "";
}

export function getAnonymousIdHeaderName(): string {
  return ANON_HEADER;
}

export function createAnonymousKeyHash(req: Request): string {
  const forwardedFor = normalizeHeader(req?.headers?.["x-forwarded-for"]).split(",")[0]?.trim();
  const ip = forwardedFor || req?.ip || req?.socket?.remoteAddress || "127.0.0.1";
  const userAgent = normalizeHeader(req?.headers?.["user-agent"]) || "unknown";
  const deviceHint = normalizeHeader(req?.headers?.["sec-ch-ua-platform"])
    || normalizeHeader(req?.headers?.["sec-ch-ua"])
    || "unknown";
  const anonymousId = normalizeHeader(req?.headers?.[ANON_HEADER]) || "none";
  return createHash("sha256")
    .update(readSecret())
    .update("|")
    .update(ip)
    .update("|")
    .update(userAgent)
    .update("|")
    .update(deviceHint)
    .update("|")
    .update(anonymousId)
    .digest("hex");
}

export function buildBillingIdentity(req: Request, user: VerifiedRequestUser): BillingIdentity {
  if (!user.isGuest) {
    return {
      userId: user.sub,
      anonymousKeyHash: null,
      isGuest: false,
    };
  }
  return {
    userId: null,
    anonymousKeyHash: createAnonymousKeyHash(req),
    isGuest: true,
  };
}

export function createClientAnonymousId(): string {
  return randomUUID();
}
