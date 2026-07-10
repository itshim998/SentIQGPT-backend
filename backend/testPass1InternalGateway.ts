import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  getInternalGatewayHeaders,
  isInternalGatewayHealthy,
  validateInternalGatewayConfiguration,
  waitForInternalGatewayReady,
} from "./internalGateway";

const root = path.resolve(__dirname, "..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

function sourceBlock(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert(start >= 0, `${startNeedle} should exist`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${endNeedle} should follow ${startNeedle}`);
  return source.slice(start, end);
}

function collectFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (typeof value === "undefined") delete process.env[name];
  else process.env[name] = value;
}

async function verifyNodeBridge(): Promise<void> {
  const originalUrl = process.env.LLM_SERVICE_URL;
  const originalToken = process.env.SENTIQ_INTERNAL_SERVICE_TOKEN;
  const captured: Array<{ path: string; token?: string }> = [];

  const server = http.createServer((req, res) => {
    captured.push({
      path: req.url || "",
      token: typeof req.headers["x-sentiq-internal-token"] === "string"
        ? req.headers["x-sentiq-internal-token"]
        : undefined,
    });
    if (req.url === "/llm/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/llm/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `event: capacity\ndata: ${JSON.stringify({ capacity: {
          limit_tokens: 10_000,
          remaining_tokens: 9_000,
          reset_after_ms: 10_000,
        } })}\n\n` +
        `data: ${JSON.stringify({ text: "stream-ok" })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: "invoke-ok" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    process.env.LLM_SERVICE_URL = `http://127.0.0.1:${port}`;
    process.env.SENTIQ_INTERNAL_SERVICE_TOKEN = "pass1-test-token";

    const { callLLMAdapterDetailed, callLLMAdapterStream } = await import("./ai/PromptBuilders");
    const invoke = await callLLMAdapterDetailed({ task: "general", prompt: "hello", user_id: "guest" });
    assert.equal(invoke.text, "invoke-ok", "Node invoke bridge still returns gateway results");

    const stream = await callLLMAdapterStream({ task: "general", prompt: "hello", user_id: "guest" });
    const reader = stream.getReader();
    let streamed = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamed += value;
    }
    assert.equal(streamed, "stream-ok", "internal capacity telemetry does not alter public stream chunks");
    assert.deepEqual(captured.map((request) => request.path), ["/llm/health", "/llm/invoke", "/llm/stream"]);
    assert.equal(captured[0].token, undefined, "minimal health probe does not send credentials");
    assert(captured.slice(1).every((request) => request.token === "pass1-test-token"), "Node bridge forwards internal token");
    console.log("PASS | Node invoke and stream bridge forward internal token");
  } finally {
    restoreEnv("LLM_SERVICE_URL", originalUrl);
    restoreEnv("SENTIQ_INTERNAL_SERVICE_TOKEN", originalToken);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function verifyGatewayReadinessWait(): Promise<void> {
  const originalUrl = process.env.LLM_SERVICE_URL;
  let healthAttempts = 0;
  let healthy = false;
  const server = http.createServer((req, res) => {
    if (req.url !== "/llm/health") {
      res.writeHead(404).end();
      return;
    }
    healthAttempts += 1;
    if (healthAttempts >= 3) healthy = true;
    res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: healthy ? "ok" : "warming" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    process.env.LLM_SERVICE_URL = `http://127.0.0.1:${port}`;
    await waitForInternalGatewayReady();
    assert.equal(healthAttempts, 3, "bounded readiness wait retries until Python becomes healthy");
    healthy = false;
    healthAttempts = 0;
    assert.equal(await isInternalGatewayHealthy(), false, "live readiness does not trust the startup latch");
    console.log("PASS | delayed gateway readiness is bounded and live health remains current");
  } finally {
    restoreEnv("LLM_SERVICE_URL", originalUrl);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function verifyGatewayReadinessTimeout(): Promise<void> {
  const originalUrl = process.env.LLM_SERVICE_URL;
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "warming", internal: "must-not-escape" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    process.env.LLM_SERVICE_URL = `http://127.0.0.1:${port}`;
    await assert.rejects(waitForInternalGatewayReady, (error: unknown) => {
      const candidate = error as { statusCode?: number; code?: string; headers?: Record<string, string>; message?: string };
      assert.equal(candidate.statusCode, 503);
      assert.equal(candidate.code, "backend_unavailable");
      assert.equal(candidate.headers?.["Retry-After"], "2");
      assert.doesNotMatch(candidate.message || "", /127\.0\.0\.1|internal|llm/i);
      return true;
    });
    console.log("PASS | gateway readiness timeout returns a sanitized retryable 503");
  } finally {
    restoreEnv("LLM_SERVICE_URL", originalUrl);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function main(): Promise<void> {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUrl = process.env.LLM_SERVICE_URL;
  const originalToken = process.env.SENTIQ_INTERNAL_SERVICE_TOKEN;
  const originalUnsafe = process.env.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS;

  try {
    process.env.NODE_ENV = "production";
    delete process.env.SENTIQ_INTERNAL_SERVICE_TOKEN;
    assert.throws(validateInternalGatewayConfiguration, /SENTIQ_INTERNAL_SERVICE_TOKEN/);

    process.env.SENTIQ_INTERNAL_SERVICE_TOKEN = "pass1-test-token";
    process.env.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS = "true";
    assert.throws(validateInternalGatewayConfiguration, /SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS/);

    process.env.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS = "false";
    process.env.LLM_SERVICE_URL = "http://example.com:3002";
    assert.throws(validateInternalGatewayConfiguration, /loopback HTTP URL/);

    process.env.LLM_SERVICE_URL = "http://127.0.0.1:3002";
    assert.doesNotThrow(validateInternalGatewayConfiguration);
    assert.equal(getInternalGatewayHeaders()["X-SentIQ-Internal-Token"], "pass1-test-token");
    console.log("PASS | Node production gateway preflight fails closed");
  } finally {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("LLM_SERVICE_URL", originalUrl);
    restoreEnv("SENTIQ_INTERNAL_SERVICE_TOKEN", originalToken);
    restoreEnv("SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS", originalUnsafe);
  }

  await verifyGatewayReadinessWait();
  await verifyGatewayReadinessTimeout();
  await verifyNodeBridge();

  const callerFiles = [
    "backend/ai/PromptBuilders.ts",
    "backend/ai/FileIngestionHandler.ts",
    "backend/memory/memoryEmbedding.ts",
    "backend/tools/chartGeneration/chartRouter.ts",
  ];
  for (const relativePath of callerFiles) {
    const source = read(relativePath);
    assert.match(source, /getInternalGatewayUrl/, `${relativePath} must use shared internal URL helper`);
    assert.match(source, /getInternalGatewayHeaders/, `${relativePath} must use shared token header helper`);
    assert.match(source, /waitForInternalGatewayReady/, `${relativePath} must use shared bounded readiness wait`);
  }
  assert.match(
    read("backend/tools/webSearch/tavilySearchPipeline.ts"),
    /callLLMAdapterDetailed/,
    "web synthesis must use the canonical budgeted Node-to-Python bridge",
  );
  console.log("PASS | every Node-to-Python caller uses shared gateway helper");

  const python = read("backend/llm_service.py");
  assert.match(python, /class InternalGatewayAuthMiddleware/, "Python gateway must use default-deny ASGI middleware");
  assert.match(python, /scope\.get\("path"\) == "\/llm\/health"/, "only minimal Python liveness may bypass internal auth");
  assert.match(python, /@app\.get\("\/llm\/health\/details"\)/, "protected detailed Python health must exist");
  assert.match(python, /docs_url=None if is_production_runtime\(\) else "\/docs"/, "production Python docs must be disabled");
  assert.doesNotMatch(python, /detail=str\(e\)|\{'error': str\(e\)\}|test_response_preview/, "Python responses must not expose raw internal errors");

  const server = read("backend/server.ts");
  assert.match(
    server,
    /measureSync\("internalGateway\.validation", validateInternalGatewayConfiguration\)/,
    "Node startup must validate internal gateway configuration",
  );
  assert.match(server, /sanitizePublicPayload/, "Node public JSON and SSE responses must stay sanitized");
  const publicHealth = sourceBlock(server, 'app.get("/health"', 'app.get("/ready"');
  const publicReady = sourceBlock(server, 'app.get("/ready"', "function getExplicitWebSearchMode");
  const apiHealth = sourceBlock(server, 'app.get("/api/health"', "// ===============================\n// POST /api/chat/intent");
  const apiConfig = sourceBlock(server, 'app.get("/api/config"', "// ===============================\n// GET /api/audit");
  for (const [label, block] of [["health", publicHealth], ["ready", publicReady], ["api health", apiHealth], ["api config", apiConfig]] as const) {
    assert.doesNotMatch(
      block,
      /SENTIQ_INTERNAL|LLM_SERVICE|provider|model|architecture|keyStatus|secret/i,
      `${label} must not expose internal gateway or provider details`,
    );
  }
  const firstOrdinaryMiddleware = server.indexOf("app.use(attachRateLimitIdentity)");
  assert(server.indexOf('app.get("/health"') < firstOrdinaryMiddleware);
  assert(server.indexOf('app.get("/ready"') < firstOrdinaryMiddleware);
  assert.doesNotMatch(publicHealth + publicReady, /verifyJWT|auditMiddleware|RateLimiter|rateLimiter/);
  assert.match(publicReady, /isInternalGatewayHealthy/);
  console.log("PASS | public Node health and config source remains sanitized");
  console.log("PASS | probe routes bypass auth, audit, and ordinary API rate limiting");

  const frontendSource = [
    read("frontend/index.html"),
    ...collectFiles(path.join(root, "frontend", "scripts")).map((file) => fs.readFileSync(file, "utf8")),
  ].join("\n");
  assert.doesNotMatch(frontendSource, /LLM_SERVICE_URL|\/llm\/|\/chart\/render|:3002/, "frontend must not call Python gateway directly");
  console.log("PASS | frontend has no direct Python gateway references");

  const startup = read("scripts/start-container.sh");
  assert.match(startup, /production\.internal-service-token/);
  assert.match(startup, /production\.llm-host/);
  assert.match(startup, /production\.llm-url/);
  assert.match(startup, /PYTHON_HEALTH_INTERVAL_SECONDS=10/);
  assert.match(startup, /PYTHON_HEALTH_FAILURE_THRESHOLD=6/);
  assert.doesNotMatch(startup, /wait -n -p/, "startup supervision must not require wait -n -p");

  const workflow = read(".github/workflows/azure-container-apps.yml");
  assert.match(workflow, /properties\.configuration\.ingress\.targetPort/);
  assert.match(workflow, /SENTIQ_INTERNAL_SERVICE_TOKEN'\]\.secretRef/);
  assert.match(workflow, /Unsafe internal endpoints cannot be enabled in production/);
  console.log("PASS | container and Azure deploy gates enforce private Python gateway intent");

  console.log("\nPass 1 Node internal gateway validation passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
