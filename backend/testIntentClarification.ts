import assert from "assert";
import {
  formatClarificationText,
  getRuleBasedClarification,
  maybeCreateClarification,
  resolveClarificationInput,
  selectClarificationModel,
} from "./orchestrator/intentClarifier";
import { readFrontendSources } from "./frontendSource";

function installSupabaseEnvForDynamicImports(): void {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }
}

async function main(): Promise<void> {
  assert.equal(
    getRuleBasedClarification({ userMessage: "Solve this math step by step." }),
    null,
    "clear step-by-step math should answer directly",
  );

  const htmlClarification = getRuleBasedClarification({ userMessage: "Code in HTML." });
  assert.equal(htmlClarification?.needsClarification, true, "short HTML coding request should clarify");
  assert.equal(htmlClarification?.options?.length, 2, "HTML clarification should offer two useful options");

  const bareCodeClarification = getRuleBasedClarification({ userMessage: "Code" });
  assert.equal(bareCodeClarification?.needsClarification, true, "bare coding request should clarify");
  assert.match(bareCodeClarification?.question || "", /kind of code/i, "bare coding asks a coding-specific question");
  assert.doesNotMatch(
    (bareCodeClarification?.options || []).map((item) => item.label).join(" "),
    /Concise answer|Detailed explanation/i,
    "bare coding should not use generic answer-style MCQs",
  );

  const portfolioClarification = getRuleBasedClarification({
    userMessage: "Code an HTML portfolio page.",
  });
  assert.equal(portfolioClarification?.needsClarification, true, "portfolio without name should clarify");
  assert.equal(portfolioClarification?.options?.length, 0, "portfolio name question should not invent MCQs");
  assert.doesNotMatch(
    formatClarificationText({
      id: "portfolio-name",
      original_message: "Code an HTML portfolio page.",
      previous_answers: [],
      question: portfolioClarification?.question || "Whose name should be in the portfolio?",
      options: [],
      allow_custom_answer: true,
      custom_answer_prompt: "Or enter a custom answer in the message bar.",
      turn: 1,
      max_turns: 2,
      source: "fallback",
    }),
    /custom answer/i,
    "zero-option clarification fallback text should not include custom-answer helper",
  );

  const portfolioNameAnswered = getRuleBasedClarification({
    userMessage: "Sounak Poddar",
    originalMessage: "Create a portfolio",
    previousAnswers: ["Sounak Poddar"],
    currentTurn: 1,
  });
  assert.equal(portfolioNameAnswered, null, "direct portfolio-name answer should not trigger the same question again");

  const websiteClarification = getRuleBasedClarification({ userMessage: "design a website" });
  assert.equal(websiteClarification?.needsClarification, true, "vague website request should clarify website type");
  assert.match(
    (websiteClarification?.options || []).map((item) => item.label).join(" "),
    /portfolio|business|blog/i,
    "website clarification should offer website-specific options",
  );
  assert.doesNotMatch(
    (websiteClarification?.options || []).map((item) => item.label).join(" "),
    /Concise answer|Detailed explanation/i,
    "website clarification should not use generic answer-style MCQs",
  );

  const portfolioWebsiteFollowup = getRuleBasedClarification({
    userMessage: "Personal Portfolio",
    originalMessage: "design a website",
    previousAnswers: ["Personal Portfolio"],
    currentTurn: 1,
  });
  assert.equal(portfolioWebsiteFollowup?.needsClarification, true, "portfolio website selection should ask the missing name");
  assert.equal(portfolioWebsiteFollowup?.options?.length, 0, "portfolio follow-up should be a direct typed answer");
  assert.match(portfolioWebsiteFollowup?.question || "", /whose name/i, "portfolio follow-up should ask for the name");


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

  const impliedPresentationClarification = getRuleBasedClarification({
    userMessage: "Create a 5-slide presentation about AI.",
  });
  assert.equal(impliedPresentationClarification?.needsClarification, true, "implied presentation file intent should clarify");
  assert.match(
    (impliedPresentationClarification?.options || []).map((item) => item.label).join(" "),
    /\.pptx|Text outline/i,
    "file clarification should offer downloadable and chat-only choices",
  );
  assert.equal(
    impliedPresentationClarification?.options?.some((option) => option.id === "download_pptx"),
    true,
    "presentation clarification should expose a stable downloadable option id",
  );
  const resolvedDownloadPresentation = resolveClarificationInput("Downloadable .pptx file", {
    clarification_id: "file-pptx",
    original_message: "Create a 5-slide presentation about AI.",
    answers: [],
    source: "option",
    selected_option_id: "download_pptx",
    question: impliedPresentationClarification?.question,
    options: impliedPresentationClarification?.options,
  });
  assert.match(resolvedDownloadPresentation.effectiveMessage, /Selected option id:\ndownload_pptx/, "download option id should reach routing");
  assert.match(resolvedDownloadPresentation.effectiveMessage, /Downloadable \.pptx file/, "download option label should reach generation prompt");
  const resolvedTextOutline = resolveClarificationInput("Text outline in chat", {
    clarification_id: "file-pptx",
    original_message: "Create a 5-slide presentation about AI.",
    answers: [],
    source: "option",
    selected_option_id: "text_outline",
    question: impliedPresentationClarification?.question,
    options: impliedPresentationClarification?.options,
  });
  assert.equal(
    getRuleBasedClarification({ userMessage: "Create a .pptx presentation about AI." }),
    null,
    "exact file extensions should bypass clarification",
  );
  const impliedHtmlClarification = getRuleBasedClarification({
    userMessage: "Make an HTML document printing hello world with typing animation.",
  });
  assert.equal(impliedHtmlClarification?.needsClarification, true, "implied HTML file intent should clarify");
  assert.match(
    (impliedHtmlClarification?.options || []).map((item) => item.label).join(" "),
    /\.html|HTML code/i,
    "HTML file clarification should offer downloadable and chat-only choices",
  );
  assert.equal(
    impliedHtmlClarification?.options?.some((option) => option.id === "download_html"),
    true,
    "HTML clarification should expose a stable downloadable option id",
  );

  const casualDirect = await maybeCreateClarification({ userMessage: "Tell me a joke." });
  assert.equal(casualDirect, null, "short but clear casual prompts should not over-clarify");
  assert.equal(
    await maybeCreateClarification({ userMessage: "Summarize this PDF." }),
    null,
    "clear summary prompts should not clarify",
  );
  assert.equal(
    await maybeCreateClarification({ userMessage: "Fix this Python error." }),
    null,
    "clear coding fix prompts should not clarify",
  );

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
    question: "Which type of HTML code serves you best?",
    options: [
      { id: "hello_world", label: "Simple Hello World program", description: "Good for beginner-level understanding." },
      { id: "portfolio", label: "Simple portfolio page", description: "Good when you want a usable starter website." },
    ],
  });
  assert.match(resolved.effectiveMessage, /Code in HTML\./, "effective prompt keeps original request");
  assert.match(resolved.effectiveMessage, /Simple portfolio page/, "effective prompt includes selected clarification");
  assert.match(resolved.effectiveMessage, /Latest clarification question:/, "effective prompt includes answered question context");
  assert.equal(resolved.answeredQuestion, "Which type of HTML code serves you best?", "resolved input keeps answered question");
  assert.equal(resolved.answeredOptions.length, 2, "resolved input keeps answered options");
  assert.equal(resolved.selectedOptionId, "portfolio", "resolved input keeps selected option id");
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
    selectClarificationModel({ userMessage: "Code" }),
    "qwen-coder",
    "bare coding clarification uses qwen-coder",
  );
  assert.equal(
    selectClarificationModel({ userMessage: "design a website" }),
    "qwen-coder",
    "website/code clarification uses qwen-coder",
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
  assert.equal(
    selectClarificationModel({ userMessage: "Make an HTML document printing hello world." }),
    "minimax",
    "implied file clarification uses minimax",
  );

  const originalFetch = globalThis.fetch;
  const llmCalls: Array<{ model_override?: string; prompt?: string }> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string; prompt?: string };
    llmCalls.push(body);
    const prompt = String(body.prompt || "");
    const response = prompt.includes('PREVIOUS CLARIFICATION ANSWERS:\n["Simple portfolio page"]')
      ? {
        needs_clarification: true,
        question: "Whose name should be in the portfolio?",
        options: [],
        custom_answer_prompt: "Or enter a custom answer in the message bar.",
        reason: "missing_portfolio_name",
      }
      : {
        needs_clarification: true,
        question: "Which type of HTML code serves you best?",
        options: [
          { id: "hello_world", label: "Simple Hello World program", description: "Good for beginner-level understanding." },
          { id: "portfolio", label: "Simple portfolio page", description: "Good when you want a usable starter website." },
        ],
        custom_answer_prompt: "Or enter a custom answer in the message bar.",
        reason: "short_html_request",
      };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: { text: JSON.stringify(response), model_used: body.model_override } }),
    } as Response;
  }) as typeof fetch;

  try {
    const modelHtmlClarification = await maybeCreateClarification({ userMessage: "Code in HTML.", userId: "user-1" });
    assert.equal(modelHtmlClarification?.source, "model", "visible clarification should be model-authored when model succeeds");
    assert.equal(modelHtmlClarification?.model_used, "qwen-coder", "HTML clarification should be authored by qwen-coder");
    assert.equal(modelHtmlClarification?.previous_answers.length, 0, "first clarification has no previous answers");
    assert.equal(modelHtmlClarification?.options.length, 2, "model-authored HTML clarification keeps options");

    const portfolioFollowup = await maybeCreateClarification({
      userMessage: resolved.effectiveMessage,
      originalMessage: resolved.originalMessage,
      previousAnswers: resolved.answers,
      currentTurn: resolved.turn,
      answeredQuestion: resolved.answeredQuestion,
      answeredOptions: resolved.answeredOptions,
      selectedOptionId: resolved.selectedOptionId,
      userId: "user-1",
    });
    assert.equal(portfolioFollowup?.source, "model", "portfolio follow-up should be model-authored");
    assert.equal(portfolioFollowup?.options.length, 0, "portfolio name follow-up should have zero options");
    assert.deepEqual(portfolioFollowup?.previous_answers, ["Simple portfolio page"], "follow-up carries previous answers");
    assert.equal(portfolioFollowup?.original_message, "Code in HTML.", "follow-up keeps original message");
    assert.equal(llmCalls.some((call) => call.model_override === "qwen-coder"), true, "model call uses qwen-coder");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ result: { text: "not json", model_used: "qwen-coder" } }),
  }) as Response) as typeof fetch;
  try {
    const fallbackClarification = await maybeCreateClarification({ userMessage: "Code in HTML.", userId: "user-1" });
    assert.equal(fallbackClarification?.source, "fallback", "malformed model JSON falls back for high-confidence clarifications");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        result: {
          text: JSON.stringify({
            needs_clarification: true,
            question: "What outcome would help you most?",
            options: [
              { id: "concise", label: "Concise answer", description: "Best when you want the result quickly." },
              { id: "detailed", label: "Detailed explanation", description: "Best when you want to understand the reasoning." },
            ],
          }),
          model_used: body.model_override,
        },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const genericModelCode = await maybeCreateClarification({ userMessage: "Code", userId: "user-1" });
    assert.equal(genericModelCode?.source, "fallback", "generic model code clarification should use coding fallback");
    assert.match(genericModelCode?.question || "", /kind of code/i, "coding fallback should ask for code type");
    assert.doesNotMatch(
      (genericModelCode?.options || []).map((item) => item.label).join(" "),
      /Concise answer|Detailed explanation/i,
      "generic model options should not reach coding clarification UI",
    );
    const genericModelPortfolio = await maybeCreateClarification({
      userMessage: "Personal Portfolio",
      originalMessage: "design a website",
      previousAnswers: ["Personal Portfolio"],
      currentTurn: 1,
      userId: "user-1",
    });
    assert.equal(genericModelPortfolio?.source, "fallback", "generic model portfolio follow-up should use name fallback");
    assert.match(genericModelPortfolio?.question || "", /whose name/i, "portfolio fallback should ask for the name");
    assert.equal(genericModelPortfolio?.options.length, 0, "portfolio name fallback remains zero-option");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const birdOptions = [
    { id: "wild", label: "Wild bird species", description: "Focus on species found in nature." },
    { id: "domestic", label: "Domestic bird breeds", description: "Focus on breeds kept by humans." },
  ];
  const birdOptionAnswer = resolveClarificationInput("Wild bird species", {
    clarification_id: "bird-clarify",
    original_message: "Best bird breeds information",
    question: "Are you interested in wild bird species or domestic bird breeds?",
    options: birdOptions,
    answers: [],
    source: "option",
    selected_option_id: "wild",
  });
  const repeatedBirdDecision = {
    needs_clarification: true,
    question: "Are you interested in wild bird species or domestic bird breeds?",
    options: birdOptions,
    custom_answer_prompt: "Or enter a custom answer in the message bar.",
    reason: "bird_scope",
  };
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: { text: JSON.stringify(repeatedBirdDecision), model_used: body.model_override } }),
    } as Response;
  }) as typeof fetch;
  try {
    const repeatedBirdClarification = await maybeCreateClarification({
      userMessage: birdOptionAnswer.effectiveMessage,
      originalMessage: birdOptionAnswer.originalMessage,
      previousAnswers: birdOptionAnswer.answers,
      currentTurn: birdOptionAnswer.turn,
      answeredQuestion: birdOptionAnswer.answeredQuestion,
      answeredOptions: birdOptionAnswer.answeredOptions,
      selectedOptionId: birdOptionAnswer.selectedOptionId,
      userId: "user-1",
    });
    assert.equal(repeatedBirdClarification, null, "answered option should suppress repeated bird clarification");

    const birdCustomAnswer = resolveClarificationInput("wild bird species", {
      clarification_id: "bird-clarify",
      original_message: "Best bird breeds information",
      question: "Are you interested in wild bird species or domestic bird breeds?",
      options: birdOptions,
      answers: [],
      source: "custom",
    });
    const repeatedBirdCustomClarification = await maybeCreateClarification({
      userMessage: birdCustomAnswer.effectiveMessage,
      originalMessage: birdCustomAnswer.originalMessage,
      previousAnswers: birdCustomAnswer.answers,
      currentTurn: birdCustomAnswer.turn,
      answeredQuestion: birdCustomAnswer.answeredQuestion,
      answeredOptions: birdCustomAnswer.answeredOptions,
      selectedOptionId: birdCustomAnswer.selectedOptionId,
      userId: "user-1",
    });
    assert.equal(repeatedBirdCustomClarification, null, "custom answer matching an option should suppress repeated clarification");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        result: {
          text: JSON.stringify({
            needs_clarification: true,
            question: "Which region should I focus on?",
            options: [
              { id: "north_america", label: "North America", description: "Focus on species found in North America." },
              { id: "europe", label: "Europe", description: "Focus on species found in Europe." },
            ],
            custom_answer_prompt: "Or enter a custom answer in the message bar.",
            reason: "region_scope",
          }),
          model_used: body.model_override,
        },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const differentBirdFollowup = await maybeCreateClarification({
      userMessage: birdOptionAnswer.effectiveMessage,
      originalMessage: birdOptionAnswer.originalMessage,
      previousAnswers: birdOptionAnswer.answers,
      currentTurn: birdOptionAnswer.turn,
      answeredQuestion: birdOptionAnswer.answeredQuestion,
      answeredOptions: birdOptionAnswer.answeredOptions,
      selectedOptionId: birdOptionAnswer.selectedOptionId,
      userId: "user-1",
    });
    assert.equal(differentBirdFollowup?.question, "Which region should I focus on?", "different follow-up can still pass");
    assert.equal(differentBirdFollowup?.options.length, 2, "different follow-up keeps its options");
  } finally {
    globalThis.fetch = originalFetch;
  }

  process.env.TAVILY_KEYS = "clarification-test-key";
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
    if (href.includes("/llm/invoke")) {
      const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          result: {
            text: JSON.stringify({
              needs_clarification: true,
              question: "Which area should I cover for cricket?",
              options: [{ id: "around_world", label: "Around the world", description: "Covers the biggest global updates." }],
              custom_answer_prompt: "Or enter a custom answer in the message bar.",
            }),
            model_used: body.model_override,
          },
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
    installSupabaseEnvForDynamicImports();
    const { resolveHardRoutedPlan } = await import("./orchestrator/planner");
    assert.equal(
      resolveHardRoutedPlan({ userMessage: resolvedDownloadPresentation.effectiveMessage, hasWebSearch: false })?.steps[0]?.tool,
      "file_generation",
      "download option should hard-route to file generation",
    );
    assert.equal(
      resolveHardRoutedPlan({ userMessage: resolvedTextOutline.effectiveMessage, hasWebSearch: false })?.steps[0]?.tool,
      "conversation",
      "chat-only file clarification choice should stay in conversation",
    );
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
      executionMode: "intuitive",
      context: { web_search_mode: "basic", userId: "test-user" },
      skipReflection: true,
    });
    assert.equal(unclearWebSurf.route, "clarification", "unclear WebSurf intent should return clarification");
    assert.doesNotMatch(unclearWebSurf.reply ?? "", /Mock Tavily answer/, "unclear WebSurf discards Tavily output");
    assert.ok(tavilyQueries.length > 0, "unclear WebSurf starts Tavily while clarification is classified");
    await new Promise((resolve) => setTimeout(resolve, 50));

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("api.tavily.com")) {
        tavilyQueries.push("failed-tavily-query");
        throw new Error("Mock Tavily failure");
      }
      if (href.includes("/llm/invoke")) {
        const body = JSON.parse(String(init?.body || "{}")) as { model_override?: string };
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            result: {
              text: JSON.stringify({
                needs_clarification: true,
                question: "Which area should I cover for cricket?",
                options: [{ id: "around_world", label: "Around the world", description: "Covers the biggest global updates." }],
                custom_answer_prompt: "Or enter a custom answer in the message bar.",
              }),
              model_used: body.model_override,
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({}),
      } as Response;
    }) as typeof fetch;
    const failedTavilyClarification = await orchestrate({
      userMessage: "Latest news about cricket.",
      executionMode: "intuitive",
      context: { web_search_mode: "basic", userId: "test-user" },
      skipReflection: true,
    });
    assert.equal(failedTavilyClarification.route, "clarification", "discarded Tavily failure should still return clarification");
    assert.doesNotMatch(failedTavilyClarification.reply ?? "", /Tavily|temporarily unavailable/i, "discarded Tavily failure should not leak to UI");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const frontend = readFrontendSources().combined;
  assert.match(frontend, /clarification_response/, "frontend sends clarification_response");
  assert.match(frontend, /clarification-option-btn/, "frontend renders MCQ option buttons");
  assert.match(frontend, /pendingClarifications/, "frontend tracks pending clarification state");
  assert.match(frontend, /clarification-cancel-btn/, "frontend renders cancel control");
  assert.match(frontend, /clarification-panel-host/, "frontend preserves message-content and nests clarification panel");
  assert.doesNotMatch(frontend, /container\.className\s*=\s*"clarification-panel"/, "clarification rendering must not replace message-content class");
  assert.doesNotMatch(frontend, /pendingClarificationState\.answers\s*=\s*\[/, "frontend should not mutate pending answers before backend success");
  assert.match(frontend, /capturedClarificationResponse/, "retry preserves clarification response payload");
  assert.match(frontend, /current === state\) current\.inFlight = false/, "option clicks reset in-flight state when request fails");
  assert.match(frontend, /clarificationStateLockedForRequest/, "custom clarification answers lock pending state while in flight");
  assert.match(frontend, /question:\s*clarification\.question/, "frontend sends answered clarification question");
  assert.match(frontend, /const options = Array\.isArray\(clarification\.options\)/, "frontend sends answered clarification options");
  assert.match(frontend, /submitClarificationOption\(chatId,\s*payload\.id,\s*option\)/, "option clicks pass clarification id");
  assert.match(frontend, /state\.clarification\?\.id !== clarificationId/, "stale clarification option clicks are ignored");
  assert.match(frontend, /persistChatMessage\(targetChatId, "assistant", assistantText\)/, "clarification persistence stays plain text live-only");
  const clarificationRenderSnippet = frontend.slice(
    frontend.indexOf('if (response?.route === "clarification" && clarificationPayload)'),
    frontend.indexOf("clearPendingClarification(targetChatId);"),
  );
  assert.doesNotMatch(clarificationRenderSnippet, /responseTrust/, "clarification bubbles should not render route/model trust pills");
  const footerSnippet = frontend.slice(
    frontend.indexOf("const footer = document.createElement(\"div\");"),
    frontend.indexOf("panel.appendChild(footer);"),
  );
  assert.match(footerSnippet, /if \(options\.length > 0\)/, "custom-answer helper only renders when MCQs exist");

  console.log("Intent clarification validation passed.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
