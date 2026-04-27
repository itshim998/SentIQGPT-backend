function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}${detail ? ` | ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

async function main(): Promise<void> {
  process.env.TAVILY_KEYS = "test-key-1,test-key-2";

  const { resolveHardRoutedPlan } = await import("./orchestrator/planner");
  const { TavilyProvider } = await import("./tools/webSearch/providers/tavilyProvider");
  const { searchTavily } = await import("./tools/webSearch/tavilySearchPipeline");

  const forcedBasicPlan = resolveHardRoutedPlan({
    userMessage: "Tell me a joke about spring rain.",
    hasWebSearch: true,
    explicitWebSearchMode: "basic",
  });
  assert(forcedBasicPlan?.steps[0]?.tool === "web_search", "explicit WebSurf hard-routes to web_search");

  const forcedAdvancedPlan = resolveHardRoutedPlan({
    userMessage: "Summarize this company in plain English.",
    hasWebSearch: true,
    explicitWebSearchMode: "advanced",
  });
  assert(forcedAdvancedPlan?.steps[0]?.tool === "web_search", "explicit WebSurf (legacy advanced) hard-routes to web_search");

  const normalChatPlan = resolveHardRoutedPlan({
    userMessage: "Tell me a joke about spring rain.",
    hasWebSearch: true,
  });
  assert(normalChatPlan === null, "no explicit WebSurf selection preserves non-forced routing");

  const automaticSearchPlan = resolveHardRoutedPlan({
    userMessage: "latest NVIDIA announcements in 2026",
    hasWebSearch: true,
  });
  assert(automaticSearchPlan?.steps[0]?.tool === "web_search", "current-events queries still auto-route to web_search");

  const capturedBodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    capturedBodies.push(requestBody);

    const responsePayload = {
      query: String(requestBody.query || ""),
      answer: "Advanced Tavily answer",
      images: requestBody.include_images ? ["https://images.example/top.jpg"] : [],
      results: [
        {
          title: "Example source",
          url: "https://example.com/article",
          content: "Example result content from Tavily.",
          score: 0.92,
          images: requestBody.include_images ? ["https://images.example/result.jpg"] : [],
          favicon: requestBody.include_favicon ? "https://example.com/favicon.ico" : undefined,
        },
      ],
    };

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => responsePayload,
    } as Response;
  }) as typeof fetch;

  try {
    const provider = new TavilyProvider();

    const basicSearch = await provider.searchWithMetadata("climate policy", 3, "basic");
    assert(basicSearch.answer === "Advanced Tavily answer", "basic metadata search returns answer");

    const advancedSearch = await provider.searchWithMetadata("climate policy", 3, "advanced");
    assert(advancedSearch.images.length === 0, "legacy advanced metadata search behaves like basic");

    const simpleAdvancedSearch = await searchTavily("climate policy", 3, "advanced");
    assert(simpleAdvancedSearch.success === true, "simple search path accepts explicit advanced mode");

    const [basicRequest, advancedRequest, simpleAdvancedRequest] = capturedBodies;

    assert(basicRequest.include_answer === "advanced", "basic Tavily request upgrades include_answer to advanced");
    assert(basicRequest.search_depth === "advanced", "basic Tavily request keeps advanced search depth");
    assert(!("include_images" in basicRequest), "basic Tavily request does not request top images");
    assert(!("include_favicon" in basicRequest), "basic Tavily request does not request favicons");

    assert(advancedRequest.include_answer === "advanced", "advanced Tavily request keeps include_answer advanced");
    assert(advancedRequest.search_depth === "advanced", "advanced Tavily request keeps advanced search depth");
    assert(!("include_images" in advancedRequest), "legacy advanced Tavily request does not request top images");
    assert(!("include_favicon" in advancedRequest), "legacy advanced Tavily request does not request favicons");

    assert(!("include_images" in simpleAdvancedRequest), "simple search path ignores legacy advanced image mode");
    assert(!("include_favicon" in simpleAdvancedRequest), "simple search path ignores legacy advanced favicon mode");
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("\nWeb search validation passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
