// SentIQ Chat v2 — Deep Research Service
//
// Manages sharded DB report lifecycle (creation, progress updates, completion,
// cancellation, and retrieval).

import type { DeepResearchReport, DeepResearchSource } from "./deepResearchTypes";

export class DeepResearchService {
  async createReport(args: {
    userDb: any;
    userId: string;
    conversationId: string;
    title: string;
    requestMetadata?: Record<string, any>;
  }): Promise<string> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .insert({
        user_id: args.userId,
        conversation_id: args.conversationId,
        title: args.title,
        status: "running",
        request_metadata: args.requestMetadata ?? {},
        sources: [],
      })
      .select("id")
      .single();

    if (error) {
      throw new Error(`Failed to create deep research report: ${error.message}`);
    }
    return data.id;
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
  }): Promise<void> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "completed",
        content: args.content,
        sources: args.sources,
        search_count: args.searchCount,
        citation_count: args.sources.length,
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
  }): Promise<void> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "failed",
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
  }): Promise<void> {
    const { data, error } = await args.userDb
      .from("deep_research_reports")
      .update({
        status: "cancelled",
        content: args.partialContent || null,
        sources: args.sources,
        search_count: args.searchCount,
        citation_count: args.sources.length,
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
