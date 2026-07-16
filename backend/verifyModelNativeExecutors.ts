import "dotenv/config";
import assert from "node:assert/strict";

// The release live matrix permits exactly one logical Tavily retrieval. Keep
// optional multi-query search intelligence out of this child process only.
process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = "false";

type MatrixRow = {
  name: string;
  status: "PASS" | "FAIL";
  outcome?: string;
  provider?: string;
  error_class?: string;
};

function safeFailure(name: string, error: unknown): MatrixRow {
  return {
    name,
    status: "FAIL",
    error_class: error instanceof Error && /^[A-Za-z0-9_-]{1,64}$/.test(error.name)
      ? error.name
      : "Error",
  };
}

async function run(
  rows: MatrixRow[],
  name: string,
  work: () => Promise<Omit<MatrixRow, "name" | "status">>,
): Promise<void> {
  try {
    rows.push({ name, status: "PASS", ...(await work()) });
  } catch (error) {
    rows.push(safeFailure(name, error));
  }
}

async function main(): Promise<void> {
  const caseIndex = process.argv.indexOf("--case");
  const requestedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
  if (caseIndex >= 0 && !requestedCase) throw new Error("A live executor case name is required");
  const [
    { prepareWebSurfV2 },
    { TavilyProvider },
    { routeImageGeneration },
    { routeChartGeneration },
    { routeFileGeneration },
    { insertAutomaticMemoryOnce, getUserMemories },
  ] = await Promise.all([
    import("./tools/webSearch/webSurfV2"),
    import("./tools/webSearch/providers/tavilyProvider"),
    import("./tools/imageGeneration/imageRouter"),
    import("./tools/chartGeneration/chartRouter"),
    import("./tools/fileGeneration/fileGenerator"),
    import("./services/memoryService"),
  ]);

  const rows: MatrixRow[] = [];
  const knownCases = new Set([
    "web_surf_executor",
    "image_gen_executor",
    "chart_gen_executor",
    "file_gen_executor",
    "memory_update_executor",
  ]);
  if (requestedCase && !knownCases.has(requestedCase)) throw new Error("Unknown live executor case");
  const runCase = async (
    name: string,
    work: () => Promise<Omit<MatrixRow, "name" | "status">>,
  ) => {
    if (!requestedCase || requestedCase === name) await run(rows, name, work);
  };

  await runCase("web_surf_executor", async () => {
    const tavily = new TavilyProvider();
    assert.equal(tavily.isAvailable(), true, "Tavily is not configured");
    let logicalRetrievals = 0;
    const evidence = await prepareWebSurfV2(
      "latest major AMD company news",
      "auto",
      {
        search: async ({ query, maxResults, signal }) => {
          logicalRetrievals += 1;
          const results = await tavily.search(query, maxResults, "basic", signal, { includeAnswer: false });
          return { success: results.length > 0, query, results, provider_used: "Tavily Search" };
        },
        metadata: async () => ({}),
      },
    );
    assert.equal(logicalRetrievals, 1, "WebSurf must perform one logical Tavily retrieval");
    assert.ok(evidence.payload.sources.length > 0, "WebSurf returned no safe sources");
    assert.ok(evidence.routeEvidence.length > 0, "WebSurf returned no synthesis evidence");
    return { outcome: "retrieved", provider: evidence.payload.provider };
  });

  await runCase("image_gen_executor", async () => {
    const result = await routeImageGeneration({
      prompt: "A golden retriever puppy playing in clean fresh snow, natural daylight, photorealistic",
      size: "1024x1024",
      userId: "model-native-live-smoke",
      requestKey: "model-native-live-image-v1",
    });
    assert.equal(result.success, true, "Image provider did not complete the bounded attempt path");
    assert.ok(result.image_url || result.image_base64, "Image provider returned no usable asset");
    return { outcome: "generated", provider: result.provider_used };
  });

  await runCase("chart_gen_executor", async () => {
    const result = await routeChartGeneration({
      userMessage: "Create a bar chart with Alpha 35, Beta 22, and Gamma 14.",
      fetchPreview: false,
    });
    assert.equal(result.success, true);
    assert.ok(result.code.length > 80, "Chart renderer returned no executable output");
    assert.ok(result.plotly_json || result.chartjs_config || result.renderer === "matplotlib");
    return { outcome: "rendered", provider: result.renderer };
  });

  await runCase("file_gen_executor", async () => {
    let storedBytes = 0;
    let savedMetadata: Record<string, unknown> | null = null;
    const result = await routeFileGeneration(
      {
        userMessage: "Create a downloadable txt launch checklist.",
        requestedFormat: "txt",
        userId: "00000000-0000-4000-8000-000000000101",
        conversationId: "00000000-0000-4000-8000-000000000102",
        userDb: {},
        storageDb: {},
      },
      {},
      {
        callModel: async () => ({
          text: JSON.stringify({
            title: "Launch Checklist",
            format: "txt",
            text: "Confirm scope. Run validation. Review release notes. Approve the staged rollout.",
          }),
          model_used: "deterministic-live-fixture",
          finish_reason: "stop",
          truncated: false,
        }),
        uploadFile: async (_client, params) => {
          storedBytes = params.buffer.length;
          return {
            success: true,
            fileId: "model-native-live-file",
            fileUrl: "/api/generated-files/model-native-live-file/download",
            storagePath: `${params.userId}/${params.chatId}/model-native-live-file/v1/launch-checklist.txt`,
            storageBucket: "sentiq-generated-files-private",
            fileSizeBytes: params.buffer.length,
            contentSha256: "disposable-live-fixture",
            version: 1,
          };
        },
        saveMetadata: async (_client, params) => {
          savedMetadata = params as unknown as Record<string, unknown>;
        },
        storageDb: {},
      },
    );
    assert.equal(result.success, true);
    assert.ok(storedBytes > 20, "Generated file buffer is empty");
    assert.equal((savedMetadata as Record<string, unknown> | null)?.storageBucket, "sentiq-generated-files-private");
    return { outcome: "built_and_stored_disposable" };
  });

  await runCase("memory_update_executor", async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const userDb = {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        const key = String(args.p_automatic_idempotency_key);
        const existing = stored.get(key);
        const row = existing ?? {
          id: "model-native-live-memory",
          user_id: args.p_user_id,
          type: args.p_type,
          summary: args.p_summary,
          importance: args.p_importance,
          scope: args.p_scope,
          chat_id: args.p_chat_id,
          created_at: "2026-07-16T00:00:00.000Z",
        };
        stored.set(key, row);
        return { data: [{ ...row, deduplicated: Boolean(existing) }], error: null };
      },
      from: () => ({
        select: () => ({
          eq: (_field: string, userId: string) => ({
            order: async () => ({
              data: [...stored.values()].filter((row) => row.user_id === userId),
              error: null,
            }),
          }),
        }),
      }),
    };
    const input = {
      userId: "00000000-0000-4000-8000-000000000103",
      type: "preference",
      summary: "Prefers concise bullet-point reports.",
      importance: 8,
      scope: "global" as const,
      automaticIdempotencyKey: "b".repeat(64),
    };
    const first = await insertAutomaticMemoryOnce(userDb, input);
    const replay = await insertAutomaticMemoryOnce(userDb, input);
    const retrieved = await getUserMemories(userDb, input.userId);
    assert.equal(first.error, null);
    assert.equal(first.data?.deduplicated, false);
    assert.equal(replay.data?.deduplicated, true);
    assert.equal(retrieved.data.length, 1);
    assert.equal(retrieved.data[0]?.summary, input.summary);
    return { outcome: "persisted_retrieved_idempotently_disposable" };
  });

  console.log(JSON.stringify({ live_executor_matrix: rows }, null, 2));
  if (rows.some((row) => row.status === "FAIL")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ live_executor_matrix: [safeFailure("executor_harness", error)] }));
  process.exitCode = 1;
});
