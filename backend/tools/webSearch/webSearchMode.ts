export type WebSearchMode = "basic" | "advanced";

export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = "basic";

export function normalizeWebSearchMode(
  value: unknown,
  fallback: WebSearchMode = DEFAULT_WEB_SEARCH_MODE
): WebSearchMode {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "advanced") return "advanced";
  if (normalized === "basic") return "basic";
  return fallback;
}
