import express, { type Response } from "express";

export const MOBILE_CONTRACT_VERSION = 1;
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
      "deep_research_progress",
      "deep_research_source",
      "deep_research_complete",
      "deep_research_error",
      "error",
    ]),
  }),
  endpoints: Object.freeze({
    config: "/api/config",
    chat: "/api/chat",
    chat_stream: "/api/chat/stream",
    conversations: "/api/conversations",
    file_upload: "/api/files/upload",
    file_updates: "/api/files/updates",
    image_generation: "/api/images/generate",
    deep_research_start: "/api/deep-research/start",
    billing_me: "/api/billing/me",
    live_status: "/api/live/status",
    live_session_token: "/api/live/session-token",
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
