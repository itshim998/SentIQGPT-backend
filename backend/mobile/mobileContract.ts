import express, { type Response } from "express";

export const MOBILE_CONTRACT_VERSION = 4;
export const MOBILE_MINIMUM_CLIENT_CONTRACT_VERSION = 1;

export const MOBILE_CONTRACT = Object.freeze({
  contract_version: MOBILE_CONTRACT_VERSION,
  minimum_client_contract_version: MOBILE_MINIMUM_CLIENT_CONTRACT_VERSION,
  compatibility: Object.freeze({
    unknown_fields: "ignore",
    unknown_sse_events: "ignore",
  }),
  client: Object.freeze({
    platform: "android",
    recommended_flutter: "3.44.8",
    minimum_android_api: 28,
  }),
  sse: Object.freeze({
    version: 1,
    event_types: Object.freeze([
      "token",
      "file_token",
      "file_artifact",
      "thinking",
      "structured_response",
      "route",
      "tool_selected",
      "tool_started",
      "tool_result",
      "tool_error",
      "websurf_sources",
      "websurf_complete",
      "memory",
      "sync",
      "file_analysis",
      "init",
      "progress",
      "sources",
      "content",
      "snapshot",
      "cancelled",
      "deep_research_progress",
      "deep_research_source",
      "deep_research_complete",
      "deep_research_error",
      "error",
      "done",
    ]),
  }),
  endpoints: Object.freeze({
    config: "/api/config",
    chat: "/api/chat",
    chat_stream: "/api/chat/stream",
    chat_sync: "/api/chat/sync",
    chat_selection: "/api/chat/selection",
    chat_title: "/api/chat/title",
    conversations: "/api/conversations",
    conversation_messages: "/api/conversations/:id/messages",
    conversation_title: "/api/conversations/:id/title",
    file_upload: "/api/files/upload",
    file_updates: "/api/files/updates",
    image_generation: "/api/images/generate",
    image_quota: "/api/images/quota",
    image_delete: "/api/images/:id",
    file_session: "/api/files/session",
    generated_file_download: "/api/generated-files/:id/download",
    generated_file_preview: "/api/generated-files/:id/preview-url",
    generated_file_update: "/api/generated-files/:id",
    generated_file_delete: "/api/generated-files/:id",
    deep_research_start: "/api/deep-research/start",
    deep_research_quota: "/api/deep-research/quota",
    deep_research_status: "/api/deep-research/:id/status",
    deep_research_events: "/api/deep-research/:id/events",
    deep_research_cancel: "/api/deep-research/:id/cancel",
    deep_research_report: "/api/deep-research/:id",
    deep_research_export: "/api/deep-research/:id/export",
    billing_plans: "/api/billing/plans",
    billing_me: "/api/billing/me",
    billing_usage: "/api/billing/usage",
    billing_checkout: "/api/billing/checkout",
    billing_verify: "/api/billing/verify",
    billing_cancel: "/api/billing/cancel",
    live_status: "/api/live/status",
    live_session_token: "/api/live/session-token",
    live_session_started: "/api/live/session/:id/started",
    live_session_commit: "/api/live/session/:id/commit",
    live_session_end: "/api/live/session/:id/end",
  }),
});

export type PublicConfigPayload = Record<string, unknown>;

export function withMobileContract<T>(payload: T): T | (T & {
  mobile_contract: typeof MOBILE_CONTRACT;
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const record = payload as PublicConfigPayload;
  if (record.mobile_contract) return payload;
  return {
    ...record,
    mobile_contract: MOBILE_CONTRACT,
  } as T & { mobile_contract: typeof MOBILE_CONTRACT };
}

const PATCH_MARKER = Symbol.for("sentiq.mobile-config-contract.installed");

export function installMobileConfigContract(): void {
  const responsePrototype = express.response;
  const patchState = responsePrototype as unknown as Record<PropertyKey, unknown>;
  if (patchState[PATCH_MARKER] === true) return;

  const originalJson = responsePrototype.json;
  responsePrototype.json = function sentiqMobileConfigJson(
    this: Response,
    body?: unknown,
  ): Response {
    const nextBody = this.req?.path === "/api/config"
      ? withMobileContract(body)
      : body;
    return originalJson.call(this, nextBody);
  } as typeof responsePrototype.json;
  patchState[PATCH_MARKER] = true;
}

installMobileConfigContract();
