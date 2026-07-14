import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSentIQToolTransportRequest } from "./ai/PromptBuilders";
import {
  AutomaticToolDispatchError,
  consumeModelTurnStream,
  dispatchAutomaticModelToolCall,
} from "./ai/modelToolExecution";
import {
  getEnabledAutomaticSentIQTools,
  isModelImageSelectionEnabled,
  isModelWebSurfSelectionEnabled,
} from "./ai/modelToolCapability";
import { resolveHardRoutedPlan } from "./orchestrator/planner";
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
  assert.equal(isModelWebSurfSelectionEnabled("true"), true);
  assert.equal(isModelImageSelectionEnabled("TRUE"), true);

  const previous = {
    registry: process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED,
    web: process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED,
    image: process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED,
    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,
  };
  process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED = "true";
  process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED = "true";
  process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED = "false";
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
    const webDispatch = await dispatchAutomaticModelToolCall({
      calls: [call],
      context: { authenticated: false, executionMode: "fast" },
      allowedTools: ["web_surf"],
      executeWebSurf: async (query) => {
        receivedQuery = query;
        return { ok: true };
      },
      executeImage: async () => assert.fail("web selection must not execute image generation"),
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
    const imageDispatch = await dispatchAutomaticModelToolCall({
      calls: [imageCall],
      context: { authenticated: false, executionMode: "intuitive" },
      allowedTools: ["image_gen"],
      executeWebSurf: async () => assert.fail("image selection must not execute WebSurf"),
      executeImage: async (prompt) => {
        receivedPrompt = prompt;
        return { success: true };
      },
    });
    assert.equal(receivedPrompt, imageCall.arguments.prompt, "validated model image prompts pass directly to execution");
    assert.equal(imageDispatch.events.at(-1)?.type, "tool_result");

    await assert.rejects(
      () => dispatchAutomaticModelToolCall({
        calls: [imageCall],
        context: { authenticated: false, executionMode: "fast" },
        allowedTools: ["image_gen"],
        executeWebSurf: async () => ({ success: false }),
        executeImage: async () => { throw new Error("provider failed"); },
      }),
      (error: unknown) => error instanceof AutomaticToolDispatchError
        && error.events.at(-1)?.type === "tool_error",
    );

    assert.equal(resolveHardRoutedPlan({
      userMessage: "Latest FIFA updates of 2026",
      hasWebSearch: true,
      modelWebSurfSelection: true,
    }), null);
    assert.equal(resolveHardRoutedPlan({
      userMessage: "Generate an image of a puppy",
      hasWebSearch: true,
      modelImageSelection: true,
    }), null);
    assert.equal(resolveHardRoutedPlan({
      userMessage: "Latest FIFA updates of 2026",
      hasWebSearch: true,
      explicitWebSearchMode: "basic",
      modelWebSurfSelection: true,
    })?.steps[0]?.tool, "web_search");

    const serverSource = readFileSync(resolve(__dirname, "server.ts"), "utf8");
    const executorSource = readFileSync(resolve(__dirname, "orchestrator", "toolExecutor.ts"), "utf8");
    const executionSource = readFileSync(resolve(__dirname, "ai", "modelToolExecution.ts"), "utf8");
    assert.match(serverSource, /callLLMAdapterTurnStream/, "streaming ordinary chat consumes normalized provider-neutral turns");
    assert.match(serverSource, /automaticToolAccepted/, "accepted tool selections close text-provider recovery");
    assert.match(serverSource, /guestAutomaticToolAccepted/, "guest accepted selections also close recovery");
    assert.match(executorSource, /execConversation\(originalUserRequest, ctx, "", profile, signal, evidence\)/, "WebSurf synthesis retains the original request");
    assert.match(executionSource, /tool_result/, "confirmed tool results emit a normalized lifecycle");
    assert.match(executionSource, /tool_error/, "tool failures emit a normalized lifecycle");

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
      await assert.rejects(() => fetchPollinationsImage("https://example.com/image", 1000, controller.signal), /aborted/);
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
    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;
    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;
  }
  console.log("Model-native tool execution checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
