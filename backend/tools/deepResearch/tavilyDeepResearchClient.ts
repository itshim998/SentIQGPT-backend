// SentIQ Chat v2 — Tavily Deep Research Client
//
// Streaming client for Tavily Research API with key rotation, safe error
// mapping, provider-acceptance signaling, and chunk-safe SSE parsing.

import {
  keyManager as sharedKeyManager,
  type TavilyKeyManager,
} from "../webSearch/providers/tavilyKeyManager";
import type {
  DeepResearchEvent,
  DeepResearchEventHandler,
  DeepResearchSource,
} from "./deepResearchTypes";

const TAVILY_RESEARCH_ENDPOINT = "https://api.tavily.com/research";
const REQUEST_CONNECT_TIMEOUT_MS = 30_000;
const RETRYABLE_KEY_STATUSES = new Set([401, 403, 429, 432, 433]);
const RATE_LIMIT_STATUSES = new Set([429, 432, 433]);

type KeyManagerContract = Pick<
  TavilyKeyManager,
  "getTotalCount" | "getNextKey" | "markFailed" | "markSuccess"
>;

type TavilyDeepResearchClientOptions = {
  keyManager?: KeyManagerContract;
  fetchImpl?: typeof fetch;
  connectTimeoutMs?: number;
};

export type StreamResearchOptions = {
  onAccepted?: () => void | Promise<void>;
};

type SseRecord = {
  event: string;
  data: string;
};

export class TavilyDeepResearchError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly providerAccepted: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      providerAccepted?: boolean;
      retryAfterMs?: number;
    },
  ) {
    super(message);
    this.name = "TavilyDeepResearchError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.providerAccepted = options.providerAccepted === true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

class TavilySseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];

  push(chunk: string): SseRecord[] {
    this.buffer += chunk;
    const records: SseRecord[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const record = this.processLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
      if (record) records.push(record);
      newlineIndex = this.buffer.indexOf("\n");
    }
    return records;
  }

  finish(): SseRecord[] {
    const records: SseRecord[] = [];
    if (this.buffer.length > 0) {
      const record = this.processLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
      if (record) records.push(record);
      this.buffer = "";
    }
    const trailing = this.dispatch();
    if (trailing) records.push(trailing);
    return records;
  }

  private processLine(line: string): SseRecord | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;

    const colonIndex = line.indexOf(":");
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : "";
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
    return null;
  }

  private dispatch(): SseRecord | null {
    if (!this.eventName && this.dataLines.length === 0) return null;
    const record = {
      event: this.eventName || "message",
      data: this.dataLines.join("\n"),
    };
    this.eventName = "";
    this.dataLines = [];
    return record;
  }
}

function normalizeSources(value: unknown): DeepResearchSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((source: any) => ({
      title: typeof source?.title === "string" && source.title.trim()
        ? source.title.trim()
        : typeof source?.name === "string" && source.name.trim()
          ? source.name.trim()
          : "Source",
      url: typeof source?.url === "string" ? source.url.trim() : "",
    }))
    .filter((source) => Boolean(source.url));
}

