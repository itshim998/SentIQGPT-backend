import "../features/final-restraint.js";
import "../features/guest-observer-safety.js";
import "../features/guest-experience.js";

export const COMPANY_NAME = "SentIQ";
export const PRODUCT_NAME = "SentIQ Chat";
export const PRODUCT_SHORT_NAME = PRODUCT_NAME;
// Legacy labels remain only for storage/domain migration compatibility.
export const LEGACY_PRODUCT_NAME = "SentIQGPT";

export const CANONICAL_FRONTEND_ORIGIN = "https://sentiqchat.sentiqlabs.com";
// Exported for compatibility. Old frontend domains are handled by Cloudflare 301 redirects and are not allowed by default.
export const LEGACY_FRONTEND_ORIGINS = [];

export const STORAGE_NAMESPACE = "sentiq-chat";
export const LEGACY_STORAGE_NAMESPACE = "sentiq";

export const STORAGE_KEYS = Object.freeze({
  anonymousQuotaId: `${STORAGE_NAMESPACE}:anonymous-quota-id`,
  debug: `${STORAGE_NAMESPACE}:debug`,
  sidebarCollapsed: `${STORAGE_NAMESPACE}:sidebar-collapsed`,
  guestRecoveryDraft: `${STORAGE_NAMESPACE}:guest-recovery-draft`,
  imageQuota: `${STORAGE_NAMESPACE}:image-quota`,
  imageCooldown: `${STORAGE_NAMESPACE}:image-cooldown`,
  greetingIndexPrefix: `${STORAGE_NAMESPACE}:greeting-index:`,
});

export const LEGACY_STORAGE_KEYS = Object.freeze({
  anonymousQuotaId: "sentiq_anonymous_quota_id",
  debug: "sentiq_debug",
  sidebarCollapsed: "sentiq_sidebar_collapsed",
  guestRecoveryDraft: "sentiq_guest_recovery_draft",
  imageQuota: "sentiq_image_quota",
  imageCooldown: "sentiq_image_cooldown",
  greetingIndexPrefix: "sentiq:greeting-index:",
});

window.SentIQBrand = {
  COMPANY_NAME,
  PRODUCT_NAME,
  PRODUCT_SHORT_NAME,
  LEGACY_PRODUCT_NAME,
  CANONICAL_FRONTEND_ORIGIN,
  LEGACY_FRONTEND_ORIGINS,
  STORAGE_NAMESPACE,
  LEGACY_STORAGE_NAMESPACE,
  STORAGE_KEYS,
  LEGACY_STORAGE_KEYS,
};
