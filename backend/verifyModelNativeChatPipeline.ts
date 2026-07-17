import "dotenv/config";
import assert from "node:assert/strict";

type MatrixRow = {
  provider: "groq" | "gemini";
  mode: "fast" | "intuitive";
  case: string;
  status: "PASS" | "FAIL";
  outcome?: "tool_call" | "assistant_text";
  tool?: string;
  transport?: "streaming" | "buffered";
  lifecycle?: readonly string[];
  structured?: boolean;
  error_class?: string;
};

const ALL_TOOLS = ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"] as const;

const POSITIVE_CASES = [
  ["web_surf", "web_surf", "Search the web for the latest major AMD news and cite the sources."],
  ["image_gen", "image_gen", "Generate an image of a golden retriever puppy playing in fresh snow."],
  ["chart_gen", "chart_gen", "Create a bar chart for Alpha 35, Beta 22, and Gamma 14."],
  ["file_gen_pdf", "file_gen", "Create a downloadable PDF containing a one-page study checklist."],
  ["file_gen_txt", "file_gen", "Create a downloadable txt file containing a short launch checklist."],
  ["memory_update", "memory_update", "Remember globally that my preferred report style is concise bullet points."],
] as const;

const NEGATIVE_CASES = [
  ["negative_web_image", "Explain how web search engines index image files."],
  ["negative_chart", "When is a bar chart clearer than a line chart?"],
  ["negative_file_memory", "Compare PDF and TXT files, and explain what computer memory means."],
] as const;

function safeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "Error";
}

async function main(): Promise<void> {
  const [
    { buildChatPrompt, callLLMAdapterTurnStream },
    { consumeModelTurnStream, dispatchAutomaticModelToolCall },
    { assertNoUnbackedToolCompletionClaim },
  ] = await Promise.all([
    import("./ai/PromptBuilders"),
    import("./ai/modelToolExecution"),
    import("./ai/modelToolCompletionClaims"),
  ]);

  const rows: MatrixRow[] = [];
  for (const provider of ["groq", "gemini"] as const) {
    for (const mode of ["fast", "intuitive"] as const) {
      const modelOverride = provider === "groq" ? "gpt-oss-120b" : "gemini-standard";
      const transport = provider === "groq" ? "streaming" : "buffered";
      for (const [caseName, expectedTool, prompt] of POSITIVE_CASES) {
        const row: MatrixRow = {
          provider,
          mode,
          case: caseName,
          status: "FAIL",
          transport,
        };
        try {
          const call = buildChatPrompt({
            userMessage: prompt,
            recentMessages: [],
            memories: [],
            modelOverride,
            userId: "00000000-0000-4000-8000-000000000201",
            streaming: true,
            reasoningEffort: mode === "intuitive" ? "medium" : "low",
          });
          const providerStream = await callLLMAdapterTurnStream({
            ...call,
            execution_mode: mode,
            sentiq_tool_context: { authenticated: true, executionMode: mode },
            sentiq_allowed_tool_names: ALL_TOOLS,
            required_capabilities: [transport === "streaming" ? "sentiq_tools_streaming" : "sentiq_tools_buffered"],
            tool_transport_mode: transport,
          });
          const turn = await consumeModelTurnStream(providerStream, () => undefined, undefined, {
            validateAssistantText: assertNoUnbackedToolCompletionClaim,
          });
          assert.equal(turn.kind, "tool_calls", "provider returned assistant text instead of a tool call");
          assert.equal(turn.calls.length, 1, "provider returned more than one tool call");
          assert.equal(turn.calls[0]?.name, expectedTool, "provider selected the wrong tool");

          const lifecycle: string[] = [];
          const dispatched = await dispatchAutomaticModelToolCall({
            calls: turn.calls,
            context: { authenticated: true, executionMode: mode },
            allowedTools: ALL_TOOLS,
            executeWebSurf: async () => ({ structured: true }),
            executeImage: async () => ({ structured: true }),
            executeChart: async () => ({ structured: true }),
            executeFile: async () => ({ structured: true }),
            executeMemory: async () => ({ structured: true }),
            isFailure: (result) => !result.structured,
            onLifecycleEvent: (event) => { lifecycle.push(event.type); },
          });
          assert.deepEqual(lifecycle, ["tool_selected", "tool_started", "tool_result"]);
          assert.equal(dispatched.result.structured, true);
          row.status = "PASS";
          row.outcome = "tool_call";
          row.tool = expectedTool;
          row.lifecycle = lifecycle;
          row.structured = true;
        } catch (error) {
          row.error_class = safeFailure(error);
        }
        rows.push(row);
      }

      for (const [caseName, prompt] of NEGATIVE_CASES) {
        const row: MatrixRow = { provider, mode, case: caseName, status: "FAIL", transport };
        try {
          const call = buildChatPrompt({
            userMessage: prompt,
            recentMessages: [],
            memories: [],
            modelOverride,
            userId: "00000000-0000-4000-8000-000000000201",
            streaming: true,
            reasoningEffort: mode === "intuitive" ? "medium" : "low",
          });
          const providerStream = await callLLMAdapterTurnStream({
            ...call,
            execution_mode: mode,
            sentiq_tool_context: { authenticated: true, executionMode: mode },
            sentiq_allowed_tool_names: ALL_TOOLS,
            required_capabilities: [transport === "streaming" ? "sentiq_tools_streaming" : "sentiq_tools_buffered"],
            tool_transport_mode: transport,
          });
          const turn = await consumeModelTurnStream(providerStream, () => undefined, undefined, {
            validateAssistantText: assertNoUnbackedToolCompletionClaim,
          });
          assert.equal(turn.kind, "assistant_text", "negative case selected a tool");
          assert.ok(turn.text.trim(), "negative case returned empty assistant text");
          row.status = "PASS";
          row.outcome = "assistant_text";
        } catch (error) {
          row.error_class = safeFailure(error);
        }
        rows.push(row);
      }
    }
  }

  console.log(JSON.stringify({ live_chat_pipeline_matrix: rows }, null, 2));
  const summary = (["groq", "gemini"] as const).flatMap((provider) => (
    (["fast", "intuitive"] as const).map((mode) => {
      const scoped = rows.filter((row) => row.provider === provider && row.mode === mode);
      return {
        provider,
        mode,
        passed: scoped.filter((row) => row.status === "PASS").length,
        total: scoped.length,
        positive_tool_calls: scoped.filter((row) => row.outcome === "tool_call").length,
        negative_text_responses: scoped.filter((row) => row.outcome === "assistant_text").length,
      };
    })
  ));
  console.log(JSON.stringify({ live_chat_pipeline_summary: summary }));
  if (rows.some((row) => row.status === "FAIL")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({
    live_chat_pipeline_matrix: [{ status: "FAIL", case: "harness", error_class: safeFailure(error) }],
  }));
  process.exitCode = 1;
});
