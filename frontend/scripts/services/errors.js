// ================================================================
// Public error messages
// ================================================================
import { PRODUCT_NAME } from "../shared/brand.js";

const ERROR_MESSAGES = {
  network_unavailable: "No connection. Check your network and try again.",
  request_timed_out: "The request timed out. Try again.",
  response_interrupted: "Response interrupted. Partial answer saved.",
  backend_unavailable: `${PRODUCT_NAME} is unavailable. Try again soon.`,
  auth_required: "Sign in to continue.",
  profile_setup_required: "Add your name to continue.",
  file_too_large: "File is too large.",
  unsupported_file_type: "File type not supported.",
  file_analysis_failed: "Couldn't analyse the file. Try again.",
  search_unavailable: "Web search is unavailable. Try again soon.",
  browser_feature_blocked: "Your browser blocked this action.",
  storage_unavailable: "Browser storage is unavailable. Data won't be kept after this session.",
  rate_limit: "Usage limit reached. Try again later.",
  unknown_recoverable: "Something went wrong. Try again.",
};

function inferCategory(error, context = {}) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || 0);
  if (code === "profile_name_required") return "profile_setup_required";
  if (code.includes("browser_feature")) return "browser_feature_blocked";
  if (code.includes("storage")) return "storage_unavailable";
  if (code.includes("response_interrupted")) return "response_interrupted";
  if (status === 401 || code.includes("auth")) return "auth_required";
  if (status === 429 || code.includes("rate")) return "rate_limit";
  if (code.includes("unsupported") || message.includes("unsupported file")) return "unsupported_file_type";
  if (code.includes("file_too_large") || message.includes("too large")) return "file_too_large";
  if (code.includes("search")) return "search_unavailable";
  if (code.includes("file_analysis")) return "file_analysis_failed";
  if (context.area === "file") return "file_analysis_failed";
  if (context.area === "stream" && context.partial) return "response_interrupted";
  if (code.includes("timeout") || error?.name === "TimeoutError") return "request_timed_out";
  if (error?.name === "AbortError" && !context.userStopped) return "response_interrupted";
  if (status >= 500) return "backend_unavailable";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "network_unavailable";
  if (error instanceof TypeError && message.includes("fetch")) return "network_unavailable";
  return "unknown_recoverable";
}

function normalizeError(error, context = {}) {
  const category = inferCategory(error, context);
  return {
    category,
    message: ERROR_MESSAGES[category] || ERROR_MESSAGES.unknown_recoverable,
    canRetry: !["auth_required", "profile_setup_required", "file_too_large", "unsupported_file_type"].includes(category),
    canContinue: category === "response_interrupted",
    requiresSignIn: category === "auth_required",
    dataPreserved: category === "response_interrupted",
    status: Number(error?.status || 0),
    code: String(error?.code || ""),
  };
}

function getSafeErrorMessage(error, context = {}) {
  return normalizeError(error, context).message;
}

window.SentIQErrors = { getSafeErrorMessage, normalizeError };

export { getSafeErrorMessage, normalizeError };
