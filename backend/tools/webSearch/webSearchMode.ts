export type WebSearchMode = "basic" | "advanced";

export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "basic";

export function isWebSearchMode(value: unknown): value is WebSearchMode {
  return value === "basic" || value === "advanced";
}

export function normalizeWebSearchMode(
  value: unknown,
  fallback: WebSearchMode = DEFAULT_WEB_SEARCH_MODE
): WebSearchMode {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "advanced") return "basic";
  return isWebSearchMode(normalized) ? normalized : fallback;
}
