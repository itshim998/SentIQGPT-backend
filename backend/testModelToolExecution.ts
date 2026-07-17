import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSentIQToolTransportRequest } from "./ai/PromptBuilders";
import {
  AutomaticToolDispatchError,
  consumeModelTurnStream,
  dispatchAutomaticModelToolCall,
  ModelTurnProgressTracker,
} from "./ai/modelToolExecution";
import { assertNoUnbackedToolCompletionClaim } from "./ai/modelToolCompletionClaims";
import {
  getEnabledAutomaticSentIQTools,
  isModelChartSelectionEnabled,
  isModelFileSelectionEnabled,
  isModelImageSelectionEnabled,
  isModelMemorySelectionEnabled,
  isModelWebSurfSelectionEnabled,
} from "./ai/modelToolCapability";
import { planTask } from "./orchestrator/planner";
import {
  authorizeAutomaticMemoryUpdate,
  enforceAutomaticMemoryScope,
  inferAutomaticMemoryType,
  resolveAutomaticMemoryUpdate,
} from "./ai/modelToolMemorySafety";
import { fetchPollinationsImage } from "./tools/imageGeneration/pollinationsUtils";
import { validateSingleAutomaticToolCall, type ProviderDelta, type ValidatedToolCall } from "./orchestrator/toolContract";

function streamOf(events: readonly ProviderDelta[]): ReadableStream<ProviderDelta> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

