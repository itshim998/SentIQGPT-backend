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

export type DeepResearchProgressPhase = "queued" | "plan" | "search" | "synthesize";

export interface DeepResearchRuntimeMetadata {
  prompt?: string;
  client_request_id?: string;
  progress_percent?: number;
  progress_phase?: DeepResearchProgressPhase;
  latest_status_text?: string;
  tavily_request_id?: string | null;
  started_at?: string;
  completed_at?: string | null;
  cancelled_at?: string | null;
  failed_at?: string | null;
  cancellation_requested?: boolean;
  provider_accepted?: boolean;
  heartbeat_at?: string | null;
  worker_id?: string | null;
  error_code?: string | null;
}

export interface DeepResearchStatusSnapshot {
  report_id: string;
  conversation_id: string;
  message_id: string | null;
  title: string;
  status: DeepResearchStatus;
  progress_percent: number;
  progress_phase: DeepResearchProgressPhase;
  latest_status_text: string;
  partial_content: string;
  content: string;
  sources: DeepResearchSource[];
  search_count: number;
  citation_count: number;
  cancellation_requested: boolean;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
}

export type DeepResearchEventType =
  | "init"
  | "progress"
  | "sources"
  | "content"
  | "snapshot"
  | "done"
  | "cancelled"
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
  report?: DeepResearchStatusSnapshot;
}

export type DeepResearchEventHandler = (
  event: DeepResearchEvent,
) => void | Promise<void>;
