import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

process.env.SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED = "true";
process.env.SENTIQ_FAST_LATENCY_SAMPLE_RATE = "1";

const captured = [];
const originalInfo = console.info;
console.info = (...args) => {
  captured.push(args.map(String).join(" "));
};

const require = createRequire(import.meta.url);
require("../backend/observability/fast-latency-preload.cjs");

const traceId = "11111111-2222-4333-8444-555555555555";
let propagatedTraceHeader = "";

const internalServer = http.createServer((req, res) => {
  propagatedTraceHeader = String(req.headers["x-sentiq-latency-trace"] || "");
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ delta: "Hello" })}\n\n`);
});
await new Promise((resolve) => internalServer.listen(0, "127.0.0.1", resolve));
const internalAddress = internalServer.address();
assert(internalAddress && typeof internalAddress === "object");

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/api/chat/stream")) {
    const gateway = await fetch(`http://127.0.0.1:${internalAddress.port}/llm/stream`, {
      method: "POST",
      body: "{}",
    });
    await gateway.text();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "token", text: "Hello" })}\n\n`);
    res.end("data: [DONE]\n\n");
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

const response = await fetch(`${baseUrl}/api/chat/stream?latency_trace_id=${traceId}`, {
  method: "POST",
  body: "{}",
});
assert.equal(response.status, 200);
assert.match(await response.text(), /Hello/);
assert.equal(propagatedTraceHeader, traceId);

const clientReport = {
  schema_version: 1,
  event: "fast_latency_client_report",
  report_type: "first_paint",
  trace_id: traceId,
  execution_mode: "fast",
  send_intent_to_fetch_ms: 12.3,
  fetch_to_headers_ms: 45.6,
  send_to_first_paint_ms: 90.1,
  visibility_state: "visible",
};
const telemetryResponse = await fetch(`${baseUrl}/api/telemetry/fast-latency`, {
  method: "POST",
  headers: { "Content-Type": "text/plain;charset=UTF-8" },
  body: JSON.stringify(clientReport),
});
assert.equal(telemetryResponse.status, 204);

await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => internalServer.close(resolve));
console.info = originalInfo;

const parsed = captured
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const phases = new Set(parsed.map((item) => `${item.layer}:${item.phase}`));
assert(phases.has("node:observability_installed"));
assert(phases.has("node:server.request_received"));
assert(phases.has("node:server.internal_gateway_started"));
assert(phases.has("node:server.internal_gateway_completed"));
assert(phases.has("node:server.internal_gateway_first_chunk_received"));
assert(phases.has("node:server.response_headers_sent"));
assert(phases.has("node:server.first_sse_token_written"));
assert(phases.has("node:server.request_completed"));
assert(phases.has("client:client_report"));
assert(parsed.every((item) => !("message" in item) && !("prompt" in item) && !("response" in item)));

console.log("Fast latency Node observability test passed.");
