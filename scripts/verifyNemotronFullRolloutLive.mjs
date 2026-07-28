const confirmation = String(process.env.SENTIQ_LIVE_VERIFY_CONFIRM_FULL_ROLLOUT || "").trim();
const baseUrlRaw = String(process.env.SENTIQ_LIVE_VERIFY_BASE_URL || "").trim();
const expectedHost = String(process.env.SENTIQ_LIVE_VERIFY_EXPECTED_HOST || "").trim().toLowerCase();

if (confirmation !== "FULL_ROLLOUT") {
  throw new Error("Production verification requires SENTIQ_LIVE_VERIFY_CONFIRM_FULL_ROLLOUT=FULL_ROLLOUT.");
}
if (!baseUrlRaw) throw new Error("SENTIQ_LIVE_VERIFY_BASE_URL is required.");

const parsed = new URL(baseUrlRaw);
if (parsed.protocol !== "https:") {
  throw new Error("Production full-rollout verification requires an HTTPS backend URL.");
}
if (["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
  throw new Error("Production full-rollout verification cannot target a local endpoint.");
}
if (expectedHost && parsed.hostname.toLowerCase() !== expectedHost) {
  throw new Error("Production verification URL does not match the expected Azure Container Apps hostname.");
}

// Reuse the established redacted end-to-end suite after the stricter production
// confirmation and target checks have succeeded.
process.env.SENTIQ_LIVE_VERIFY_CONFIRM_CANARY = "true";
await import("./verifyNemotronCanaryLive.mjs");
