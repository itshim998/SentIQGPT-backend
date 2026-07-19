/* SentIQ Liquid Glass V4 — Phase 7.4 semantic activity state */

export const SEMANTIC_ACTIVITY_VERSION = "7.4";

export const SEMANTIC_ACTIVITY_LABELS = Object.freeze({
  thinking: "Thinking",
  "reading-files": "Reading files",
  searching: "Searching",
  "comparing-sources": "Comparing sources",
  "creating-image": "Creating image",
  "preparing-document": "Preparing document",
  "generating-chart": "Generating chart",
});

export const SEMANTIC_SEARCH_COMPARE_DELAY_MS = 3600;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function getSemanticActivityLabel(state = "thinking") {
  return SEMANTIC_ACTIVITY_LABELS[state] || SEMANTIC_ACTIVITY_LABELS.thinking;
}

export function inferSemanticActivity(input = {}) {
  const text = clean(input.text);
  const loaderKind = clean(input.loaderKind);
  const hasAttachments = Boolean(input.hasAttachments);

  if (/compar(?:e|ing)|cross[- ]?check|reviewing sources/.test(text)) return "comparing-sources";
  if (/search|web surf|brows/.test(text)) return "searching";
  if (/creat(?:e|ing).*image|generat(?:e|ing).*image/.test(text) || loaderKind === "loader-image") {
    return "creating-image";
  }
  if (/generat(?:e|ing).*chart|prepar(?:e|ing).*chart|plot/.test(text) || loaderKind === "loader-chart") {
    return "generating-chart";
  }
  if (/reading files/.test(text)) return "reading-files";
  if (/prepar(?:e|ing).*document|generat(?:e|ing).*file|read(?:ing)? file/.test(text)) {
    return "preparing-document";
  }
  if (hasAttachments && (!text || /think|reason|prepar|work/.test(text))) return "reading-files";
  return "thinking";
}

export function getTimedSemanticActivity(state) {
  return state === "searching" ? "comparing-sources" : state;
}

export function isPublicSemanticActivityLabel(value) {
  const label = String(value || "").trim();
  return Object.values(SEMANTIC_ACTIVITY_LABELS).includes(label);
}