async function main(): Promise<void> {
  assert.equal(isModelWebSurfSelectionEnabled(undefined), false);
  assert.equal(isModelImageSelectionEnabled(undefined), false);
  assert.equal(isModelChartSelectionEnabled(undefined), false);
  assert.equal(isModelFileSelectionEnabled(undefined), false);
  assert.equal(isModelMemorySelectionEnabled(undefined), false);
  assert.equal(isModelWebSurfSelectionEnabled("true"), true);
  assert.equal(isModelImageSelectionEnabled("TRUE"), true);

  const previous = {
    registry: process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED,
    web: process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED,
    image: process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED,
    chart: process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED,
    file: process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED,
    memory: process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED,
    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,
  };
  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED = "true";
  process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED = "false";
  process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED = "false";
  process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED = "false";
  process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED = "false";
  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "false";
  try {
    assert.deepEqual(getEnabledAutomaticSentIQTools(), [], "selection flags require an enabled provider transport");
    process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "true";
    assert.deepEqual(getEnabledAutomaticSentIQTools(), ["web_surf"]);
    assert.deepEqual(
      buildSentIQToolTransportRequest({
        task: "chat",
        prompt: "latest updates",
        user_id: "guest",
        sentiq_allowed_tool_names: ["web_surf"],
      }, true)?.allowed_tool_names,
      ["web_surf"],
    );

    const visible: string[] = [];
    const textTurn = await consumeModelTurnStream(streamOf([
      { kind: "text_delta", text: "ordinary " },
      { kind: "text_delta", text: "answer" },
      { kind: "done" },
    ]), (text) => { visible.push(text); });
    assert.deepEqual(textTurn, { kind: "assistant_text", text: "ordinary answer" });
    assert.deepEqual(visible, ["ordinary ", "answer"]);
    const validatedVisible: string[] = [];
    await consumeModelTurnStream(streamOf([
      { kind: "text_delta", text: "ordinary " },
      { kind: "text_delta", text: "answer" },
      { kind: "done" },
    ]), (text) => { validatedVisible.push(text); }, undefined, {
      validateAssistantText: assertNoUnbackedToolCompletionClaim,
    });
    assert.deepEqual(validatedVisible, ["ordinary answer"], "claim validation occurs before text becomes visible");
    await assert.rejects(
      () => consumeModelTurnStream(streamOf([
        { kind: "text_delta", text: "I searched the web and found it." },
        { kind: "done" },
      ]), () => assert.fail("an unbacked completion claim must not become visible"), undefined, {
        validateAssistantText: assertNoUnbackedToolCompletionClaim,
      }),
      /without a corresponding tool result/,
    );
    assert.doesNotThrow(() => assertNoUnbackedToolCompletionClaim("I can explain how web search works."));
    assert.doesNotThrow(() => assertNoUnbackedToolCompletionClaim("I have not searched the web."));

    const progress = new ModelTurnProgressTracker();
    assert.equal(progress.canRecover(), true);
    progress.advance("tool_selection_started");
    assert.equal(progress.canRecover(), false);
    progress.advance("validated_selection_accepted");
    progress.advance("execution_started");
    assert.equal(progress.state, "execution_started");
    assert.throws(() => progress.advance("visible_text_started"), /move backward|cannot mix/);
    for (const question of [
      "Which Jordan do you mean?",
      "Which earlier report should I use?",
      "Please attach or identify the file you want me to edit.",
      "Which output format would you like?",
    ]) {
      const clarificationTurn = await consumeModelTurnStream(streamOf([
        { kind: "text_delta", text: question },
        { kind: "done" },
      ]), () => undefined);
      assert.deepEqual(clarificationTurn, { kind: "assistant_text", text: question });
    }

    const call: ValidatedToolCall = {
      id: "call_web_1",
      name: "web_surf",
      arguments: { query: "Latest FIFA updates of 2026" },
      index: 0,
    };
    const toolTurn = await consumeModelTurnStream(streamOf([
      { kind: "tool_call_start", id: call.id, name: call.name, index: 0 },
      { kind: "tool_calls_complete", calls: [call] },
      { kind: "done", finishReason: "tool_calls" },
    ]), () => assert.fail("tool payloads must not become visible text"));
    assert.deepEqual(toolTurn, { kind: "tool_calls", calls: [call] });

    assert.throws(
      () => validateSingleAutomaticToolCall(
        [call, { ...call, id: "call_web_2", index: 1 }],
        { authenticated: false, executionMode: "fast" },
        ["web_surf"],
      ),
      /exactly one tool call/,
    );

    const lifecycle: string[] = [];
    let receivedQuery = "";
    const webDispatch = await dispatchAutomaticModelToolCall<{ ok: boolean }>({
      calls: [call],
      context: { authenticated: false, executionMode: "fast" },
      allowedTools: ["web_surf"],
      executeWebSurf: async (query) => {
        receivedQuery = query;
        return { ok: true };
      },
      executeImage: async () => assert.fail("web selection must not execute image generation"),
      executeChart: async () => assert.fail("web selection must not execute chart generation"),
      executeFile: async () => assert.fail("web selection must not execute file generation"),
      executeMemory: async () => assert.fail("web selection must not execute memory update"),
      onLifecycleEvent: (event) => { lifecycle.push(event.type); },
    });
    assert.equal(receivedQuery, "Latest FIFA updates of 2026", "validated usable queries pass through unchanged");
    assert.deepEqual(lifecycle, ["tool_selected", "tool_started", "tool_result"]);
    assert.equal(webDispatch.call.name, "web_surf");

    const imageCall: ValidatedToolCall = {
      id: "call_image_1",
      name: "image_gen",
      arguments: { prompt: "A concise executable image prompt for a puppy" },
      index: 0,
    };
    let receivedPrompt = "";
    const imageDispatch = await dispatchAutomaticModelToolCall<{ success: boolean }>({
      calls: [imageCall],
      context: { authenticated: false, executionMode: "intuitive" },
      allowedTools: ["image_gen"],
      executeWebSurf: async () => assert.fail("image selection must not execute WebSurf"),
      executeImage: async (prompt) => {
        receivedPrompt = prompt;
        return { success: true };
      },
      executeChart: async () => assert.fail("image selection must not execute chart generation"),
      executeFile: async () => assert.fail("image selection must not execute file generation"),
      executeMemory: async () => assert.fail("image selection must not execute memory update"),
    });
    assert.equal(receivedPrompt, imageCall.arguments.prompt, "validated model image prompts pass directly to execution");
    assert.equal(imageDispatch.events.at(-1)?.type, "tool_result");

    await assert.rejects(
      () => dispatchAutomaticModelToolCall<{ success: boolean }>({
        calls: [imageCall],
        context: { authenticated: false, executionMode: "fast" },
        allowedTools: ["image_gen"],
        executeWebSurf: async () => ({ success: false }),
        executeImage: async () => { throw new Error("provider failed"); },
        executeChart: async () => ({ success: false }),
        executeFile: async () => ({ success: false }),
        executeMemory: async () => ({ success: false }),
      }),
      (error: unknown) => error instanceof AutomaticToolDispatchError
        && error.events.at(-1)?.type === "tool_error",
    );

    process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED = "true";
    process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED = "true";
    process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED = "true";
    assert.deepEqual(getEnabledAutomaticSentIQTools(), ["web_surf", "chart_gen", "file_gen", "memory_update"]);

    const remainingCalls: readonly ValidatedToolCall[] = [
      { id: "call_chart_1", name: "chart_gen", arguments: { request: "Plot revenue by month" }, index: 0 },
      { id: "call_file_1", name: "file_gen", arguments: { request: "Create the report", format: "pdf" }, index: 0 },
      { id: "call_memory_1", name: "memory_update", arguments: { content: "User prefers concise answers.", type: "preference", scope: "chat" }, index: 0 },
    ];
    const executed: string[] = [];
    for (const [remainingIndex, remainingCall] of remainingCalls.entries()) {
      const dispatched = await dispatchAutomaticModelToolCall<{ success: boolean }>({
        calls: [remainingCall],
        context: { authenticated: true, executionMode: remainingIndex % 2 === 0 ? "fast" : "intuitive" },
        allowedTools: [remainingCall.name],
        executeWebSurf: async () => assert.fail("remaining tool must not execute WebSurf"),
        executeImage: async () => assert.fail("remaining tool must not execute image generation"),
        executeChart: async (request) => { executed.push(`chart:${request}`); return { success: true }; },
        executeFile: async (request, format) => { executed.push(`file:${format}:${request}`); return { success: true }; },
        executeMemory: async (content, type, scope) => { executed.push(`memory:${type}:${scope}:${content}`); return { success: true }; },
      });
      assert.equal(dispatched.events.at(-1)?.type, "tool_result");
    }
    assert.deepEqual(executed, [
      "chart:Plot revenue by month",
      "file:pdf:Create the report",
      "memory:preference:chat:User prefers concise answers.",
    ]);
    await assert.rejects(
      () => dispatchAutomaticModelToolCall<{ success: boolean }>({
        calls: [remainingCalls[0]],
        context: { authenticated: true, executionMode: "fast" },
        allowedTools: ["chart_gen"],
        executeWebSurf: async () => ({ success: false }),
        executeImage: async () => ({ success: false }),
        executeChart: async () => { throw new Error("renderer unavailable"); },
        executeFile: async () => ({ success: false }),
        executeMemory: async () => ({ success: false }),
      }),
      (error: unknown) => error instanceof AutomaticToolDispatchError
        && error.call.name === "chart_gen"
        && error.events.at(-1)?.type === "tool_error",
    );

    assert.deepEqual(
      authorizeAutomaticMemoryUpdate("Please remember that my name is Mira."),
      { content: "my name is Mira.", scope: "global" },
    );
    assert.deepEqual(
      authorizeAutomaticMemoryUpdate("My name is Mira. Remember it."),
      { content: "My name is Mira", scope: "global" },
    );
    assert.deepEqual(
      authorizeAutomaticMemoryUpdate("Save for this chat that I prefer concise answers."),
      { content: "I prefer concise answers.", scope: "chat" },
    );
    assert.equal(inferAutomaticMemoryType("my preferred report style is concise bullet points."), "preference");
    assert.equal(inferAutomaticMemoryType("I am working on the Atlas launch project."), "project");
    assert.equal(inferAutomaticMemoryType("my name is Mira."), "identity");
    assert.deepEqual(
      resolveAutomaticMemoryUpdate({
        originalUserMessage: "Remember globally that my preferred report style is concise bullet points.",
      }),
      {
        content: "my preferred report style is concise bullet points.",
        scope: "global",
        type: "preference",
      },
    );
    assert.throws(() => authorizeAutomaticMemoryUpdate("My name is Mira."), /direct, explicit/);
    assert.throws(() => authorizeAutomaticMemoryUpdate("Remember this."), /does not identify/);
    assert.throws(() => authorizeAutomaticMemoryUpdate('She said "remember that my name is Mira".'), /Quoted/);
    assert.throws(() => authorizeAutomaticMemoryUpdate("Remember that my name is Mira and my city is Pune."), /ambiguous/);
    assert.throws(
      () => enforceAutomaticMemoryScope(
        authorizeAutomaticMemoryUpdate("Remember that my name is Mira."),
        "chat",
      ),
      /scope/,
    );

    assert.equal((await planTask({
      userMessage: "Latest FIFA updates of 2026",
    })).steps[0]?.tool, "conversation");
    assert.equal((await planTask({
      userMessage: "Generate an image of a puppy",
    })).steps[0]?.tool, "conversation");
    assert.equal((await planTask({
      userMessage: "Latest FIFA updates of 2026",
      explicitWebSearchMode: "basic",
    })).steps[0]?.tool, "web_search");

    const serverSource = readFileSync(resolve(__dirname, "server.ts"), "utf8");
    const executorSource = readFileSync(resolve(__dirname, "orchestrator", "toolExecutor.ts"), "utf8");
    const executionSource = readFileSync(resolve(__dirname, "ai", "modelToolExecution.ts"), "utf8");
    const frontendSource = readFileSync(resolve(__dirname, "..", "frontend", "scripts", "features", "chat-controller.js"), "utf8");
    assert.match(serverSource, /callLLMAdapterTurnStream/, "streaming ordinary chat consumes normalized provider-neutral turns");
    assert.match(serverSource, /automaticToolAccepted/, "accepted tool selections close text-provider recovery");
    assert.match(serverSource, /guestAutomaticToolAccepted/, "guest accepted selections also close recovery");
    assert.match(executorSource, /execConversation\(originalUserRequest, ctx, "", profile, signal, evidence\)/, "WebSurf synthesis retains the original request");
    assert.match(executionSource, /tool_result/, "confirmed tool results emit a normalized lifecycle");
    assert.match(executionSource, /tool_error/, "tool failures emit a normalized lifecycle");
    assert.match(serverSource, /messageType: "text"[\s\S]*previewJson: \{ chart: result\.chart \}/, "chart payloads persist in the existing idempotent text-message envelope");
    assert.match(frontendSource, /preview\.chart[\s\S]*normalizeChartMeta\(preview\.chart\)/, "reloaded chart messages hydrate structured chart metadata");
    assert.doesNotMatch(serverSource, /\/api\/chat\/intent|clarification_response/, "legacy intent preflight and structured clarification protocol are removed");
    assert.match(frontendSource, /onToolLifecycle/, "frontend loaders consume confirmed tool lifecycle events");

    const originalFetch = globalThis.fetch;
    let providerSignalAborted = false;
    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      providerSignalAborted = init?.signal?.aborted === true;
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await assert.rejects(() => fetchPollinationsImage("https://example.com/image", 1000, controller.signal), /cancelled/);
      assert.equal(providerSignalAborted, true, "active cancellation reaches the image provider fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previous.registry === undefined) delete process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED;
    else process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = previous.registry;
    if (previous.web === undefined) delete process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED;
    else process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED = previous.web;
    if (previous.image === undefined) delete process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED;
    else process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED = previous.image;
    if (previous.chart === undefined) delete process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED;
    else process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED = previous.chart;
    if (previous.file === undefined) delete process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED;
    else process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED = previous.file;
    if (previous.memory === undefined) delete process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED;
    else process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED = previous.memory;
    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;
    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;
  }
  console.log("Model-native tool execution checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
