// ================================================================
// Public error messages
// ================================================================
const ERROR_MESSAGES = {
  network_unavailable: "SentIQGPT could not reach the network. Check your connection and try again.",
  request_timed_out: "That request took too long. Please try again.",
  response_interrupted: "The response was interrupted. Your partial answer has been preserved.",
  backend_unavailable: "SentIQGPT is temporarily unavailable. Please try again shortly.",
  auth_required: "Please log in to continue.",
  profile_setup_required: "Add your display name to continue.",
  file_too_large: "That file is too large to process.",
  unsupported_file_type: "That file type is not supported.",
  file_analysis_failed: "File analysis could not finish. Please try again.",
  search_unavailable: "Web search is temporarily unavailable. Please try again shortly.",
  browser_feature_blocked: "A browser feature required for that action is blocked.",
  storage_unavailable: "Browser storage is unavailable. This session will use temporary storage.",
  rate_limit: "You have reached a temporary usage limit. Please try again later.",
  unknown_recoverable: "SentIQGPT could not finish that action. Please try again.",
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
