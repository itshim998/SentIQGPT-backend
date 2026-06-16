export const COMPANY_NAME = "SentIQ";
export const PRODUCT_NAME = "SentIQ Chat";
export const PRODUCT_SHORT_NAME = PRODUCT_NAME;
// Legacy labels remain only for storage/domain migration compatibility.
export const LEGACY_PRODUCT_NAME = "SentIQGPT";

export const CANONICAL_FRONTEND_ORIGIN = "https://sentiqchat.sentiqlabs.com";
// Exported for compatibility. Old frontend domains are handled by Cloudflare 301 redirects and are not allowed by default.
export const LEGACY_FRONTEND_ORIGINS = [] as const;

export const PRODUCT_DISCLAIMER =
  `${PRODUCT_NAME} is an AI assistant. Verify important information independently.`;

export const PUBLIC_BACKEND_SERVICE_NAME = `${PRODUCT_NAME} backend`;
export const PUBLIC_SYSTEM_NAME = PRODUCT_NAME;
export const LOG_PREFIX = "[SentIQ Chat]";
export const SERVICE_USER_AGENT = "SentIQChat/2.0";
