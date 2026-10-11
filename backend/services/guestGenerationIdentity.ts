import { createHash } from "crypto";

const GUEST_OWNER_KEY_VERSION = "sentiq-guest-generation-v1|";

export function normalizeGuestOwnerKey(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error("Guest owner key is required");
  return normalized;
}

export function guestGenerationOwnerKeyFromAnonymousId(anonymousId: string): string {
  return createHash("sha256")
    .update(GUEST_OWNER_KEY_VERSION)
    .update(normalizeGuestOwnerKey(anonymousId))
    .digest("hex");
}

export function getGuestGenerationOwnerKeyForRequest(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const raw = req.headers?.["x-sentiq-anonymous-id"];
  const anonymousId = Array.isArray(raw) ? String(raw[0] || "").trim() : String(raw || "").trim();
  if (anonymousId) {
    return guestGenerationOwnerKeyFromAnonymousId(anonymousId);
  }
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "").split(",")[0]?.trim();
  const ip = forwardedFor || req.ip || req.socket?.remoteAddress || "127.0.0.1";
  const userAgent = String(req.headers?.["user-agent"] || "unknown");
  const fallbackId = `anon-ip-${ip}-${userAgent}`;
  return guestGenerationOwnerKeyFromAnonymousId(fallbackId);
}
