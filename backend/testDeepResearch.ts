import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";

const root = resolve(__dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

function ensureIsolatedEnvironment(): void {
  process.env.TAVILY_KEYS = "offline-test-key";
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] = "https://offline-test.invalid";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] = "offline-test-service-role";
  }
}

function splitIntoChunks(value: string, sizes = [1, 7, 3, 19, 2, 11]): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let index = 0;
  while (offset < value.length) {
    const size = sizes[index % sizes.length];
    chunks.push(value.slice(offset, offset + size));
    offset += size;
    index += 1;
  }
  return chunks;
}

function createSseFetch(
  chunks: string[],
  options: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(stream, {
      status: options.status ?? 200,
      headers: {
        "Content-Type": "text/event-stream",
        ...(options.headers ?? {}),
      },
    });
  }) as typeof fetch;
}

async function testOfficialTavilySseContract(): Promise<void> {
  const { TavilyDeepResearchClient } = await import("./tools/deepResearch/tavilyDeepResearchClient");
  const { TavilyKeyManager } = await import("./tools/webSearch/providers/tavilyKeyManager");

  const records = [
    {
      choices: [{ delta: { tool_calls: { type: "tool_call", tool_call: [{ name: "Planning", arguments: "Planning" }] } } }],
    },
    {
      choices: [{ delta: { tool_calls: { type: "tool_call", tool_call: [{ name: "WebSearch", queries: ["alpha query", "beta query"] }] } } }],
    },
    {
      choices: [{ delta: { tool_calls: { type: "tool_response", tool_response: [{ name: "WebSearch", sources: [{ title: "Tool source", url: "https://example.com/tool" }] }] } } }],
    },
    {
      choices: [{ delta: { tool_calls: { type: "tool_call", tool_call: [{ name: "Generating", arguments: "Generating" }] } } }],
    },
    { choices: [{ delta: { content: "Mock report content." } }] },
    { choices: [{ delta: { sources: [{ title: "Final source", url: "https://example.com/final" }] } }] },
  ];
  const payload = records.map((record) => `data: ${JSON.stringify(record)}\r\n\r\n`).join("") + "event: done\r\n\r\n";
  const events: any[] = [];
  let acceptedCount = 0;
  const client = new TavilyDeepResearchClient({
    keyManager: new TavilyKeyManager({ keys: ["offline-stream-key"], cooldownMs: 10 }),
    fetchImpl: createSseFetch(splitIntoChunks(payload)),
    connectTimeoutMs: 1_000,
  });

  await client.streamResearch(
    "offline mocked query",
    async (event) => {
      await Promise.resolve();
      events.push(event);
    },
    undefined,
    { onAccepted: () => { acceptedCount += 1; } },
  );

  assert.equal(acceptedCount, 1, "provider acceptance should be signalled exactly once");
  assert(events.some((event) => event.type === "progress" && event.step === "plan"));
  assert(events.some((event) => event.type === "progress" && event.step === "search" && event.query === "alpha query"));
  assert(events.some((event) => event.type === "progress" && event.step === "search" && event.query === "beta query"));
  assert(events.some((event) => event.type === "progress" && event.step === "synthesize"));
  assert(events.some((event) => event.type === "sources" && event.sources.some((source: any) => source.url === "https://example.com/tool")));
  assert(events.some((event) => event.type === "content" && event.text === "Mock report content."));
  assert(events.some((event) => event.type === "sources" && event.sources.some((source: any) => source.url === "https://example.com/final")));
  assert.equal(events.at(-1)?.type, "done", "event: done should terminate the provider stream");
}

