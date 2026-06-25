export const SENTIQ_SUPABASE_URL = window.SENTIQ_SUPABASE_URL || "https://lzgohufdrqjdupfsvqlj.supabase.co";
export const SENTIQ_SUPABASE_ANON_KEY = window.SENTIQ_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Z29odWZkcnFqZHVwZnN2cWxqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNjYwNTYsImV4cCI6MjA4OTk0MjA1Nn0.S1UYzT1yeMcCFSlcjYVfLkzzQtpwjmYWaeu74gFn-Pw";
export const SENTIQ_SUPPORT_EMAIL = window.SENTIQ_SUPPORT_EMAIL || "support@sentiqlabs.com";

const PRODUCTION_API_BASE = "https://sentiqgpt-backend.ashygrass-913d190e.centralindia.azurecontainerapps.io";
const LOCAL_DEV_API_BASE = "http://localhost:3001";
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);

function normalizeApiBase(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isLocalWebDevelopment() {
  return LOCAL_DEV_HOSTS.has(location.hostname) && location.protocol === "http:";
}

function resolveApiBase() {
  const configured = normalizeApiBase(window.SENTIQ_API_BASE);
  if (configured) return configured;
  if (isLocalWebDevelopment()) return LOCAL_DEV_API_BASE;
  // Azure backend resource identifier remains unchanged until a verified replacement exists.
  return PRODUCTION_API_BASE;
}

export const SENTIQ_API_BASE = resolveApiBase();

window.SENTIQ_SUPABASE_URL = SENTIQ_SUPABASE_URL;
window.SENTIQ_SUPABASE_ANON_KEY = SENTIQ_SUPABASE_ANON_KEY;
window.SENTIQ_API_BASE = SENTIQ_API_BASE;
window.SENTIQ_SUPPORT_EMAIL = SENTIQ_SUPPORT_EMAIL;
