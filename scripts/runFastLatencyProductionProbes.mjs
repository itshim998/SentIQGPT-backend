#!/usr/bin/env node

// This diagnostic is intentionally committed with the controlled full-rollout trigger
// so the baseline and immutable production image share the exact same master SHA.
// Corrected rollout verification: prove ordinary Fast provider work overlaps input safety in production.
import { appendFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const apiBase = String(process.env.SENTIQ_BASELINE_API_BASE || "").replace(/\/+$/, "");
const outputPath = process.env.SENTIQ_BASELINE_PROBE_OUTPUT || "fast-latency-probes.jsonl";
const tracePrefix = process.env.SENTIQ_BASELINE_TRACE_PREFIX || `wave0-${Date.now()}`;
const count = Math.max(1, Math.min(30, Number(process.env.SENTIQ_BASELINE_PROBE_COUNT || 12)));
const timeoutMs = Math.max(15_000, Math.min(180_000, Number(process.env.SENTIQ_BASELINE_REQUEST_TIMEOUT_MS || 90_000)));
const pauseMs = Math.max(0, Math.min(10_000, Number(process.env.SENTIQ_BASELINE_PAUSE_MS || 1_000)));

if (!apiBase.startsWith("https://")) {
  throw new Error("SENTIQ_BASELINE_API_BASE must be an HTTPS URL.");
}

await writeFile(outputPath, "", "utf8");

function roundMs(value) {
  return Math.max(0, Math.round(value * 10) / 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSseLines(buffer, onEvent) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() || "";
  for (const line of lines) {
    const normalized = line.trimEnd();
    if (!normalized.startsWith("data:")) continue;
    const payload = normalized.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      onEvent(JSON.parse(payload));
    } catch {
      // The production client also tolerates malformed non-terminal frames.
    }
  }
  return remainder;
}

async function runProbe(index) {
  const traceId = `${tracePrefix}-${String(index + 1).padStart(2, "0")}-${randomUUID()}`;
  const anonymousId = `${tracePrefix}-anonymous`;
  const url = new URL(`${apiBase}/api/chat/stream`);
  url.searchParams.set("latency_trace_id", traceId);

  const startedPerf = performance.now();
  const startedEpochMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let headersPerf;
  let firstTokenPerf;
  let completedPerf;
  let tokenEvents = 0;
  let route = "";
  let provider = "";
  let model = "";
  let outcome = "complete";
  let statusCode = 0;
  let errorName = "";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://sentiqchat.sentiqlabs.com",
        "X-SentIQ-Anonymous-Id": anonymousId,
      },
      body: JSON.stringify({
        message: "Reply with exactly: OK",
        client_request_id: traceId,
        execution_mode: "fast",
        context: {
          recent_messages: [],
          memories: [],
          file_references: [],
          image_attachments: [],
        },
      }),
      signal: controller.signal,
    });
    headersPerf = performance.now();
    statusCode = response.status;
    if (!response.ok) {
      outcome = "http_error";
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    if (!response.body?.getReader) {
      outcome = "missing_stream";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseLines(buffer, (event) => {
        if (event?.type === "route") {
          route = String(event.route || "");
          provider = String(event.provider || provider || "");
          model = String(event.model || model || "");
        }
        if ((event?.type === "token" || event?.type === "file_token") && event.text) {
          tokenEvents += 1;
          if (firstTokenPerf === undefined) firstTokenPerf = performance.now();
        }
        if (event?.type === "error") outcome = tokenEvents ? "interrupted" : "stream_error";
      });
    }
    if (tokenEvents === 0 && outcome === "complete") outcome = "no_visible_token";
  } catch (error) {
    errorName = error instanceof Error ? error.name : "UnknownError";
    outcome = errorName === "AbortError" ? "timeout" : "network_error";
  } finally {
    clearTimeout(timeout);
    completedPerf = performance.now();
    const record = {
      schema_version: 1,
      trace_id: traceId,
      probe_index: index + 1,
      started_epoch_ms: startedEpochMs,
      status_code: statusCode,
      outcome,
      error_name: errorName || undefined,
      route: route || undefined,
      provider: provider || undefined,
      model: model || undefined,
      token_events: tokenEvents,
      request_to_headers_ms: headersPerf === undefined ? undefined : roundMs(headersPerf - startedPerf),
      headers_to_first_token_ms:
        headersPerf === undefined || firstTokenPerf === undefined
          ? undefined
          : roundMs(firstTokenPerf - headersPerf),
      request_to_first_token_ms:
        firstTokenPerf === undefined ? undefined : roundMs(firstTokenPerf - startedPerf),
      request_total_ms: roundMs(completedPerf - startedPerf),
    };
    await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
    console.log(JSON.stringify({ event: "fast_latency_probe", ...record }));
  }
}

for (let index = 0; index < count; index += 1) {
  await runProbe(index);
  if (index + 1 < count && pauseMs) await sleep(pauseMs);
}