async function testProviderErrorAndKeyRotation(): Promise<void> {
  const {
    TavilyDeepResearchClient,
    TavilyDeepResearchError,
  } = await import("./tools/deepResearch/tavilyDeepResearchClient");
  const { TavilyKeyManager } = await import("./tools/webSearch/providers/tavilyKeyManager");

  const errorPayload = `data: ${JSON.stringify({ object: "error", error: "provider internal detail" })}\n\n`;
  const errorEvents: any[] = [];
  let acceptedCount = 0;
  let acceptedFetchCount = 0;
  const acceptedErrorClient = new TavilyDeepResearchClient({
    keyManager: new TavilyKeyManager({ keys: ["offline-error-a", "offline-error-b"], cooldownMs: 10 }),
    fetchImpl: (async () => {
      acceptedFetchCount += 1;
      return createSseFetch(splitIntoChunks(errorPayload))("", {});
    }) as typeof fetch,
  });

  await assert.rejects(
    acceptedErrorClient.streamResearch(
      "offline mocked query",
      (event) => { errorEvents.push(event); },
      undefined,
      { onAccepted: () => { acceptedCount += 1; } },
    ),
    (error: unknown) => error instanceof TavilyDeepResearchError
      && error.code === "research_provider_error"
      && error.providerAccepted,
  );
  assert.equal(acceptedFetchCount, 1, "an accepted provider stream must never retry another key");
  assert.equal(acceptedCount, 1);
  assert.deepEqual(errorEvents, [{
    type: "error",
    error: "The research provider could not complete this request.",
    code: "research_provider_error",
  }]);

  let rotationFetchCount = 0;
  let rotationAcceptedCount = 0;
  const rotatedClient = new TavilyDeepResearchClient({
    keyManager: new TavilyKeyManager({ keys: ["offline-rotate-a", "offline-rotate-b"], cooldownMs: 10 }),
    fetchImpl: (async () => {
      rotationFetchCount += 1;
      if (rotationFetchCount === 1) {
        return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
      }
      return createSseFetch(["event: done\n\n"])("", {});
    }) as typeof fetch,
  });
  await rotatedClient.streamResearch(
    "offline mocked query",
    () => undefined,
    undefined,
    { onAccepted: () => { rotationAcceptedCount += 1; } },
  );
  assert.equal(rotationFetchCount, 2, "a pre-acceptance rate limit should rotate to the next key");
  assert.equal(rotationAcceptedCount, 1);
}

async function testKeyManagerWithoutLeakage(): Promise<void> {
  const { TavilyKeyManager } = await import("./tools/webSearch/providers/tavilyKeyManager");
  let now = 1_000;
  const firstSecret = "offline-secret-alpha";
  const secondSecret = "offline-secret-beta";
  const capturedLogs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { capturedLogs.push(args.map(String).join(" ")); };
  try {
    const manager = new TavilyKeyManager({
      keys: [firstSecret, secondSecret, firstSecret],
      now: () => now,
      cooldownMs: 100,
    });
    assert.equal(manager.getTotalCount(), 2, "duplicate keys should be removed");
    const first = manager.getNextKey();
    const second = manager.getNextKey();
    assert(first && second && first !== second, "keys should rotate round-robin");
    manager.markFailed(first, false);
    manager.markFailed(second, true, 500);
    assert.equal(manager.getNextKey(), null, "cooling keys should be skipped");
    now += 501;
    assert(manager.getNextKey(), "a key should become available after cooldown");
  } finally {
    console.log = originalLog;
  }
  const output = capturedLogs.join("\n");
  assert(!output.includes(firstSecret) && !output.includes(secondSecret));
  assert(!output.includes(firstSecret.slice(0, 8)) && !output.includes(secondSecret.slice(0, 8)));
}

