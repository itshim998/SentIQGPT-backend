export const STREAMING_POLISH_VERSION = "12.8";

const SIGNIFICANT_ACTIVITIES = new Set([
  "searching",
  "comparing-sources",
  "reading-files",
  "preparing-document",
  "creating-image",
  "generating-chart",
]);

export function normalizeStreamingActivity(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[._/]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  if (/compar(?:e|ing|ed).*source/.test(normalized)) return "comparing-sources";
  if (/search|web ?surf|research/.test(normalized)) return "searching";
  if (/read(?:ing)? file|analys(?:e|ing|ed) file|file analysis/.test(normalized)) return "reading-files";
  if (/prepar(?:e|ing|ed).*(document|file)|document preparation/.test(normalized)) return "preparing-document";
  if (/creat(?:e|ing|ed).*image|image generation/.test(normalized)) return "creating-image";
  if (/generat(?:e|ing|ed).*chart|chart generation/.test(normalized)) return "generating-chart";
  if (/reason/.test(normalized)) return "reasoning";
  if (/think|running|working/.test(normalized)) return "thinking";
  return "";
}

export function formatProcessDuration(elapsedMs) {
  const milliseconds = Math.max(0, Number(elapsedMs) || 0);
  if (milliseconds < 850) return "";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function deriveCompletedProcessSummary(input = {}) {
  const normalizedActivities = new Set(
    (Array.isArray(input.activities) ? input.activities : [])
      .map(normalizeStreamingActivity)
      .filter(Boolean),
  );
  const hasThinking = Boolean(input.hasThinking);
  const duration = formatProcessDuration(input.elapsedMs);

  let label = "";
  if (normalizedActivities.has("comparing-sources") || normalizedActivities.has("searching")) {
    label = hasThinking ? "Researched and reasoned" : "Researched";
  } else if (normalizedActivities.has("reading-files")) {
    label = hasThinking ? "Read files and reasoned" : "Read files";
  } else if (normalizedActivities.has("preparing-document")) {
    label = hasThinking ? "Prepared and reasoned" : "Document prepared";
  } else if (normalizedActivities.has("generating-chart")) {
    label = hasThinking ? "Analysed and generated chart" : "Chart generated";
  } else if (normalizedActivities.has("creating-image")) {
    label = hasThinking ? "Planned and created image" : "Image created";
  } else if (hasThinking || normalizedActivities.has("reasoning")) {
    label = "Reasoned";
  } else if (normalizedActivities.has("thinking")) {
    label = "Response prepared";
  }

  if (!label) return "";
  return duration ? `${label} · ${duration}` : label;
}

export function hasSignificantProcessActivity(activities = []) {
  return (Array.isArray(activities) ? activities : [])
    .map(normalizeStreamingActivity)
    .some((activity) => SIGNIFICANT_ACTIVITIES.has(activity));
}
