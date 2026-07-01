import http from "http";
import type { AddressInfo } from "net";

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
  image_attachments?: readonly {
    filename: string;
    mime_type: string;
    base64: string;
    size_bytes: number;
  }[];
};

type QueuedResponse = {
  text: string;
  model_used?: string;
  fallback?: boolean;
  finish_reason?: string | null;
  truncated?: boolean;
  error?: string | null;
  error_detail?: string | null;
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
  const queuedResponses: QueuedResponse[] = [
    {
      text: "Premise 1: All bloops are razzies.\nPremise 2: All razzies are lazzies.\nTherefore, all bloops are lazzies.",
      model_used: "gemini-search",
      truncated: true,
      finish_reason: "length",
    },
    {
      text: "## Solution\n\n\\[\n2x + 2 = 6\n\\]\n\nSubtract \\(2\\) from both sides.",
      model_used: "openai-large",
      truncated: true,
      finish_reason: "length",
    },
    {
      text: "\\[\n2x = 4\n\\]\n\n\\[\n\\boxed{x = 2}\n\\]",
      model_used: "openai-large",
      truncated: false,
      finish_reason: "stop",
    },
    {
      text: "The image shows a math problem. The answer is 42.",
      model_used: "openai-large",
      truncated: false,
      finish_reason: "stop",
    },
    {
      text: "That means we can iterate through the candidate cases.\nFinal Answer: Keep this wording untouched.",
      model_used: "gemini-2.5-flash-lite",
      truncated: true,
      finish_reason: "length",
    },
    {
      text: "Alternatively, preserve this continuation too.",
      model_used: "gemini-2.5-flash-lite",
      truncated: false,
      finish_reason: "stop",
    },
  ];

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/llm/invoke") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const rawBody = await readRequestBody(req);
    const parsed = JSON.parse(rawBody) as InvokeRequest;
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
    const { handleChat } = await import("./ai/ChatHandler");
    const { solveMathDirect } = await import("./ai/mathVerifier");
    const { MATH_RESPONSE_SYSTEM_PROMPT } = await import("./ai/mathPrompt");
    const { selectModelForPrompt } = await import("./orchestrator/modelRouter");

    const reasoningPrompt = buildChatPrompt({
      userMessage: "Prove that the conclusion follows.",
      reasoningMode: true,
      fileReferences: [{ filename: "proof.txt", extractedText: "Given A -> B and B -> C." }],
    });

    assert(!/SYSTEM:/i.test(reasoningPrompt.prompt), "reasoning prompt omits system prompt");
    assert(!/FILE ANALYSIS MODE/i.test(reasoningPrompt.prompt), "reasoning prompt omits file-analysis instructions");
    assert(/USER:\s*Prove that the conclusion follows\./.test(reasoningPrompt.prompt), "reasoning prompt keeps the user question");

    const reasoningReply = await handleChat({
      userMessage: "Prove or disprove: all bloops are lazzies.",
      reasoningMode: true,
      modelOverride: "gemini-search",
    });

    assert(capturedRequests.length === 1, "reasoning mode makes a single raw LLM call");
    assert(capturedRequests[0].skip_wrappers === true, "reasoning mode still disables adapter wrappers");
    assert(!/SYSTEM:/i.test(capturedRequests[0].prompt ?? ""), "reasoning request sent without system prompt");
    assert(
      reasoningReply.reply === "Premise 1: All bloops are razzies.\nPremise 2: All razzies are lazzies.\nTherefore, all bloops are lazzies.",
      "reasoning mode preserves the full explanation",
    );
    assert(reasoningReply.thinking === undefined, "reasoning mode no longer splits thinking");

    const mathReply = await solveMathDirect("Solve 2x + 2 = 6 and explain the steps.");

    assert(capturedRequests.length === 3, "math solver makes one raw continuation call when truncated");
    assert(capturedRequests[1].prompt?.includes(MATH_RESPONSE_SYSTEM_PROMPT.slice(0, 80)) ?? false, "math solver sends the math system prompt");
    assert(/USER:\s*Solve 2x \+ 2 = 6 and explain the steps\./.test(capturedRequests[1].prompt ?? ""), "math solver keeps the original user prompt");
    assert(capturedRequests[1].skip_wrappers === true, "math solver disables adapter wrappers");
    assert(capturedRequests[1].max_output_tokens === 2500, "math solver respects the Fast interactive cap");
    assert(capturedRequests[2].prompt?.includes("Continue the math answer only.") ?? false, "math continuation prompt asks only for continuation");
    assert(capturedRequests[2].max_output_tokens === 2500, "math continuation respects the Fast interactive cap");
    assert(
      mathReply.answer === "## Solution\n\n\\[\n2x + 2 = 6\n\\]\n\nSubtract \\(2\\) from both sides.\n\\[\n2x = 4\n\\]\n\n\\[\n\\boxed{x = 2}\n\\]",
      "math solver preserves and merges raw prompt-shaped output",
    );
    assert(mathReply.thinking === undefined, "math solver no longer extracts thinking");

    const imageAttachment = {
      filename: "problem.png",
      mime_type: "image/png" as const,
      base64: "iVBORw0KGgo=",
      size_bytes: 8,
    };
    const imageMathReply = await solveMathDirect("Solve it.", "test-user", [imageAttachment]);

    assert(capturedRequests.length === 4, "image math solver makes a single native image LLM call");
    assert(/USER:\s*Solve it\./.test(capturedRequests[3].prompt ?? ""), "image math solver keeps the original prompt");
    assert(capturedRequests[3].model_override === "gpt-oss-120b", "image math solver keeps the current primary text route");
    assert(capturedRequests[3].image_attachments?.[0]?.filename === "problem.png", "image math solver forwards image attachments");
    assert(imageMathReply.answer === "The image shows a math problem. The answer is 42.", "image math solver preserves image answer");

    const unsanitizedOpenAiLargeReply = await handleChat({
      userMessage: "Solve the puzzle exactly as you would naturally answer.",
      modelOverride: "openai-large",
    });

    assert(capturedRequests.length === 6, "openai-large chat with continuation makes two raw LLM calls");
    assert(capturedRequests[4].model_override === "openai-large", "openai-large bypass is keyed off the requested route");
    assert(capturedRequests[5].model_override === "openai-large", "openai-large continuation keeps the requested route");
    assert(
      unsanitizedOpenAiLargeReply.reply === "That means we can iterate through the candidate cases.\nFinal Answer: Keep this wording untouched.\nAlternatively, preserve this continuation too.",
      "openai-large chat bypass preserves raw reply and continuation text",
    );
    assert(unsanitizedOpenAiLargeReply.sanitize_bypass === true, "openai-large chat marks sanitize bypass");
    assert(unsanitizedOpenAiLargeReply.thinking === undefined, "openai-large bypass does not split thinking");

    assert(selectModelForPrompt("Tell me a joke.") === "gpt-oss-120b", "normal chat routing uses gpt-oss-120b");
    assert(selectModelForPrompt("Why is this Python loop failing?") === "qwen-coder", "coding routing stays on qwen-coder");

    console.log("\nReasoning freedom validation passed.");
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
