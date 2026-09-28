import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

const candidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];
const envPath = candidates.find((c) => existsSync(c));
if (envPath) dotenv.config({ path: envPath });
else dotenv.config();

for (let i = 1; i <= 4; i += 1) {
  process.env[`SUPABASE_URL_${i}`] = process.env[`SUPABASE_URL_${i}`] || `https://mock-shard-${i}.supabase.co`;
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${i}`] = process.env[`SUPABASE_SERVICE_ROLE_KEY_${i}`] || `mock-service-key-${i}`;
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import http2 from "node:http2";
import express, { type Response } from "express";
import { EventEmitter } from "node:events";
import { chatGenerationTaskCoordinator } from "./services/chatGenerationTaskCoordinator";
import { openGenerationSubscription } from "./chatGenerationTransportBootstrap";

const root = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

// Mock Express Response for unit testing header emission and SSE frames
class MockSseResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  private readonly headers = new Map<string, string>();
  public frames: string[] = [];

  status(code: number) {
    this.statusCode = code;
    return this as unknown as Response;
  }

  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return this as unknown as Response;
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  getHeaders(): Record<string, string> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.headers.entries()) obj[k] = v;
    return obj;
  }

  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(chunk: unknown): boolean {
    if (this.writableEnded) return false;
    this.headersSent = true;
    this.frames.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
    return true;
  }

  end(chunk?: unknown) {
    if (this.writableEnded) return this as unknown as Response;
    if (chunk !== undefined) {
      this.frames.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? ""));
    }
    this.writableEnded = true;
    this.emit("finish");
    this.emit("close");
    return this as unknown as Response;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Static source audit: Verify NO browser-facing SSE route emits HTTP/2 forbidden headers
// ─────────────────────────────────────────────────────────────────────────────
function testStaticSseHeadersContracts() {
  const serverLegacy = read("backend/serverLegacy.ts");
  const transportBootstrap = read("backend/chatGenerationTransportBootstrap.ts");

  const forbiddenHeaders = ["Connection", "Keep-Alive", "Transfer-Encoding", "Upgrade"];

  // 1a. Verify chatGenerationTransportBootstrap has NO forbidden headers
  for (const header of forbiddenHeaders) {
    const pattern = new RegExp(`setHeader\\(["']${header}["']`, "i");
    assert.ok(
      !pattern.test(transportBootstrap),
      `chatGenerationTransportBootstrap.ts must NOT set forbidden HTTP/2 header: ${header}`,
    );
  }

  // 1b. Verify serverLegacy has NO forbidden headers on any SSE routes
  // Specifically check ensureSseStarted, guest streaming, fast streaming, reasoning, general chat, files/updates, deep research
  for (const header of forbiddenHeaders) {
    const pattern = new RegExp(`res\\.setHeader\\(["']${header}["']`, "i");
    assert.ok(
      !pattern.test(serverLegacy),
      `serverLegacy.ts must NOT set forbidden HTTP/2 header: ${header}`,
    );
  }

  // 1c. Verify protocol-safe SSE headers are preserved in transportBootstrap
  assert.ok(
    transportBootstrap.includes('setHeader("Content-Type", "text/event-stream; charset=utf-8")'),
    "transportBootstrap must preserve Content-Type: text/event-stream",
  );
  assert.ok(
    transportBootstrap.includes('setHeader("Cache-Control", "no-cache, no-transform")'),
    "transportBootstrap must preserve Cache-Control: no-cache, no-transform",
  );
  assert.ok(
    transportBootstrap.includes('setHeader("X-Accel-Buffering", "no")'),
    "transportBootstrap must preserve X-Accel-Buffering: no",
  );
  assert.ok(
    transportBootstrap.includes("response.flushHeaders?.()"),
    "transportBootstrap must preserve flushHeaders()",
  );
  assert.ok(
    transportBootstrap.includes('": keepalive\\n\\n"'),
    "transportBootstrap must preserve SSE heartbeat comment (: keepalive\\n\\n)",
  );

  // 1d. Verify /api/files/updates route preserved protocol-safe SSE headers in serverLegacy
  const filesUpdatesIndex = serverLegacy.indexOf('"/api/files/updates"');
  assert.ok(filesUpdatesIndex > 0, "serverLegacy must have /api/files/updates route");
  const filesUpdatesSlice = serverLegacy.slice(filesUpdatesIndex, filesUpdatesIndex + 600);
  assert.ok(
    filesUpdatesSlice.includes('res.setHeader("Content-Type", "text/event-stream")'),
    "/api/files/updates must preserve Content-Type: text/event-stream",
  );
  assert.ok(
    filesUpdatesSlice.includes('res.setHeader("Cache-Control", "no-cache")'),
    "/api/files/updates must preserve Cache-Control: no-cache",
  );
  assert.ok(
    filesUpdatesSlice.includes('res.setHeader("X-Accel-Buffering", "no")'),
    "/api/files/updates must preserve X-Accel-Buffering: no",
  );
  assert.ok(
    !filesUpdatesSlice.includes('res.setHeader("Connection"'),
    "/api/files/updates must NOT set Connection header",
  );

  // 1e. Verify openDeepResearchEventStream preserves safe headers without Connection
  const deepResearchIndex = serverLegacy.indexOf("async function openDeepResearchEventStream");
  assert.ok(deepResearchIndex > 0, "serverLegacy must have openDeepResearchEventStream");
  const deepResearchSlice = serverLegacy.slice(deepResearchIndex, deepResearchIndex + 600);
  assert.ok(
    deepResearchSlice.includes('args.res.setHeader("Content-Type", "text/event-stream; charset=utf-8")'),
    "openDeepResearchEventStream must preserve Content-Type",
  );
  assert.ok(
    deepResearchSlice.includes('args.res.setHeader("Cache-Control", "no-cache, no-transform")'),
    "openDeepResearchEventStream must preserve Cache-Control",
  );
  assert.ok(
    !deepResearchSlice.includes('args.res.setHeader("Connection"'),
    "openDeepResearchEventStream must NOT set Connection header",
  );

  console.log("PASS | Static code contracts for SSE headers verified.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Unit test: openGenerationSubscription header correctness & event lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function testGenerationSubscriptionUnitLifecycle() {
  const generationId = "gen-unit-test-" + Date.now();
  const context = {
    generationId,
    userId: "test-user-1",
    conversationId: "conv-1",
    generation: {
      id: generationId,
      status: "running",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      conversation_id: "conv-1",
      client_request_id: "client-req-1",
    },
    userDb: null,
  };

  chatGenerationTaskCoordinator.start({
    generationId,
    userId: context.userId,
    conversationId: context.conversationId,
    generation: context.generation as any,
  });

  const mockRes = new MockSseResponse();
  openGenerationSubscription(mockRes as unknown as Response, generationId, context, 0);

  // Verify headers
  const headers = mockRes.getHeaders();
  assert.equal(headers["connection"], undefined, "Connection header must NOT be emitted");
  assert.equal(headers["keep-alive"], undefined, "Keep-Alive header must NOT be emitted");
  assert.equal(headers["transfer-encoding"], undefined, "Transfer-Encoding header must NOT be emitted");
  assert.equal(headers["upgrade"], undefined, "Upgrade header must NOT be emitted");
  assert.equal(headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(headers["cache-control"], "no-cache, no-transform");
  assert.equal(headers["x-accel-buffering"], "no");
  assert.equal(mockRes.headersSent, true, "headersSent must be true after flushHeaders");

  // Allow async snapshot emission
  await new Promise((r) => setTimeout(r, 50));

  // Verify snapshot was received
  assert.ok(mockRes.frames.length >= 1, "Snapshot frame should be written");
  const snapshotFrame = JSON.parse(mockRes.frames[0].replace(/^data:\s*/, "").trim());
  assert.equal(snapshotFrame.type, "generation_snapshot");
  assert.equal(snapshotFrame.generation_id, generationId);

  // Publish tokens
  await chatGenerationTaskCoordinator.publish(generationId, { type: "token", text: "what is gritty?" });
  await new Promise((r) => setTimeout(r, 20));

  const tokenFrame = mockRes.frames.find((f) => f.includes('"type":"token"') && f.includes("what is gritty?"));
  assert.ok(tokenFrame, "Token event must be received by openGenerationSubscription");

  // Publish completion
  await chatGenerationTaskCoordinator.complete(generationId);
  await new Promise((r) => setTimeout(r, 20));

  // Verify generation_completed and [DONE] were received
  const completedFrame = mockRes.frames.find((f) => f.includes('"type":"generation_completed"'));
  assert.ok(completedFrame, "generation_completed event must be delivered");

  const doneFrame = mockRes.frames.find((f) => f.includes("data: [DONE]"));
  assert.ok(doneFrame, "data: [DONE] must be delivered at completion");

  assert.equal(mockRes.writableEnded, true, "Response must close cleanly on terminal generation_completed");
  console.log("PASS | Unit lifecycle for openGenerationSubscription with token delivery passed.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Unit test: structured_response delivery & clean completion
// ─────────────────────────────────────────────────────────────────────────────
async function testStructuredResponseUnitLifecycle() {
  const generationId = "gen-structured-test-" + Date.now();
  const context = {
    generationId,
    userId: "test-user-2",
    conversationId: "conv-2",
    generation: {
      id: generationId,
      status: "running",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      conversation_id: "conv-2",
      client_request_id: "client-req-2",
    },
    userDb: null,
  };

  chatGenerationTaskCoordinator.start({
    generationId,
    userId: context.userId,
    conversationId: context.conversationId,
    generation: context.generation as any,
  });

  const mockRes = new MockSseResponse();
  openGenerationSubscription(mockRes as unknown as Response, generationId, context, 0);

  // Publish structured_response
  await chatGenerationTaskCoordinator.publish(generationId, {
    type: "structured_response",
    response: { message: "Structured answer", answer: "Gritty is the Philadelphia Flyers mascot." },
  });
  await new Promise((r) => setTimeout(r, 20));

  const structuredFrame = mockRes.frames.find((f) => f.includes('"type":"structured_response"'));
  assert.ok(structuredFrame, "structured_response frame must be emitted to subscriber");
  assert.ok(structuredFrame.includes("Philadelphia Flyers mascot"));

  // Complete generation
  await chatGenerationTaskCoordinator.complete(generationId);
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(mockRes.frames.some((f) => f.includes("data: [DONE]")), "[DONE] must be received");
  assert.equal(mockRes.writableEnded, true, "Response must end cleanly after structured response completion");

  console.log("PASS | Unit lifecycle for structured_response delivery passed.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Live HTTP server test: Real HTTP endpoint transport & header verification
// ─────────────────────────────────────────────────────────────────────────────
async function testLiveHttpSseTransport() {
  const app = express();
  const generationId = "gen-live-test-" + Date.now();

  const context = {
    generationId,
    userId: "test-user-3",
    conversationId: "conv-3",
    generation: {
      id: generationId,
      status: "running",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      conversation_id: "conv-3",
      client_request_id: "client-req-3",
    },
    userDb: null,
  };

  chatGenerationTaskCoordinator.start({
    generationId,
    userId: context.userId,
    conversationId: context.conversationId,
    generation: context.generation as any,
  });

  let capturedHeaders: Record<string, any> = {};
  app.get("/api/chat/generations/:generationId/events", (req, res) => {
    openGenerationSubscription(res, generationId, context, 0);
    capturedHeaders = res.getHeaders();
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;

  try {
    const chunks: string[] = [];
    let responseHeaders: http.IncomingHttpHeaders = {};

    const requestPromise = new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/chat/generations/${generationId}/events`, (res) => {
        responseHeaders = res.headers;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 200, headers: res.headers });
        });
        res.on("error", reject);
      });
      req.on("error", reject);
    });

    // Wait briefly for connection open
    await new Promise((r) => setTimeout(r, 100));

    // Verify response headers set by Express
    assert.equal(capturedHeaders["connection"], undefined, "Express must not set Connection header");
    assert.equal(capturedHeaders["keep-alive"], undefined, "Express must not set Keep-Alive header");
    assert.equal(capturedHeaders["transfer-encoding"], undefined, "Express must not set Transfer-Encoding header");
    assert.equal(capturedHeaders["upgrade"], undefined, "Express must not set Upgrade header");
    assert.equal(capturedHeaders["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(capturedHeaders["cache-control"], "no-cache, no-transform");
    assert.equal(capturedHeaders["x-accel-buffering"], "no");

    // Verify wire headers
    assert.equal(responseHeaders["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(responseHeaders["cache-control"], "no-cache, no-transform");
    assert.equal(responseHeaders["x-accel-buffering"], "no");
    assert.equal(responseHeaders["upgrade"], undefined, "Upgrade must not be set");

    // Publish events over live stream
    await chatGenerationTaskCoordinator.publish(generationId, { type: "token", text: "Fast answer chunk" });
    await new Promise((r) => setTimeout(r, 50));

    await chatGenerationTaskCoordinator.complete(generationId);
    await requestPromise;

    const fullPayload = chunks.join("");
    assert.ok(fullPayload.includes("generation_snapshot"), "Live stream must receive snapshot");
    assert.ok(fullPayload.includes("Fast answer chunk"), "Live stream must receive tokens");
    assert.ok(fullPayload.includes("generation_completed"), "Live stream must receive generation_completed");
    assert.ok(fullPayload.includes("data: [DONE]"), "Live stream must receive [DONE]");

    console.log("PASS | Live HTTP SSE transport verified end-to-end.");
  } finally {
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Native HTTP/2 test: Verify HTTP/2 rejects Connection header and succeeds with safe headers
// ─────────────────────────────────────────────────────────────────────────────
async function testHttp2SpecRejectionOfConnectionHeader() {
  const server = http2.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  let streamErrorOccurred = false;
  server.on("stream", (stream: any) => {
    try {
      // In HTTP/2, RFC 7540 strictly forbids Connection header; Node.js throws ERR_HTTP2_INVALID_CONNECTION_HEADERS
      stream.respond({
        ":status": 200,
        "content-type": "text/event-stream",
        "connection": "keep-alive",
      });
    } catch (err: any) {
      if (err.code === "ERR_HTTP2_INVALID_CONNECTION_HEADERS") {
        streamErrorOccurred = true;
      }
      stream.close();
    }
  });

  const client = http2.connect(`http://127.0.0.1:${port}`);
  const req = client.request({ ":path": "/api/chat/generations/test/events" });
  await new Promise<void>((resolve) => {
    req.on("error", () => resolve());
    req.on("close", () => resolve());
    setTimeout(resolve, 300);
  });

  client.close();
  server.close();
  assert.equal(streamErrorOccurred, true, "HTTP/2 specification strictly forbids Connection header (throws ERR_HTTP2_INVALID_CONNECTION_HEADERS)");
  console.log("PASS | Verified HTTP/2 protocol engine rejects Connection header as invalid protocol.");
}

async function testNativeHttp2SafeHeaders() {
  const server = http2.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  server.on("stream", (stream: any) => {
    // With safe headers (no Connection header):
    stream.respond({
      ":status": 200,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    stream.write("data: " + JSON.stringify({ type: "token", text: "hello http2" }) + "\n\n");
    stream.write("data: [DONE]\n\n");
    stream.end();
  });

  const client = http2.connect(`http://127.0.0.1:${port}`);
  const req = client.request({ ":path": "/api/chat/generations/test/events" });
  let receivedData = "";
  let receivedHeaders: http2.IncomingHttpHeaders = {};

  await new Promise<void>((resolve, reject) => {
    req.on("response", (headers) => {
      receivedHeaders = headers;
    });
    req.on("data", (chunk) => {
      receivedData += chunk;
    });
    req.on("end", resolve);
    req.on("error", reject);
  });

  client.close();
  server.close();

  assert.equal(receivedHeaders[":status"], 200);
  assert.equal(receivedHeaders["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(receivedHeaders["connection"], undefined);
  assert.ok(receivedData.includes("hello http2"));
  assert.ok(receivedData.includes("[DONE]"));
  console.log("PASS | Verified clean HTTP/2 SSE streaming over native HTTP/2 protocol.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. End-to-end fast chat without Stop: Full lifecycle from generation to browser display
// ─────────────────────────────────────────────────────────────────────────────
async function testEndToEndFastChatWithoutStop() {
  const generationId = "gen-e2e-fast-" + Date.now();
  const context = {
    generationId,
    userId: "test-user-e2e",
    conversationId: "conv-e2e",
    generation: {
      id: generationId,
      status: "queued",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      conversation_id: "conv-e2e",
      client_request_id: "client-req-e2e",
      execution_mode: "fast",
    },
    userDb: null,
  };

  chatGenerationTaskCoordinator.start({
    generationId,
    userId: context.userId,
    conversationId: context.conversationId,
    generation: context.generation as any,
  });

  const app = express();
  app.get("/api/chat/generations/:generationId/events", (req, res) => {
    openGenerationSubscription(res, generationId, context, 0);
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const eventsReceived: Array<Record<string, unknown> | string> = [];
    let streamClosedCleanly = false;

    const streamPromise = new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/chat/generations/${generationId}/events`, (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") {
                eventsReceived.push("[DONE]");
              } else {
                try {
                  eventsReceived.push(JSON.parse(payload));
                } catch {}
              }
            }
          }
        });
        res.on("end", () => {
          streamClosedCleanly = true;
          resolve();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
    });

    // Simulate backend generating answer for "what is gritty?"
    await new Promise((r) => setTimeout(r, 50));
    await chatGenerationTaskCoordinator.publish(generationId, { type: "route", route: "chat" });
    await chatGenerationTaskCoordinator.publish(generationId, { type: "token", text: "Gritty is the mascot of the Philadelphia Flyers." });
    await chatGenerationTaskCoordinator.complete(generationId);

    await streamPromise;

    assert.equal(streamClosedCleanly, true, "Stream must close cleanly on its own upon generation completion");
    assert.ok(eventsReceived.includes("[DONE]"), "Stream must deliver terminal [DONE]");

    const tokenEvent = eventsReceived.find(
      (e) => typeof e === "object" && e !== null && (e as any).type === "token" && (e as any).text.includes("Gritty is the mascot"),
    );
    assert.ok(tokenEvent, "Full generated answer must be delivered to subscriber");

    const completedEvent = eventsReceived.find(
      (e) => typeof e === "object" && e !== null && (e as any).type === "generation_completed",
    );
    assert.ok(completedEvent, "generation_completed event must be delivered to subscriber");

    console.log("PASS | End-to-end fast chat completes and displays answer without Stop button.");
  } finally {
    server.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. End-to-end explicit Stop cancellation: Stop still cancels actively running generation
// ─────────────────────────────────────────────────────────────────────────────
async function testEndToEndExplicitStopCancels() {
  const generationId = "gen-e2e-cancel-" + Date.now();
  const context = {
    generationId,
    userId: "test-user-cancel",
    conversationId: "conv-cancel",
    generation: {
      id: generationId,
      status: "queued",
      partial_text: "",
      tokens_generated: 0,
      last_event_sequence: 0,
      conversation_id: "conv-cancel",
      client_request_id: "client-req-cancel",
    },
    userDb: null,
  };

  chatGenerationTaskCoordinator.start({
    generationId,
    userId: context.userId,
    conversationId: context.conversationId,
    generation: context.generation as any,
  });

  const app = express();
  app.get("/api/chat/generations/:generationId/events", (req, res) => {
    openGenerationSubscription(res, generationId, context, 0);
  });
  app.post("/api/chat/generations/:generationId/cancel", async (req, res) => {
    await chatGenerationTaskCoordinator.cancelled(generationId);
    res.status(202).json({ generation_id: generationId, status: "cancelled" });
  });

  const server = http.createServer(app);
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as any).port;

  try {
    const eventsReceived: Array<Record<string, unknown> | string> = [];
    let streamClosedCleanly = false;

    const streamPromise = new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/chat/generations/${generationId}/events`, (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") {
                eventsReceived.push("[DONE]");
              } else {
                try {
                  eventsReceived.push(JSON.parse(payload));
                } catch {}
              }
            }
          }
        });
        res.on("end", () => {
          streamClosedCleanly = true;
          resolve();
        });
        res.on("error", reject);
      });
      req.on("error", reject);
    });

    // Start generation and stream partial token
    await new Promise((r) => setTimeout(r, 50));
    await chatGenerationTaskCoordinator.publish(generationId, { type: "token", text: "Starting generation..." });

    // User clicks Stop: POST cancel
    const cancelReq = http.request(
      `http://127.0.0.1:${port}/api/chat/generations/${generationId}/cancel`,
      { method: "POST" },
    );
    cancelReq.end();

    await streamPromise;

    assert.equal(streamClosedCleanly, true, "Stream must close cleanly on cancellation");
    assert.ok(eventsReceived.includes("[DONE]"), "Stream must receive [DONE] on cancellation");
    const cancelledEvent = eventsReceived.find(
      (e) => typeof e === "object" && e !== null && (e as any).type === "generation_cancelled",
    );
    assert.ok(cancelledEvent, "generation_cancelled must be delivered on explicit Stop");

    console.log("PASS | Explicit Stop still cancels genuinely running generations as expected.");
  } finally {
    server.close();
  }
}

async function main() {
  testStaticSseHeadersContracts();
  await testGenerationSubscriptionUnitLifecycle();
  await testStructuredResponseUnitLifecycle();
  await testLiveHttpSseTransport();
  await testHttp2SpecRejectionOfConnectionHeader();
  await testNativeHttp2SafeHeaders();
  await testEndToEndFastChatWithoutStop();
  await testEndToEndExplicitStopCancels();
  console.log("\nALL SSE HTTP/2 REGRESSION TESTS PASSED SUCCESSFULLY.\n");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
