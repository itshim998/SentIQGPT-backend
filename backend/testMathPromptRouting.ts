import http from "http";
import type { AddressInfo } from "net";
import { readFileSync } from "fs";
import { resolve as pathResolve } from "path";

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}${detail ? ` | ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

type InvokeRequest = {
  prompt?: string;
  task?: string;
  model_override?: string;
  max_output_tokens?: number;
  skip_wrappers?: boolean;
};

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const capturedRequests: InvokeRequest[] = [];
  const capturedStreamRequests: InvokeRequest[] = [];
  const queuedResponses = [
    { text: "\\[\\boxed{x = 4}\\]", model_used: "gemini-search", truncated: false, finish_reason: "stop" },
    { text: "\\[\\boxed{x = 2}\\]", model_used: "openai-large", truncated: false, finish_reason: "stop" },
  ];

  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/llm/stream") {
      const parsed = JSON.parse(await readRequestBody(req)) as InvokeRequest;
      capturedStreamRequests.push(parsed);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ text: "## Solution\n" })}\n\n`);
      res.write(`data: ${JSON.stringify({ text: "\\[\\boxed{x = 5}\\]" })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (req.method !== "POST" || req.url !== "/llm/invoke") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const parsed = JSON.parse(await readRequestBody(req)) as InvokeRequest;
    capturedRequests.push(parsed);
    const next = queuedResponses.shift();
    if (!next) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "No queued response" }));
      return;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ result: next }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    process.env.LLM_SERVICE_URL = `http://127.0.0.1:${port}`;

    const { buildChatPrompt } = await import("./ai/PromptBuilders");
    const { MATH_RESPONSE_SYSTEM_PROMPT } = await import("./ai/mathPrompt");
    const { callMathModelRaw, solveMathDirect, streamMathModelRaw } = await import("./ai/mathVerifier");
    const { detectLogicReasoning, isMathQuery, selectModelForPrompt } = await import("./orchestrator/modelRouter");

    const nonMathGuestPrompt = buildChatPrompt({
      userMessage: "Tell me a short story.",
      modelOverride: "gemini-search",
      userId: "guest",
    });
    assert(!nonMathGuestPrompt.prompt.includes(MATH_RESPONSE_SYSTEM_PROMPT.slice(0, 80)), "guest non-math prompt omits math system prompt");

    const guestMath = await callMathModelRaw({
      userMessage: "Solve 3x + 7 = 19",
      modelOverride: "gemini-search",
      userId: "guest",
      maxOutputTokens: 6000,
    });

    assert(guestMath.answer === "\\[\\boxed{x = 4}\\]", "guest math returns raw prompt-shaped output");
    assert(capturedRequests[0].model_override === "gemini-search", "guest math uses gemini-search");
    assert(capturedRequests[0].max_output_tokens === 6000, "guest math uses expanded token budget");
    assert(capturedRequests[0].skip_wrappers === true, "guest math skips adapter wrappers");
    assert(capturedRequests[0].prompt?.includes(MATH_RESPONSE_SYSTEM_PROMPT.slice(0, 80)) ?? false, "guest math prompt includes math system prompt");

    const loggedInMath = await solveMathDirect("Solve 2x + 2 = 6");
    assert(loggedInMath.answer === "\\[\\boxed{x = 2}\\]", "logged-in math returns raw prompt-shaped output");
    assert(capturedRequests[1].model_override === "openai-large", "logged-in math uses openai-large");
    assert(capturedRequests[1].prompt?.includes(MATH_RESPONSE_SYSTEM_PROMPT.slice(0, 80)) ?? false, "logged-in math prompt includes math system prompt");

    const mathStream = await streamMathModelRaw({
      userMessage: "Solve 4x = 20",
      modelOverride: "openai-large",
      userId: "test-user",
      maxOutputTokens: 1234,
    });
    const reader = mathStream.getReader();
    let streamed = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamed += value;
    }
    assert(streamed === "## Solution\n\\[\\boxed{x = 5}\\]", "math stream returns live SSE chunks");
    assert(capturedStreamRequests.length === 1, "math stream uses /llm/stream");
    assert(capturedStreamRequests[0].model_override === "openai-large", "math stream keeps requested model");
    assert(capturedStreamRequests[0].max_output_tokens === 1234, "math stream forwards max token budget");
    assert(capturedStreamRequests[0].prompt?.includes(MATH_RESPONSE_SYSTEM_PROMPT.slice(0, 80)) ?? false, "math stream prompt includes math system prompt");

    const puzzle = "Solve this step by step: The Missionaries and Cannibals problem has 3 missionaries and 3 cannibals crossing a river in a boat.";
    assert(isMathQuery("Solve 3x + 7 = 19"), "equation solve prompt is math");
    assert(!isMathQuery(puzzle), "Missionaries and Cannibals is not math");
    assert(detectLogicReasoning(puzzle), "Missionaries and Cannibals is logic reasoning");
    assert(selectModelForPrompt(puzzle) === "gpt-oss-120b", "logic puzzle stays on normal chat model");

    const serverSource = readFileSync(pathResolve(__dirname, "server.ts"), "utf8");
    assert(/const isBufferedReasoning = false;/.test(serverSource), "chat stream disables automatic buffered reasoning route gates");
    assert(/const isMathReasoningQuery = false;/.test(serverSource), "chat stream disables automatic math_reasoning route gates");

    console.log("\nMath prompt/verifier regression validation passed.");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