async function testQuotaLifecycle(): Promise<void> {
  const { DeepResearchQuotaLifecycle } = await import("./tools/deepResearch/deepResearchQuotaLifecycle");
  const reservation = {
    requestId: "offline-reservation",
    feature: "deep_research",
    planCode: "free",
    safeModelLabel: "Deep Research",
    provider: "tavily",
    model: "pro",
    route: "deep_research",
    remaining: 6,
    limit: 7,
    resetAt: null,
  } as any;

  const beforeStartCalls: string[] = [];
  const beforeStart = new DeepResearchQuotaLifecycle({
    commit: async () => { beforeStartCalls.push("commit"); },
    release: async () => { beforeStartCalls.push("release"); },
  }, reservation);
  assert.equal(await beforeStart.settle({ outcome: "failed" }), "released");
  assert.deepEqual(beforeStartCalls, ["release"]);

  for (const outcome of ["completed", "failed", "cancelled"] as const) {
    const calls: string[] = [];
    const accepted = new DeepResearchQuotaLifecycle({
      commit: async () => { calls.push("commit"); },
      release: async () => { calls.push("release"); },
    }, reservation);
    accepted.markProviderAccepted();
    assert.equal(await accepted.settle({ outcome }), "committed");
    assert.equal(await accepted.settle({ outcome }), "already_settled");
    assert.deepEqual(calls, ["commit"], `${outcome} after acceptance must commit exactly once`);
  }

  const failedCommitCalls: string[] = [];
  const failedCommit = new DeepResearchQuotaLifecycle({
    commit: async () => { failedCommitCalls.push("commit"); throw new Error("offline commit failure"); },
    release: async () => { failedCommitCalls.push("release"); },
  }, reservation);
  failedCommit.markProviderAccepted();
  await assert.rejects(failedCommit.settle());
  assert.equal(await failedCommit.settle(), "already_settled");
  assert.deepEqual(failedCommitCalls, ["commit"], "a failed post-acceptance commit must never release quota");
}

class FakeUpdateQuery {
  readonly filters: Array<[string, unknown]> = [];
  updatePayload: Record<string, unknown> | null = null;

  update(payload: Record<string, unknown>): this {
    this.updatePayload = payload;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }
  select(): this { return this; }
  async maybeSingle() { return { data: { id: "offline-report" }, error: null }; }
}

async function testPersistenceTransitionGuards(): Promise<void> {
  const { DeepResearchService } = await import("./tools/deepResearch/deepResearchService");
  const service = new DeepResearchService();
  const queries: FakeUpdateQuery[] = [];
  const userDb = {
    from(table: string) {
      assert.equal(table, "deep_research_reports");
      const query = new FakeUpdateQuery();
      queries.push(query);
      return query;
    },
  };
  const common = { userDb, userId: "offline-user", reportId: "offline-report" };
  await service.updateReportMessageId({ ...common, messageId: "offline-message" });
  await service.completeReport({ ...common, content: "report", sources: [], searchCount: 1 });
  await service.cancelReport({ ...common, partialContent: "partial", sources: [], searchCount: 1 });
  await service.failReport(common);

  for (const query of queries) {
    assert(query.filters.some(([column, value]) => column === "user_id" && value === "offline-user"));
    assert(query.filters.some(([column, value]) => column === "status" && value === "running"));
  }
  assert(!Object.prototype.hasOwnProperty.call(queries.at(-1)?.updatePayload || {}, "request_metadata"), "failure must preserve request metadata");
}

