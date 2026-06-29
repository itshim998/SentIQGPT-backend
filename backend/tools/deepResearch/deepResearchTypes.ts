// SentIQ Chat v2 — Deep Research Types

export type DeepResearchStatus = "running" | "completed" | "failed" | "cancelled";

export interface DeepResearchSource {
  title: string;
  url: string;
}

export interface DeepResearchReport {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string | null;
  title: string;
  content: string | null;
  sources: DeepResearchSource[];
  status: DeepResearchStatus;
  request_metadata: Record<string, any>;
  search_count: number;
  citation_count: number;
  created_at: string;
  updated_at: string;
}

export type DeepResearchEventType =
  | "init"
  | "progress"
  | "sources"
  | "content"
  | "done"
  | "error";

export interface DeepResearchEvent {
  type: DeepResearchEventType;
  report_id?: string;
  step?: "plan" | "search" | "synthesize";
  query?: string;
  sources?: DeepResearchSource[];
  text?: string;
  error?: string;
  code?: string;
}

export type DeepResearchEventHandler = (
  event: DeepResearchEvent,
) => void | Promise<void>;
