import assert from "assert";
import {
  getRuleBasedClarification,
  maybeCreateClarification,
  resolveClarificationInput,
  selectClarificationModel,
} from "./orchestrator/intentClarifier";

async function main(): Promise<void> {
  assert.equal(
    getRuleBasedClarification({ userMessage: "Solve this math step by step." }),
    null,
    "clear step-by-step math should answer directly",
  );

  const htmlClarification = getRuleBasedClarification({ userMessage: "Code in HTML." });
  assert.equal(htmlClarification?.needsClarification, true, "short HTML coding request should clarify");
  assert.equal(htmlClarification?.options?.length, 2, "HTML clarification should offer two useful options");

  const portfolioClarification = getRuleBasedClarification({
    userMessage: "Code an HTML portfolio page.",
  });
  assert.equal(portfolioClarification?.needsClarification, true, "portfolio without name should clarify");
  assert.equal(portfolioClarification?.options?.length, 0, "portfolio name question should not invent MCQs");

  const newsClarification = getRuleBasedClarification({
    userMessage: "Latest news about cricket.",
    webSearch: true,
  });
  assert.equal(newsClarification?.needsClarification, true, "broad latest-news query should clarify scope");
  assert.equal(newsClarification?.options?.length, 1, "broad latest-news query should allow one default option");

  assert.equal(
    getRuleBasedClarification({ userMessage: "Generate an image of a red sports car." }),
    null,
    "image generation requests must skip clarification",
  );

  const casualDirect = await maybeCreateClarification({ userMessage: "Tell me a joke." });
  assert.equal(casualDirect, null, "short but clear casual prompts should not over-clarify");

  const imageAnalysisClarification = getRuleBasedClarification({
    userMessage: "Analyze this image.",
    hasImage: true,
  });
  assert.equal(imageAnalysisClarification?.needsClarification, true, "vague image analysis can clarify focus");

  const resolved = resolveClarificationInput("Simple portfolio page", {
    clarification_id: "c1",
    original_message: "Code in HTML.",
    answers: [],
    source: "option",
    selected_option_id: "portfolio",
  });
  assert.match(resolved.effectiveMessage, /Code in HTML\./, "effective prompt keeps original request");
  assert.match(resolved.effectiveMessage, /Simple portfolio page/, "effective prompt includes selected clarification");
  assert.equal(resolved.turn, 1, "resolved clarification turn increments");

  const maxTurnClarification = await maybeCreateClarification({
    userMessage: "Code in HTML.",
    currentTurn: 2,
    maxTurns: 2,
  });
  assert.equal(maxTurnClarification, null, "clarification stops at max turn");

  assert.equal(
    selectClarificationModel({ userMessage: "Why is this Python code failing?" }),
    "qwen-coder",
    "coding clarification uses qwen-coder",
  );
  assert.equal(
    selectClarificationModel({ userMessage: "Solve the probability puzzle." }),
    "openai-large",
    "math/reasoning clarification uses openai-large",
  );
  assert.equal(
    selectClarificationModel({ userMessage: "Latest news about cricket.", webSearch: true }),
    "gemini-search",
    "WebSurf clarification uses gemini-search",
  );

  process.env.TAVILY_KEYS = "clarification-test-key";
  const originalFetch = globalThis.fetch;
  const tavilyQueries: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("api.tavily.com")) {
      const body = JSON.parse(String(init?.body || "{}")) as { query?: string };
      const query = String(body.query || "");
      tavilyQueries.push(query);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          query,
          answer: `Mock Tavily answer for ${query}`,
          results: [{
            title: "Mock source",
            url: "https://example.com/mock-cricket-news",
            content: "Mock current cricket update.",
            score: 0.9,
          }],
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><body>Mock article content for extraction.</body></html>",
      json: async () => ({}),
    } as Response;
  }) as typeof fetch;

  try {
    const { orchestrate } = await import("./orchestrator/aiOrchestrator");
    const clearWebSurf = await orchestrate({
      userMessage: "Latest news about cricket in India.",
      context: { web_search_mode: "basic", userId: "test-user" },
      skipReflection: true,
    });
    assert.equal(clearWebSurf.route, "web_search", "clear WebSurf intent should display Tavily output");
    assert.match(clearWebSurf.reply ?? "", /Mock Tavily answer/, "clear WebSurf response keeps Tavily answer");

    tavilyQueries.length = 0;
    const unclearWebSurf = await orchestrate({
      userMessage: "Latest news about cricket.",
      context: { web_search_mode: "basic", userId: "test-user" },
      skipReflection: true,
    });
    assert.equal(unclearWebSurf.route, "clarification", "unclear WebSurf intent should return clarification");
    assert.doesNotMatch(unclearWebSurf.reply ?? "", /Mock Tavily answer/, "unclear WebSurf discards Tavily output");
    assert.ok(tavilyQueries.length > 0, "unclear WebSurf starts Tavily while clarification is classified");
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const frontend = await import("fs").then((fs) => fs.readFileSync("frontend/index.html", "utf8"));
  assert.match(frontend, /clarification_response/, "frontend sends clarification_response");
  assert.match(frontend, /clarification-option-btn/, "frontend renders MCQ option buttons");
  assert.match(frontend, /pendingClarifications/, "frontend tracks pending clarification state");
  assert.match(frontend, /clarification-cancel-btn/, "frontend renders cancel control");

  console.log("Intent clarification validation passed.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