function readLegacyQuery(argumentsValue: unknown): string {
  if (typeof argumentsValue !== "string" || !argumentsValue.trim()) return "";
  try {
    const parsed = JSON.parse(argumentsValue);
    return typeof parsed?.query === "string" ? parsed.query.trim() : "";
  } catch {
    const match = argumentsValue.match(/"query"\s*:\s*"([^"]+)"/);
    return match?.[1]?.trim() || "";
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

export class TavilyDeepResearchClient {
  private readonly keyManager: KeyManagerContract;
  private readonly fetchImpl: typeof fetch;
  private readonly connectTimeoutMs: number;

  constructor(options: TavilyDeepResearchClientOptions = {}) {
    this.keyManager = options.keyManager ?? sharedKeyManager;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectTimeoutMs = options.connectTimeoutMs ?? REQUEST_CONNECT_TIMEOUT_MS;
  }

  async streamResearch(
    query: string,
    onEvent: DeepResearchEventHandler,
    signal?: AbortSignal,
    options: StreamResearchOptions = {},
  ): Promise<void> {
    const totalKeys = this.keyManager.getTotalCount();
    if (totalKeys === 0) {
      throw new TavilyDeepResearchError(
        "Research service is not configured.",
        { code: "research_not_configured" },
      );
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const apiKey = this.keyManager.getNextKey();
      if (!apiKey) {
        throw new TavilyDeepResearchError(
          "Research service is temporarily unavailable.",
          { code: "research_keys_cooling_down" },
        );
      }

      try {
        await this.executeStreamRequest(query, apiKey, onEvent, signal, options);
        this.keyManager.markSuccess(apiKey);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("Research request failed.");

        if (signal?.aborted) throw lastError;
        if (error instanceof TavilyDeepResearchError && error.providerAccepted) {
          throw error;
        }

        const statusCode = error instanceof TavilyDeepResearchError ? error.statusCode : undefined;
        if (statusCode && RETRYABLE_KEY_STATUSES.has(statusCode)) {
          this.keyManager.markFailed(
            apiKey,
            RATE_LIMIT_STATUSES.has(statusCode),
            error instanceof TavilyDeepResearchError ? error.retryAfterMs : undefined,
          );
          console.warn("[Deep Research] Tavily key unavailable; trying another configured key.");
          continue;
        }

        this.keyManager.markFailed(apiKey, false);
        throw lastError;
      }
    }

    throw lastError ?? new TavilyDeepResearchError(
      "Research service is temporarily unavailable.",
      { code: "research_keys_unavailable" },
    );
  }

  private async executeStreamRequest(
    query: string,
    apiKey: string,
    onEvent: DeepResearchEventHandler,
    signal: AbortSignal | undefined,
    options: StreamResearchOptions,
  ): Promise<void> {
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.connectTimeoutMs);
    const combinedSignal = signal
      ? this.anySignal([signal, timeoutController.signal])
      : timeoutController.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(TAVILY_RESEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ input: query, model: "pro", stream: true }),
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeoutController.signal.aborted) {
        throw new TavilyDeepResearchError(
          "Research service connection timed out.",
          { code: "research_connect_timeout" },
        );
      }
      throw new TavilyDeepResearchError(
        "Research service could not be reached.",
        { code: "research_provider_unavailable" },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      throw this.mapProviderError(response.status, retryAfterMs);
    }

    await options.onAccepted?.();

    const reader = response.body?.getReader();
    if (!reader) {
      throw new TavilyDeepResearchError(
        "Research provider returned an unreadable response.",
        { code: "research_stream_unreadable", providerAccepted: true },
      );
    }

    const decoder = new TextDecoder("utf-8");
    const parser = new TavilySseParser();
    let sawDone = false;

    const processRecords = async (records: SseRecord[]): Promise<void> => {
      for (const record of records) {
        if (sawDone) return;
        sawDone = await this.processSseRecord(record, onEvent);
      }
    };

    try {
      while (!sawDone) {
        const { value, done } = await reader.read();
        if (done) break;
        await processRecords(parser.push(decoder.decode(value, { stream: true })));
      }

      if (!sawDone) {
        await processRecords(parser.push(decoder.decode()));
        await processRecords(parser.finish());
      }

      if (!sawDone) {
        throw new TavilyDeepResearchError(
          "Research stream ended before completion.",
          { code: "research_stream_incomplete", providerAccepted: true },
        );
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async processSseRecord(
    record: SseRecord,
    onEvent: DeepResearchEventHandler,
  ): Promise<boolean> {
    if (record.event.toLowerCase() === "done" || record.data.trim() === "[DONE]") {
      await onEvent({ type: "done" });
      return true;
    }
    if (!record.data.trim()) return false;

    let parsed: any;
    try {
      parsed = JSON.parse(record.data);
    } catch {
      throw new TavilyDeepResearchError(
        "Research provider returned malformed stream data.",
        { code: "research_stream_malformed", providerAccepted: true },
      );
    }

    if (parsed?.object === "error" || typeof parsed?.error === "string") {
      const event: DeepResearchEvent = {
        type: "error",
        error: "The research provider could not complete this request.",
        code: "research_provider_error",
      };
      await onEvent(event);
      throw new TavilyDeepResearchError(event.error || "Research provider error.", {
        code: event.code || "research_provider_error",
        providerAccepted: true,
      });
    }

    const delta = parsed?.choices?.[0]?.delta;
    if (!delta || typeof delta !== "object") return false;

    await this.emitToolEvents(delta.tool_calls, onEvent);

    if (typeof delta.content === "string" && delta.content.length > 0) {
      await onEvent({ type: "content", text: delta.content });
    }

    const finalSources = normalizeSources(delta.sources);
    if (finalSources.length > 0) {
      await onEvent({ type: "sources", sources: finalSources });
    }
    return false;
  }

  private async emitToolEvents(
    toolCalls: unknown,
    onEvent: DeepResearchEventHandler,
  ): Promise<void> {
    if (!toolCalls) return;

    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        const query = readLegacyQuery(toolCall?.function?.arguments);
        if (query) await onEvent({ type: "progress", step: "search", query });
      }
      return;
    }

    if (typeof toolCalls !== "object") return;
    const envelope = toolCalls as any;
    if (envelope.type === "tool_call" && Array.isArray(envelope.tool_call)) {
      for (const tool of envelope.tool_call) {
        const name = typeof tool?.name === "string" ? tool.name.toLowerCase() : "";
        if (name === "planning") {
          await onEvent({ type: "progress", step: "plan" });
          continue;
        }
        if (name === "generating") {
          await onEvent({ type: "progress", step: "synthesize" });
          continue;
        }
        if (name === "websearch" || name === "researchsubtopic") {
          const queries = Array.isArray(tool?.queries)
            ? tool.queries.filter((query: unknown) => typeof query === "string" && query.trim())
            : [];
          if (queries.length === 0) {
            await onEvent({ type: "progress", step: "search" });
          } else {
            for (const query of queries) {
              await onEvent({ type: "progress", step: "search", query: query.trim() });
            }
          }
        }
      }
    }

    if (envelope.type === "tool_response" && Array.isArray(envelope.tool_response)) {
      for (const toolResponse of envelope.tool_response) {
        const sources = normalizeSources(toolResponse?.sources);
        if (sources.length > 0) await onEvent({ type: "sources", sources });
      }
    }
  }

  private mapProviderError(status: number, retryAfterMs?: number): TavilyDeepResearchError {
    if (status === 401 || status === 403) {
      return new TavilyDeepResearchError(
        "Research service authentication failed.",
        { code: "research_provider_auth", statusCode: status },
      );
    }
    if (RATE_LIMIT_STATUSES.has(status)) {
      return new TavilyDeepResearchError(
        "Research service rate limit reached. Please try again later.",
        { code: "research_provider_rate_limited", statusCode: status, retryAfterMs },
      );
    }
    if (status >= 500) {
      return new TavilyDeepResearchError(
        "Research service is temporarily unavailable.",
        { code: "research_provider_unavailable", statusCode: status },
      );
    }
    return new TavilyDeepResearchError(
      "Research provider rejected the request.",
      { code: "research_provider_rejected", statusCode: status },
    );
  }

  private anySignal(signals: AbortSignal[]): AbortSignal {
    const nativeAny = (AbortSignal as typeof AbortSignal & {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }).any;
    if (typeof nativeAny === "function") return nativeAny(signals);

    const controller = new AbortController();
    for (const sourceSignal of signals) {
      if (sourceSignal.aborted) {
        controller.abort(sourceSignal.reason);
        break;
      }
      sourceSignal.addEventListener(
        "abort",
        () => controller.abort(sourceSignal.reason),
        { once: true },
      );
    }
    return controller.signal;
  }
}
