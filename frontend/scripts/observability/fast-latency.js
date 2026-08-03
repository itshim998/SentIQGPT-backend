const INSTALL_FLAG = "__sentiqFastLatencyInstalled";
const TRACE_PARAM = "latency_trace_id";
const TELEMETRY_PATH = "/api/telemetry/fast-latency";
const MAX_INTENT_AGE_MS = 15_000;
const MAX_TRACE_AGE_MS = 10 * 60_000;
const SAFE_TRACE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

if (!window[INSTALL_FLAG]) {
  window[INSTALL_FLAG] = true;

  const originalFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const traces = new Map();
  let lastSendIntent = null;
  let apiWrapTimer = 0;

  function nowMs() {
    return typeof performance?.now === "function" ? performance.now() : Date.now();
  }

  function roundMs(value) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : undefined;
  }

  function safeTraceId(value) {
    const traceId = typeof value === "string" ? value.trim() : "";
    return SAFE_TRACE_PATTERN.test(traceId) ? traceId : "";
  }

  function captureSendIntent(source) {
    lastSendIntent = {
      source,
      perfMs: nowMs(),
      epochMs: Date.now(),
    };
  }

  function canCaptureSendIntent(target = null) {
    const button = target || document.getElementById?.("send-btn");
    return Boolean(
      button
      && !button.disabled
      && !button.classList?.contains("is-stop")
      && button.getAttribute?.("aria-label") !== "Stop generating"
    );
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("#send-btn") : null;
    if (target && canCaptureSendIntent(target)) captureSendIntent("send_button");
  }, true);

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter"
      && !event.shiftKey
      && !event.isComposing
      && event.target instanceof HTMLTextAreaElement
      && event.target.id === "chat-input"
      && canCaptureSendIntent()
    ) {
      captureSendIntent("enter_key");
    }
  }, true);

  function getIntentSnapshot(startPerfMs) {
    if (
      lastSendIntent
      && startPerfMs >= lastSendIntent.perfMs
      && startPerfMs - lastSendIntent.perfMs <= MAX_INTENT_AGE_MS
    ) {
      const snapshot = { ...lastSendIntent, inferred: false };
      lastSendIntent = null;
      return snapshot;
    }
    lastSendIntent = null;
    return {
      source: "stream_call",
      perfMs: startPerfMs,
      epochMs: Date.now(),
      inferred: true,
    };
  }

  function getNetworkSnapshot() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
      effective_type: typeof connection?.effectiveType === "string" ? connection.effectiveType : undefined,
      rtt_ms: Number.isFinite(connection?.rtt) ? Math.max(0, Math.round(connection.rtt)) : undefined,
      save_data: typeof connection?.saveData === "boolean" ? connection.saveData : undefined,
      visibility_state: document.visibilityState || undefined,
    };
  }

  function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => (
      item !== undefined && item !== null && item !== ""
    )));
  }

  function emitClientReport(trace, reportType, extra = {}) {
    if (!trace || !trace.traceId) return;
    const payload = compactObject({
      schema_version: 1,
      event: "fast_latency_client_report",
      report_type: reportType,
      trace_id: trace.traceId,
      execution_mode: "fast",
      intent_source: trace.intent.source,
      intent_inferred: trace.intent.inferred,
      client_epoch_ms: Date.now(),
      send_intent_to_stream_call_ms: roundMs(trace.streamCallStartedMs - trace.intent.perfMs),
      send_intent_to_fetch_ms: roundMs(trace.fetchStartedMs - trace.intent.perfMs),
      fetch_to_headers_ms: roundMs(trace.responseHeadersMs - trace.fetchStartedMs),
      headers_to_first_token_ms: roundMs(trace.firstTokenReceivedMs - trace.responseHeadersMs),
      send_to_first_token_ms: roundMs(trace.firstTokenReceivedMs - trace.intent.perfMs),
      first_token_to_paint_ms: roundMs(trace.firstTokenPaintedMs - trace.firstTokenReceivedMs),
      send_to_first_paint_ms: roundMs(trace.firstTokenPaintedMs - trace.intent.perfMs),
      stream_total_ms: roundMs(trace.completedMs - trace.streamCallStartedMs),
      ...getNetworkSnapshot(),
      ...extra,
    });

    try {
      console.info(`[FastLatency] ${JSON.stringify(payload)}`);
    } catch { /* console telemetry is best effort */ }

    const apiBase = typeof window.SENTIQ_API_BASE === "string"
      ? window.SENTIQ_API_BASE.replace(/\/+$/, "")
      : "";
    if (!apiBase) return;
    const target = `${apiBase}${TELEMETRY_PATH}`;
    const body = JSON.stringify(payload);

    try {
      if (typeof navigator.sendBeacon === "function") {
        const accepted = navigator.sendBeacon(
          target,
          new Blob([body], { type: "text/plain;charset=UTF-8" }),
        );
        if (accepted) return;
      }
    } catch { /* fall through to keepalive fetch */ }

    originalFetch?.(target, {
      method: "POST",
      body,
      mode: "no-cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    }).catch(() => undefined);
  }

  function cleanupOldTraces() {
    const cutoff = nowMs() - MAX_TRACE_AGE_MS;
    for (const [traceId, trace] of traces.entries()) {
      if ((trace.streamCallStartedMs || 0) < cutoff) traces.delete(traceId);
    }
  }

  function getOrCreateTrace(traceId, startPerfMs = nowMs()) {
    let trace = traces.get(traceId);
    if (!trace) {
      trace = {
        traceId,
        intent: getIntentSnapshot(startPerfMs),
        streamCallStartedMs: startPerfMs,
        fetchStartedMs: undefined,
        responseHeadersMs: undefined,
        firstTokenReceivedMs: undefined,
        firstTokenPaintedMs: undefined,
        completedMs: undefined,
        firstPaintReported: false,
        terminalReported: false,
      };
      traces.set(traceId, trace);
      cleanupOldTraces();
    }
    return trace;
  }

  function parseFastChatRequest(options) {
    if (!options || typeof options.body !== "string") return null;
    try {
      const body = JSON.parse(options.body);
      if (body?.execution_mode !== "fast") return null;
      const traceId = safeTraceId(body?.client_request_id);
      return traceId ? { traceId } : null;
    } catch {
      return null;
    }
  }

  if (originalFetch) {
    window.fetch = async function sentiqLatencyFetch(input, options = {}) {
      let url;
      try {
        url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      } catch {
        return originalFetch(input, options);
      }

      const requestMeta = url.pathname === "/api/chat/stream"
        ? parseFastChatRequest(options)
        : null;
      if (!requestMeta) return originalFetch(input, options);

      const trace = getOrCreateTrace(requestMeta.traceId);
      trace.fetchStartedMs = nowMs();
      url.searchParams.set(TRACE_PARAM, requestMeta.traceId);

      const nextInput = input instanceof Request
        ? new Request(url.toString(), input)
        : url.toString();
      try {
        const response = await originalFetch(nextInput, options);
        trace.responseHeadersMs = nowMs();
        return response;
      } catch (error) {
        trace.completedMs = nowMs();
        if (!trace.terminalReported) {
          trace.terminalReported = true;
          emitClientReport(trace, "terminal", {
            outcome: error?.name === "AbortError" ? "aborted" : "network_error",
          });
        }
        throw error;
      }
    };
  }

  function scheduleFirstPaint(trace) {
    if (trace.firstTokenPaintedMs || document.visibilityState !== "visible") {
      if (!trace.firstPaintReported && document.visibilityState !== "visible") {
        trace.firstPaintReported = true;
        emitClientReport(trace, "first_token", { paint_observed: false });
      }
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (trace.firstTokenPaintedMs) return;
        trace.firstTokenPaintedMs = nowMs();
        if (!trace.firstPaintReported) {
          trace.firstPaintReported = true;
          emitClientReport(trace, "first_paint", { paint_observed: true });
        }
      });
    });
  }

  function installApiWrapper() {
    const API = window.SentIQAPI;
    if (!API || typeof API.sendMessageStream !== "function") return false;
    if (API.sendMessageStream.__sentiqLatencyWrapped) return true;

    const originalSendMessageStream = API.sendMessageStream.bind(API);
    async function wrappedSendMessageStream(message, context = {}, callbacks = {}, signal = null) {
      const executionMode = context.executionMode || context.execution_mode || "fast";
      const traceId = executionMode === "fast" ? safeTraceId(context.clientRequestId) : "";
      if (!traceId) return originalSendMessageStream(message, context, callbacks, signal);

      const trace = getOrCreateTrace(traceId, nowMs());
      const wrappedCallbacks = { ...callbacks };
      const originalOnToken = callbacks.onToken;
      const originalOnFileToken = callbacks.onFileToken;
      const originalOnDone = callbacks.onDone;
      const originalOnError = callbacks.onError;

      function recordFirstToken() {
        if (trace.firstTokenReceivedMs) return;
        trace.firstTokenReceivedMs = nowMs();
        scheduleFirstPaint(trace);
      }

      wrappedCallbacks.onToken = function onToken(token) {
        recordFirstToken();
        return originalOnToken?.(token);
      };
      wrappedCallbacks.onFileToken = function onFileToken(token, eventMeta) {
        recordFirstToken();
        return originalOnFileToken?.(token, eventMeta);
      };
      wrappedCallbacks.onDone = function onDone(...args) {
        trace.completedMs = nowMs();
        if (!trace.terminalReported) {
          trace.terminalReported = true;
          emitClientReport(trace, "terminal", { outcome: "complete" });
        }
        return originalOnDone?.(...args);
      };
      wrappedCallbacks.onError = function onError(error, meta) {
        trace.completedMs = nowMs();
        if (!trace.terminalReported) {
          trace.terminalReported = true;
          emitClientReport(trace, "terminal", {
            outcome: meta?.tokensReceived ? "interrupted" : "stream_error",
          });
        }
        return originalOnError?.(error, meta);
      };

      try {
        const result = await originalSendMessageStream(message, context, wrappedCallbacks, signal);
        if (!trace.completedMs) trace.completedMs = nowMs();
        if (!trace.terminalReported) {
          trace.terminalReported = true;
          emitClientReport(trace, "terminal", {
            outcome: result?.interrupted ? "interrupted" : result?.structured ? "structured" : "complete",
          });
        }
        return result;
      } catch (error) {
        trace.completedMs = nowMs();
        if (!trace.terminalReported) {
          trace.terminalReported = true;
          emitClientReport(trace, "terminal", {
            outcome: error?.name === "AbortError" ? "aborted" : "exception",
          });
        }
        throw error;
      } finally {
        window.setTimeout(() => traces.delete(traceId), 60_000);
      }
    }

    Object.defineProperty(wrappedSendMessageStream, "__sentiqLatencyWrapped", { value: true });
    API.sendMessageStream = wrappedSendMessageStream;
    return true;
  }

  if (!installApiWrapper()) {
    apiWrapTimer = window.setInterval(() => {
      if (installApiWrapper()) {
        window.clearInterval(apiWrapTimer);
        apiWrapTimer = 0;
      }
    }, 25);
    window.setTimeout(() => {
      if (apiWrapTimer) {
        window.clearInterval(apiWrapTimer);
        apiWrapTimer = 0;
      }
    }, 15_000);
  }
}
