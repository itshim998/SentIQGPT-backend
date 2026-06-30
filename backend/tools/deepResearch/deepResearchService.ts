// SentIQ Chat v2 — Deep Research Service
//
// Manages sharded DB report lifecycle (creation, progress updates, completion,
// cancellation, and retrieval).

import type {
  DeepResearchProgressPhase,
  DeepResearchReport,
  DeepResearchRuntimeMetadata,
  DeepResearchSource,
  DeepResearchStatusSnapshot,
} from "./deepResearchTypes";

function runtimeMetadata(report: DeepResearchReport): DeepResearchRuntimeMetadata {
  return report.request_metadata && typeof report.request_metadata === "object"
    ? report.request_metadata as DeepResearchRuntimeMetadata
    : {};
}

function boundedProgress(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

export function isDeepResearchHeartbeatStale(
  report: DeepResearchReport,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (report.status !== "running") return false;
  const runtime = runtimeMetadata(report);
  const heartbeatMs = Date.parse(runtime.heartbeat_at || report.updated_at || report.created_at);
  return !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs >= staleAfterMs;
}

export function buildDeepResearchStatusSnapshot(report: DeepResearchReport): DeepResearchStatusSnapshot {
  const runtime = runtimeMetadata(report);
  const content = typeof report.content === "string" ? report.content : "";
  const partialContentPreview = report.status === "running" ? content.slice(0, 16_000) : content;
  const terminalContent = report.status === "completed" ? content : "";
  return {
    report_id: report.id,
    conversation_id: report.conversation_id,
    message_id: report.message_id,
    title: report.title,
    status: report.status,
    progress_percent: boundedProgress(runtime.progress_percent ?? (report.status === "completed" ? 100 : 0)),
    progress_phase: runtime.progress_phase ?? (report.status === "completed" ? "synthesize" : "queued"),
    latest_status_text: runtime.latest_status_text ?? (
      report.status === "completed" ? "Research complete."
        : report.status === "cancelled" ? "Research cancelled."
          : report.status === "failed" ? "Research could not be completed."
            : "Research is running."
    ),
    partial_content: partialContentPreview,
    content: terminalContent,
    sources: Array.isArray(report.sources) ? report.sources : [],
    search_count: Number(report.search_count) || 0,
    citation_count: Number(report.citation_count) || 0,
    cancellation_requested: runtime.cancellation_requested === true,
    started_at: runtime.started_at || report.created_at,
    updated_at: report.updated_at,
    completed_at: runtime.completed_at || null,
    cancelled_at: runtime.cancelled_at || null,
    failed_at: runtime.failed_at || null,
  };
}

export class DeepResearchService {
  async findByClientRequest(args: {
    userDb: any;
    userId: string;
    conversationId: string;
    clientRequestId: string;
  }): Promise<DeepResearchReport | null> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .select("*")
      .eq("user_id", args.userId)
      .eq("conversation_id", args.conversationId)
      .contains("request_metadata", { client_request_id: args.clientRequestId })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Failed to check the Deep Research request state.");
    return data ? data as DeepResearchReport : null;
  }

  async createReport(args: {
    userDb: any;
    userId: string;
    conversationId: string;
    title: string;
    requestMetadata?: Record<string, any>;
    runtimeMetadata?: DeepResearchRuntimeMetadata;
  }): Promise<string> {
    const now = new Date().toISOString();
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .insert({
        user_id: args.userId,
        conversation_id: args.conversationId,
        title: args.title,
        status: "running",
        request_metadata: {
          ...(args.requestMetadata ?? {}),
          progress_percent: 0,
          progress_phase: "queued",
          latest_status_text: "Queued for Deep Research.",
          started_at: now,
          cancellation_requested: false,
          provider_accepted: false,
          heartbeat_at: now,
          ...(args.runtimeMetadata ?? {}),
        },
        sources: [],
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to create deep research report: ${error.message}`);
    }
    return data.id;
  }

  async updateProgress(args: {
    userDb: any;
    userId: string;
    reportId: string;
    partialContent: string;
    sources: DeepResearchSource[];
    searchCount: number;
    runtimeMetadata: DeepResearchRuntimeMetadata;
  }): Promise<void> {
    const { error } = await args.userDb
      .from("deep_research_reports")
      .update({
        content: args.partialContent || null,
        sources: args.sources,
        search_count: args.searchCount,
        citation_count: args.sources.length,
        request_metadata: args.runtimeMetadata,
      })
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .eq("status", "running");
    if (error) throw new Error("Failed to persist Deep Research progress.");
  }

  async updateReportMessageId(args: {
    userDb: any;
    userId: string;
    reportId: string;
    messageId: string;
  }): Promise<void> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({ message_id: args.messageId })
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (error || !data) {
      throw new Error("Failed to link the deep research report message.");
    }
  }

  async completeReport(args: {
    userDb: any;
    userId: string;
    reportId: string;
    content: string;
    sources: DeepResearchSource[];
    searchCount: number;
    runtimeMetadata?: DeepResearchRuntimeMetadata;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "completed",
        content: args.content,
        sources: args.sources,
        search_count: args.searchCount,
        citation_count: args.sources.length,
        ...(args.runtimeMetadata ? {
          request_metadata: {
            ...args.runtimeMetadata,
            progress_percent: 100,
            progress_phase: "synthesize",
            latest_status_text: "Research complete.",
            completed_at: now,
            heartbeat_at: null,
            worker_id: null,
          },
        } : {}),
      })
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (error || !data) {
      throw new Error("Failed to complete the deep research report.");
    }
  }

  async failReport(args: {
    userDb: any;
    userId: string;
    reportId: string;
    partialContent?: string;
    sources?: DeepResearchSource[];
    searchCount?: number;
    runtimeMetadata?: DeepResearchRuntimeMetadata;
    statusText?: string;
    errorCode?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "failed",
        ...(typeof args.partialContent === "string" ? { content: args.partialContent || null } : {}),
        ...(Array.isArray(args.sources) ? { sources: args.sources, citation_count: args.sources.length } : {}),
        ...(typeof args.searchCount === "number" ? { search_count: args.searchCount } : {}),
        ...(args.runtimeMetadata ? {
          request_metadata: {
            ...args.runtimeMetadata,
            latest_status_text: args.statusText || "Research could not be completed.",
            failed_at: now,
            heartbeat_at: null,
            worker_id: null,
            error_code: args.errorCode || "research_failed",
          },
        } : {}),
      })
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (error || !data) {
      throw new Error("Failed to mark the deep research report as failed.");
    }
  }

  async cancelReport(args: {
    userDb: any;
    userId: string;
    reportId: string;
    partialContent: string;
    sources: DeepResearchSource[];
    searchCount: number;
    runtimeMetadata?: DeepResearchRuntimeMetadata;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "cancelled",
        content: args.partialContent || null,
        sources: args.sources,
        search_count: args.searchCount,
        citation_count: args.sources.length,
        ...(args.runtimeMetadata ? {
          request_metadata: {
            ...args.runtimeMetadata,
            progress_percent: boundedProgress(args.runtimeMetadata.progress_percent),
            latest_status_text: "Research cancelled.",
            cancellation_requested: true,
            cancelled_at: now,
            heartbeat_at: null,
            worker_id: null,
          },
        } : {}),
      })
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .eq("status", "running")
      .select("id")
      .maybeSingle();

    if (error || !data) {
      throw new Error("Failed to cancel the deep research report.");
    }
  }

  async requestCancellation(args: {
    userDb: any;
    userId: string;
    report: DeepResearchReport;
  }): Promise<void> {
    const metadata = runtimeMetadata(args.report);
    const { error } = await args.userDb
      .from("deep_research_reports")
      .update({
        request_metadata: {
          ...metadata,
          cancellation_requested: true,
          latest_status_text: "Cancelling research...",
        },
      })
      .eq("id", args.report.id)
      .eq("user_id", args.userId)
      .eq("status", "running");
    if (error) throw new Error("Failed to request Deep Research cancellation.");
  }

  async isCancellationRequested(args: {
    userDb: any;
    userId: string;
    reportId: string;
  }): Promise<boolean> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .select("status,request_metadata")
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .single();
    if (error || !data) return false;
    return data.status === "cancelled" || data.request_metadata?.cancellation_requested === true;
  }

  async getReport(args: {
    userDb: any;
    userId: string;
    reportId: string;
  }): Promise<DeepResearchReport> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .select("*")
      .eq("id", args.reportId)
      .eq("user_id", args.userId)
      .single();

    if (error || !data) {
      throw new Error("Report not found");
    }
    return data as DeepResearchReport;
  }
}
