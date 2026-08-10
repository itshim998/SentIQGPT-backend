import "../features/final-restraint.js";

// Guest policy is intentionally loaded after the critical application bootstrap.
// It performs DOM policy work, API wrapping, and observer installation; keeping it
// out of the synchronous main.js -> brand.js import chain prevents guest policy
// work from blocking the initial application paint/startup handshake.
function loadGuestExperienceAfterBootstrap() {
  const load = () => {
    import("../features/guest-experience.js").catch((error) => {
      window.SentIQBootstrap?.addLimitedReason?.(
        "guest-experience",
        "Guest-mode enhancements could not be loaded for this session.",
      );
      console.warn("[SentIQ guest experience] deferred module failed to load", error);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load, { once: true });
  } else {
    window.setTimeout(load, 0);
  }
}

loadGuestExperienceAfterBootstrap();

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
