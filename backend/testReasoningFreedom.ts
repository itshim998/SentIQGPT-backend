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
      model_used: "gemini-fast",
      truncated: true,
      finish_reason: "length",
    },
    {
      text: "Step 1: Subtract 2 from both sides to get 2x = 4.\nStep 2: Divide by 2 to get x = 2.\nFinal answer: x = 2.",
      model_used: "openai-large",
      truncated: true,
      finish_reason: "length",
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
      modelOverride: "gemini-fast",
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

    assert(capturedRequests.length === 2, "math solver makes a single raw LLM call");
    assert(capturedRequests[1].prompt === "Solve 2x + 2 = 6 and explain the steps.", "math solver sends only the original user prompt");
    assert(capturedRequests[1].skip_wrappers === true, "math solver disables adapter wrappers");
    assert(
      mathReply.answer === "Step 1: Subtract 2 from both sides to get 2x = 4.\nStep 2: Divide by 2 to get x = 2.\nFinal answer: x = 2.",
      "math solver preserves the full explanation",
    );
    assert(mathReply.thinking === undefined, "math solver no longer extracts thinking");

    assert(selectModelForPrompt("Tell me a joke.") === "gemini-fast", "normal chat routing stays on gemini-fast");
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
