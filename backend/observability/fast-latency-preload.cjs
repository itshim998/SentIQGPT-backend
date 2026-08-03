"use strict";

const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");
const { TransformStream } = require("node:stream/web");

const SCHEMA_VERSION = 1;
const TRACE_QUERY_PARAM = "latency_trace_id";
const TRACE_HEADER = "X-SentIQ-Latency-Trace";
const TELEMETRY_PATH = "/api/telemetry/fast-latency";
const SAFE_TRACE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_CLIENT_REPORT_BYTES = 12 * 1024;
const CLIENT_REPORTS_PER_MINUTE = 120;
const ENABLED = String(process.env.SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED ?? "true").toLowerCase() !== "false";
const SAMPLE_RATE = (() => {
  const parsed = Number(process.env.SENTIQ_FAST_LATENCY_SAMPLE_RATE ?? "1");
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 1;
})();

if (ENABLED && !globalThis.__sentiqFastLatencyNodeInstalled) {
  globalThis.__sentiqFastLatencyNodeInstalled = true;

  const requestContext = new AsyncLocalStorage();
  const clientReportBuckets = new Map();
  const originalServerEmit = http.Server.prototype.emit;
  const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
  let clientReportSweepCounter = 0;

  function nowNs() {
    return process.hrtime.bigint();
  }

  function elapsedMs(startNs) {
    return Number(nowNs() - startNs) / 1_000_000;
  }

  function roundMs(value) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : undefined;
  }

  function safeTraceId(value) {
    const traceId = typeof value === "string" ? value.trim() : "";
    return SAFE_TRACE_PATTERN.test(traceId) ? traceId : "";
  }

  function isSampled(traceId) {
    if (SAMPLE_RATE >= 1) return true;
    if (SAMPLE_RATE <= 0) return false;
    let hash = 2166136261;
    for (let index = 0; index < traceId.length; index += 1) {
      hash ^= traceId.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0x1_0000_0000 < SAMPLE_RATE;
  }

  function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => (
      item !== undefined && item !== null && item !== ""
    )));
  }

  function logLatency(phase, fields = {}, explicitContext = null) {
    const context = explicitContext || requestContext.getStore();
    if (!context?.traceId) return;
    const payload = compactObject({
      schema_version: SCHEMA_VERSION,
      scope: "fast_latency",
      layer: "node",
      phase,
      trace_id: context.traceId,
      execution_mode: "fast",
      elapsed_ms: roundMs(elapsedMs(context.startedNs)),
      epoch_ms: Date.now(),
      ...fields,
    });
    console.info(JSON.stringify(payload));
  }

  function parseIncomingUrl(req) {
    try {
      return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      return null;
    }
  }

  function getRemoteKey(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
    return forwarded || req.socket?.remoteAddress || "unknown";
  }

  function sweepClientReportBuckets(now) {
    clientReportSweepCounter += 1;
    if (clientReportSweepCounter % 256 !== 0 && clientReportBuckets.size < 10_000) return;
    for (const [key, value] of clientReportBuckets.entries()) {
      if (now - value.windowStartedAt > 2 * 60_000) clientReportBuckets.delete(key);
    }
  }

  function allowClientReport(req) {
    const key = getRemoteKey(req);
    const now = Date.now();
    sweepClientReportBuckets(now);
    const current = clientReportBuckets.get(key);
    if (!current || now - current.windowStartedAt >= 60_000) {
      clientReportBuckets.set(key, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= CLIENT_REPORTS_PER_MINUTE) return false;
    current.count += 1;
    return true;
  }

  function sanitizeClientReport(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const traceId = safeTraceId(raw.trace_id);
    if (!traceId || raw.execution_mode !== "fast" || !isSampled(traceId)) return null;
    const allowedMetrics = [
      "send_intent_to_stream_call_ms",
      "send_intent_to_fetch_ms",
      "fetch_to_headers_ms",
      "headers_to_first_token_ms",
      "send_to_first_token_ms",
      "first_token_to_paint_ms",
      "send_to_first_paint_ms",
      "stream_total_ms",
      "rtt_ms",
    ];
    const metrics = {};
    for (const key of allowedMetrics) {
      const value = Number(raw[key]);
      if (Number.isFinite(value) && value >= 0 && value <= 10 * 60_000) metrics[key] = roundMs(value);
    }
    return compactObject({
      trace_id: traceId,
      report_type: typeof raw.report_type === "string" ? raw.report_type.slice(0, 32) : "unknown",
      outcome: typeof raw.outcome === "string" ? raw.outcome.slice(0, 32) : undefined,
      intent_source: typeof raw.intent_source === "string" ? raw.intent_source.slice(0, 32) : undefined,
      intent_inferred: raw.intent_inferred === true,
      paint_observed: typeof raw.paint_observed === "boolean" ? raw.paint_observed : undefined,
      visibility_state: ["visible", "hidden", "prerender"].includes(raw.visibility_state)
        ? raw.visibility_state
        : undefined,
      effective_type: typeof raw.effective_type === "string" ? raw.effective_type.slice(0, 16) : undefined,
      save_data: typeof raw.save_data === "boolean" ? raw.save_data : undefined,
      ...metrics,
    });
  }

  function handleClientTelemetry(req, res) {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.end();
      return;
    }
    if (req.method !== "POST" || !allowClientReport(req)) {
      res.statusCode = req.method === "POST" ? 429 : 405;
      res.end();
      return;
    }

    let body = "";
    let rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (rejected) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_CLIENT_REPORT_BYTES) {
        rejected = true;
        res.statusCode = 413;
        res.end();
      }
    });
    req.on("end", () => {
      if (rejected || res.writableEnded) return;
      try {
        const report = sanitizeClientReport(JSON.parse(body));
        if (report) {
          console.info(JSON.stringify({
            schema_version: SCHEMA_VERSION,
            scope: "fast_latency",
            layer: "client",
            phase: "client_report",
            execution_mode: "fast",
            epoch_ms: Date.now(),
            ...report,
          }));
        }
        res.statusCode = 204;
        res.end();
      } catch {
        res.statusCode = 400;
        res.end();
      }
    });
    req.on("error", () => {
      if (!res.writableEnded) {
        res.statusCode = 400;
        res.end();
      }
    });
  }

  function inspectSseWrite(context, chunk, encoding) {
    if (context.firstSseTokenWritten) return;
    let text = "";
    try {
      text = Buffer.isBuffer(chunk)
        ? chunk.toString(typeof encoding === "string" ? encoding : "utf8")
        : String(chunk ?? "");
    } catch {
      return;
    }
    context.sseProbe = (context.sseProbe + text).slice(-32_768);
    if (/"type"\s*:\s*"(?:token|file_token)"/.test(context.sseProbe)) {
      context.firstSseTokenWritten = true;
      logLatency("server.first_sse_token_written", {}, context);
      context.sseProbe = "";
    }
  }

  function patchResponse(res, context) {
    let headersLogged = false;
    let terminalLogged = false;
    const originalWriteHead = res.writeHead;
    const originalFlushHeaders = res.flushHeaders;
    const originalWrite = res.write;
    const originalEnd = res.end;

    const markHeaders = () => {
      if (headersLogged) return;
      headersLogged = true;
      logLatency("server.response_headers_sent", { status_code: res.statusCode }, context);
    };

    res.writeHead = function patchedWriteHead(...args) {
      markHeaders();
      return originalWriteHead.apply(this, args);
    };
    if (typeof originalFlushHeaders === "function") {
      res.flushHeaders = function patchedFlushHeaders(...args) {
        markHeaders();
        return originalFlushHeaders.apply(this, args);
      };
    }
    res.write = function patchedWrite(chunk, encoding, callback) {
      markHeaders();
      inspectSseWrite(context, chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    res.end = function patchedEnd(chunk, encoding, callback) {
      if (chunk !== undefined && chunk !== null) inspectSseWrite(context, chunk, encoding);
      return originalEnd.call(this, chunk, encoding, callback);
    };

    const markTerminal = (outcome) => {
      if (terminalLogged) return;
      terminalLogged = true;
      logLatency("server.request_completed", {
        outcome,
        status_code: res.statusCode,
        first_token_written: context.firstSseTokenWritten,
      }, context);
    };
    res.once("finish", () => markTerminal("finish"));
    res.once("close", () => markTerminal(res.writableEnded ? "close_after_end" : "client_disconnect"));
  }

  http.Server.prototype.emit = function patchedServerEmit(event, ...args) {
    if (event !== "request") return originalServerEmit.call(this, event, ...args);
    const [req, res] = args;
    const url = parseIncomingUrl(req);
    if (url?.pathname === TELEMETRY_PATH) {
      handleClientTelemetry(req, res);
      return true;
    }
    if (url?.pathname !== "/api/chat/stream" || req.method !== "POST") {
      return originalServerEmit.call(this, event, ...args);
    }

    const traceId = safeTraceId(url.searchParams.get(TRACE_QUERY_PARAM));
    if (!traceId || !isSampled(traceId)) {
      return originalServerEmit.call(this, event, ...args);
    }

    const context = {
      traceId,
      startedNs: nowNs(),
      firstSseTokenWritten: false,
      sseProbe: "",
    };
    patchResponse(res, context);
    logLatency("server.request_received", {
      endpoint: url.pathname,
      method: req.method,
    }, context);
    return requestContext.run(context, () => originalServerEmit.call(this, event, ...args));
  };

  function classifyFetch(url) {
    const rpcMatch = url.pathname.match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (rpcMatch) {
      const rpcName = rpcMatch[1];
      if (/usage|unified_text|reservation|plan/i.test(rpcName)) {
        return { kind: "billing_rpc", operation: rpcName };
      }
      return null;
    }
    if (url.pathname.includes("/auth/v1/user")) {
      return { kind: "auth_fallback", operation: "supabase_user_lookup" };
    }
    if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
      && /^\/llm\/(?:stream|invoke)$/.test(url.pathname)) {
      return { kind: "internal_gateway", operation: url.pathname.slice(1).replace("/", ".") };
    }
    return null;
  }

  function withTraceHeader(input, init, traceId) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set(TRACE_HEADER, traceId);
    if (input instanceof Request) {
      return {
        input: new Request(input, { ...init, headers }),
        init: undefined,
      };
    }
    return { input, init: { ...init, headers } };
  }

  function wrapInternalGatewayResponse(response, context, operation) {
    if (!response.body || typeof TransformStream !== "function") return response;
    let firstChunkLogged = false;
    const transformed = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          logLatency("server.internal_gateway_first_chunk_received", { operation }, context);
        }
        controller.enqueue(chunk);
      },
    }));
    return new Response(transformed, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  if (originalFetch) {
    globalThis.fetch = async function sentiqLatencyFetch(input, init) {
      const context = requestContext.getStore();
      if (!context?.traceId) return originalFetch(input, init);
      let url;
      try {
        url = new URL(input instanceof Request ? input.url : String(input));
      } catch {
        return originalFetch(input, init);
      }
      const classified = classifyFetch(url);
      if (!classified) return originalFetch(input, init);

      const startedNs = nowNs();
      logLatency(`server.${classified.kind}_started`, { operation: classified.operation }, context);
      let next = { input, init };
      if (classified.kind === "internal_gateway") {
        next = withTraceHeader(input, init, context.traceId);
      }

      try {
        const response = await originalFetch(next.input, next.init);
        logLatency(`server.${classified.kind}_completed`, {
          operation: classified.operation,
          status_code: response.status,
          duration_ms: roundMs(elapsedMs(startedNs)),
        }, context);
        return classified.kind === "internal_gateway"
          ? wrapInternalGatewayResponse(response, context, classified.operation)
          : response;
      } catch (error) {
        logLatency(`server.${classified.kind}_failed`, {
          operation: classified.operation,
          duration_ms: roundMs(elapsedMs(startedNs)),
          error_name: error instanceof Error ? error.name : "unknown",
        }, context);
        throw error;
      }
    };
  }

  console.info(JSON.stringify({
    schema_version: SCHEMA_VERSION,
    scope: "fast_latency",
    layer: "node",
    phase: "observability_installed",
    sample_rate: SAMPLE_RATE,
    epoch_ms: Date.now(),
  }));
}
