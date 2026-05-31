export const SENTIQ_SUPABASE_URL = window.SENTIQ_SUPABASE_URL || "https://lzgohufdrqjdupfsvqlj.supabase.co";
export const SENTIQ_SUPABASE_ANON_KEY = window.SENTIQ_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6Z29odWZkcnFqZHVwZnN2cWxqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNjYwNTYsImV4cCI6MjA4OTk0MjA1Nn0.S1UYzT1yeMcCFSlcjYVfLkzzQtpwjmYWaeu74gFn-Pw";
export const SENTIQ_API_BASE = window.SENTIQ_API_BASE ||
  (location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3001"
    : "https://sentiqgpt-backend.ashygrass-913d190e.centralindia.azurecontainerapps.io");
export const SENTIQ_SUPPORT_EMAIL = window.SENTIQ_SUPPORT_EMAIL || "support@sentiqlabs.com";

window.SENTIQ_SUPABASE_URL = SENTIQ_SUPABASE_URL;
window.SENTIQ_SUPABASE_ANON_KEY = SENTIQ_SUPABASE_ANON_KEY;
window.SENTIQ_API_BASE = SENTIQ_API_BASE;
window.SENTIQ_SUPPORT_EMAIL = SENTIQ_SUPPORT_EMAIL;
