export const ARTIFACT_WORKSPACE_VERSION = "13.2";
export const ARTIFACT_WORKSPACE_MEDIA_QUERY = "(min-width: 1100px) and (min-height: 680px)";

export function normalizeArtifactWorkspaceKind(value) {
  const source = String(value || "").toLowerCase();
  if (source.includes("generated-file-panel") || source === "file") return "file";
  if (source.includes("message-chart-container") || source === "chart") return "chart";
  return "";
}

export function shouldOfferArtifactWorkspace({
  mediaMatches = false,
  connected = false,
  kind = "",
} = {}) {
  return Boolean(mediaMatches && connected && ["file", "chart"].includes(normalizeArtifactWorkspaceKind(kind)));
}

export function buildArtifactWorkspaceTitle({ kind = "", title = "", format = "" } = {}) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (cleanTitle) return cleanTitle;
  const normalizedKind = normalizeArtifactWorkspaceKind(kind);
  if (normalizedKind === "chart") return "Generated chart";
  const cleanFormat = String(format || "").replace(/^format-/, "").trim().toUpperCase();
  return cleanFormat ? `${cleanFormat} artifact` : "Generated artifact";
}

export function getArtifactWorkspacePlaceholderHeight(value) {
  const height = Math.max(0, Number(value) || 0);
  return height > 0 ? `${Math.round(height)}px` : "1px";
}
