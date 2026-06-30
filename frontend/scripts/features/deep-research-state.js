const DEEP_RESEARCH_STATUSES = new Set(["running", "completed", "cancelled", "failed"]);

export function resolveDeepResearchCardState(meta = {}, content = "", snapshot = null) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const statusCandidate = source.status || meta.status || "completed";
  const status = DEEP_RESEARCH_STATUSES.has(statusCandidate) ? statusCandidate : "failed";
  const reportId = source.report_id || source.reportId || meta.reportId || meta.report_id || "";
  const partialContent = typeof source.partial_content === "string"
    ? source.partial_content
    : typeof source.content === "string" && source.content
      ? source.content
      : String(content || "");
  const finalContent = status === "completed"
    ? (typeof source.content === "string" && source.content ? source.content : partialContent)
    : partialContent;
  const progressValue = Number(source.progress_percent ?? meta.progressPercent ?? 0);

  return {
    reportId,
    status,
    title: source.title || meta.title || "Deep Research Report",
    content: finalContent,
    partialContent,
    sources: Array.isArray(source.sources) ? source.sources : Array.isArray(meta.sources) ? meta.sources : [],
    progressPercent: Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : 0,
    progressPhase: source.progress_phase || meta.progressPhase || "queued",
    latestStatusText: source.latest_status_text || meta.latestStatusText || "",
    shouldMonitor: status === "running" && Boolean(reportId),
  };
}