async function testUnauthenticatedRouteContract(): Promise<void> {
  const { verifyJWT } = await import("./middleware/auth");
  const app = express();
  app.use(express.json());
  app.post(
    "/api/deep-research/stream",
    verifyJWT({ allowGuest: false }),
    (_req, res) => res.json({ ok: true }),
  );
  const server = await new Promise<ReturnType<typeof app.listen>>((resolveServer) => {
    const listening = app.listen(0, "127.0.0.1", () => resolveServer(listening));
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/deep-research/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Missing token." });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
}

async function testExportRenderers(): Promise<void> {
  const {
    parseDeepResearchMarkdown,
    renderDeepResearchDocx,
    renderDeepResearchPdf,
    sanitizeDeepResearchExportText,
  } = await import("./tools/deepResearch/deepResearchExport");
  const { default: JSZip } = await import("jszip");
  const { PDFParse } = await import("pdf-parse");
  const malformed = "parameter \u0011efficient; self\u00ADsupervised; co\u2011design; keep — and “quotes”";
  assert.equal(
    sanitizeDeepResearchExportText(malformed),
    "parameter efficient; self-supervised; co-design; keep — and “quotes”",
    "export sanitizer should remove controls, normalize soft/non-breaking hyphens, and preserve em dashes and smart quotes",
  );

  const content = [
    "# Offline Research Report",
    "",
    "## Findings",
    malformed,
    "",
    "- First finding",
    "- Second finding",
    "",
    "### Detail",
    "A comfortable body paragraph.",
    "",
    "## Works Cited",
    "[1] Example Source https://example.com/a/long/source/path",
  ].join("\n");
  const parsed = parseDeepResearchMarkdown("Original research prompt", content);
  assert.equal(parsed.title, "Offline Research Report");
  assert.equal(parsed.subtitle, "Original research prompt");
  assert(parsed.blocks.some((block) => block.type === "heading" && block.level === 2 && block.text === "Findings"));
  assert(parsed.blocks.some((block) => block.type === "heading" && block.level === 3 && block.text === "Detail"));
  assert.equal(parsed.blocks.filter((block) => block.type === "bullet").length, 2);
  assert(parsed.blocks.some((block) => block.type === "citation" && block.worksCited));

  const exportInput = {
    title: "Original research prompt",
    content,
    generatedAt: new Date("2026-06-29T00:00:00.000Z"),
  };
  const docxBuffer = await renderDeepResearchDocx(exportInput);
  const pdfBuffer = await renderDeepResearchPdf(exportInput);
  assert.equal(docxBuffer.subarray(0, 2).toString(), "PK", "DOCX should be a ZIP-based document");
  assert.equal(pdfBuffer.subarray(0, 5).toString(), "%PDF-", "PDF should have a valid signature");

  const pdfParser = new PDFParse({ data: pdfBuffer });
  const pdfText = await pdfParser.getText();
  await pdfParser.destroy();
  assert.match(pdfText.text, /Offline Research Report/);
  assert.match(pdfText.text, /Findings/);
  assert.match(pdfText.text, /First finding/);
  assert.match(pdfText.text, /Works Cited/);
  assert.match(pdfText.text, /self-supervised/);
  assert.doesNotMatch(pdfText.text, /\u0011|\u00AD/);

  const docxArchive = await JSZip.loadAsync(docxBuffer);
  const documentXml = await docxArchive.file("word/document.xml")?.async("string");
  const footerXml = await docxArchive.file("word/footer1.xml")?.async("string");
  assert(documentXml?.includes("Offline Research Report"));
  assert(documentXml?.includes("Works Cited"));
  assert.match(documentXml ?? "", /w:pStyle w:val="Heading2"/);
  assert.match(documentXml ?? "", /w:pStyle w:val="Heading3"/);
  assert(documentXml?.includes("•  First finding"));
  assert(documentXml?.includes("self-supervised"));
  assert(!documentXml?.includes("\u0011") && !documentXml?.includes("\u00AD"));
  assert(footerXml?.includes("Generated by SentIQ Chat"));
}

function testStaticContracts(): void {
  const server = read("backend/server.ts");
  const client = read("backend/tools/deepResearch/tavilyDeepResearchClient.ts");
  const reportService = read("backend/tools/deepResearch/deepResearchService.ts");
  const api = read("frontend/scripts/services/api.js");
  const controller = read("frontend/scripts/features/chat-controller.js");
  const shardMigration = read("supabase/migrations/20260628140000_add_deep_research_reports.sql");
  const controlMigration = read("supabase/migrations/20260629120000_fix_deep_research_control_scope.sql");
  const dbRouter = read("backend/dbRouter.ts");

  const streamRoute = server.indexOf('"/api/deep-research/stream"');
  const quotaRoute = server.indexOf('"/api/deep-research/quota"');
  const reportRoute = server.indexOf('"/api/deep-research/:reportId"');
  const exportRoute = server.indexOf('"/api/deep-research/:reportId/export"');
  const errorHandler = server.indexOf("// Global error handler");
  assert(streamRoute > 0 && quotaRoute > streamRoute && reportRoute > quotaRoute && exportRoute > reportRoute);
  assert(exportRoute < errorHandler, "Deep Research routes must precede the global error handler");
  assert.match(server.slice(streamRoute, quotaRoute), /verifyJWT\(\{ allowGuest: false \}\)/);
  assert.match(server, /tavilyDeepResearchClient\.streamResearch/);
  assert.doesNotMatch(server, /deepResearchService as any/);
  assert.match(server, /onAccepted: \(\) => quotaLifecycle\.markProviderAccepted\(\)/);
  assert.match(server, /report\.status !== "completed"/);
  assert.match(server, /code: "report_not_ready"/);
  assert.match(server, /renderDeepResearchDocx/);
  assert.match(server, /renderDeepResearchPdf/);
  assert.match(server, /sanitizeDeepResearchExportText/);
  assert.match(server, /Content-Type", "text\/event-stream; charset=utf-8"/);
  assert.doesNotMatch(client, /apiKey\.slice|rawText|response\.text\(\)/);
  assert.match(client, /envelope\.type === "tool_call"/);
  assert.match(client, /record\.event\.toLowerCase\(\) === "done"/);
  assert.match(reportService, /\.eq\("user_id", args\.userId\)/);
  assert.match(reportService, /\.eq\("status", "running"\)/);

  assert.match(api, /\/api\/deep-research\/stream/);
  assert.match(api, /\/api\/deep-research\/quota/);
  assert.match(api, /eventName/);
  assert.match(api, /stream_incomplete/);
  const exportClientStart = api.indexOf("async function exportDeepResearchReport");
  const exportClientEnd = api.indexOf("window.SentIQAPI", exportClientStart);
  const exportClient = api.slice(exportClientStart, exportClientEnd);
  assert.match(exportClient, /reportId/);
  assert.match(exportClient, /format/);
  assert.doesNotMatch(exportClient, /body\s*:/, "frontend export must not send report content");

  assert.match(controller, /data\.step === "plan"/);
  assert.match(controller, /hydrateTerminalReport/);
  const runningCardStart = controller.indexOf("function createDeepResearchRunningCard");
  const streamingBubbleStart = controller.indexOf("function createStreamingBubble", runningCardStart);
  const runningCard = controller.slice(runningCardStart, streamingBubbleStart);
  assert(runningCardStart > 0 && streamingBubbleStart > runningCardStart);
  assert.doesNotMatch(
    runningCard,
    /persistChatMessage\(/,
    "Deep Research terminal cards must rely on the canonical backend-persisted assistant message",
  );
  const droppedFiles = controller.slice(controller.indexOf("function queueDroppedFiles"), controller.indexOf("function handleFileSelect"));
  const selectedFiles = controller.slice(controller.indexOf("function handleFileSelect"), controller.indexOf("function createPastedImageFile"));
  assert.match(droppedFiles, /deepResearchMode = false/);
  assert.match(selectedFiles, /deepResearchMode = false/);

  assert.match(shardMigration, /Database 2, 3, 4 only/);
  assert.doesNotMatch(shardMigration, /billing_plans|quota_reservations|Database 1 only/);
  assert.match(controlMigration, /Database 1 only/);
  assert.match(controlMigration, /Refusing to remove non-empty deep_research_reports/);
  assert.match(controlMigration, /DROP TABLE IF EXISTS public\.deep_research_reports/);
  assert.match(controlMigration, /deep_research/);
  assert.match(dbRouter, /missing deep_research_reports schema objects/);
}

async function main(): Promise<void> {
  ensureIsolatedEnvironment();
  testStaticContracts();
  await testOfficialTavilySseContract();
  await testProviderErrorAndKeyRotation();
  await testKeyManagerWithoutLeakage();
  await testQuotaLifecycle();
  await testPersistenceTransitionGuards();
  await testUnauthenticatedRouteContract();
  await testExportRenderers();
  console.log("PASS | Deep Research offline validation passed.");
}

main().catch((error) => {
  console.error(`Deep Research offline validation failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
