import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildLLMGatewayRequestBody,
  buildNodeModelToolDiagnostic,
  buildSentIQToolTransportRequest,
} from "./ai/PromptBuilders";
import {
  canUseSentIQTools,
  getAutomaticSentIQToolsForRoute,
  getEnabledAutomaticSentIQTools,
  getModelToolRuntimeSnapshot,
  getSentIQToolCapability,
  findObsoleteModelToolEnvironmentNames,
  isGeminiSentIQToolTransportEnabled,
  isGroqSentIQToolModel,
  isGroqSentIQToolTransportEnabled,
  isModelToolDiagnosticsEnabled,
  isModelToolRegistryEnabled,
  resolveModelToolTransport,
  routeSupportsCapability,
  SENTIQ_MODEL_TOOL_ENV,
} from "./ai/modelToolCapability";
import { ToolCallStreamAccumulator, normalizeBufferedProviderResult } from "./ai/modelToolTransport";

const guest = { authenticated: false } as const;
const authenticated = { authenticated: true } as const;

assert.equal(isModelToolRegistryEnabled(undefined), false);
assert.equal(isGroqSentIQToolTransportEnabled(undefined), false);
assert.equal(isGeminiSentIQToolTransportEnabled(undefined), false);
assert.equal(isModelToolRegistryEnabled("TRUE"), true);
assert.equal(isModelToolDiagnosticsEnabled(undefined), false);
assert.deepEqual(
  Object.values(SENTIQ_MODEL_TOOL_ENV).filter((name) => name !== SENTIQ_MODEL_TOOL_ENV.diagnostics),
  [
    "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
    "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
    "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
    "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",
    "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
    "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
    "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
    "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
    "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  ],
  "runtime uses one canonical name for every model-tool gate",
);
assert.equal(SENTIQ_MODEL_TOOL_ENV.diagnostics, "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED");
assert.equal(isGroqSentIQToolModel("gpt-oss-120b"), true);
assert.equal(isGroqSentIQToolModel("openai/gpt-oss-120b"), true);
assert.equal(isGroqSentIQToolModel("groq:openai/gpt-oss-120b"), true);
assert.equal(isGroqSentIQToolModel("legacy-unsupported-model"), false);

assert.deepEqual(getSentIQToolCapability("groq"), {
  provider: "groq",
  buffered: true,
  streaming: true,
  reason: "openai_function_transport",
});
assert.equal(canUseSentIQTools("gemini", false), true);
assert.equal(canUseSentIQTools("gemini", true), false);
assert.equal(canUseSentIQTools("gemma", false), false);
assert.equal(canUseSentIQTools("pollinations", true), true);

const parityFixtures = JSON.parse(
  readFileSync("backend/fixtures/modelToolCapabilityParity.json", "utf8"),
) as Array<{ alias: string; provider: string; model: string; buffered: boolean; streaming: boolean }>;
for (const fixture of parityFixtures) {
  const route = { provider: fixture.provider, model: fixture.model };
  assert.equal(
    routeSupportsCapability(route, "sentiq_tools_buffered"),
    fixture.buffered,
    `${fixture.alias} buffered capability must match the parity fixture`,
  );
  assert.equal(
    routeSupportsCapability(route, "sentiq_tools_streaming"),
    fixture.streaming,
    `${fixture.alias} streaming capability must match the parity fixture`,
  );
}

const previousModelToolEnvironment = new Map(
  Object.values(SENTIQ_MODEL_TOOL_ENV).map((name) => [name, process.env[name]] as const),
);
try {
  for (const name of Object.values(SENTIQ_MODEL_TOOL_ENV)) process.env[name] = "true";
  const expectedAuthenticatedTools = ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"] as const;
  assert.deepEqual(getEnabledAutomaticSentIQTools(), expectedAuthenticatedTools);
  assert.deepEqual(
    getAutomaticSentIQToolsForRoute({ provider: "groq", model: "gpt-oss-120b" }, true),
    expectedAuthenticatedTools,
  );
  assert.deepEqual(
    getAutomaticSentIQToolsForRoute({ provider: "groq", model: "openai/gpt-oss-120b" }, false),
    expectedAuthenticatedTools,
  );
  assert.deepEqual(
    getAutomaticSentIQToolsForRoute({ provider: "gemini", model: "gemini-standard" }, true),
    expectedAuthenticatedTools,
  );
  assert.deepEqual(resolveModelToolTransport(
    { provider: "gemini", model: "gemini-standard" },
    "streaming",
  ), {
    provider: "gemini",
    model: "gemini-standard",
    requestedMode: "streaming",
    mode: "buffered",
    supported: true,
    reason: "buffered_tool_bridge",
  });
  assert.deepEqual(
    getAutomaticSentIQToolsForRoute({ provider: "gemini", model: "gemini-3.1-flash-lite" }, false),
    expectedAuthenticatedTools,
  );
  assert.deepEqual(getAutomaticSentIQToolsForRoute({ provider: "gemini", model: "gemma-4-31b-it" }, true), []);
  assert.deepEqual(
    getAutomaticSentIQToolsForRoute({ provider: "pollinations", model: "mistral" }, false),
    expectedAuthenticatedTools,
  );
  assert.deepEqual(getAutomaticSentIQToolsForRoute({ provider: "groq", model: "legacy-unsupported-model" }, true), []);
  assert.deepEqual(getModelToolRuntimeSnapshot(), {
    registryEnabled: true,
    groqTransportEnabled: true,
    geminiTransportEnabled: true,
    pollinationsTransportEnabled: true,
    nvidiaTransportEnabled: false,
    webSurfSelectionEnabled: true,
    imageSelectionEnabled: true,
    chartSelectionEnabled: true,
    fileSelectionEnabled: true,
    memorySelectionEnabled: true,
    diagnosticsEnabled: true,
  });
  for (const executionMode of ["fast", "intuitive"] as const) {
    const streamingCall = {
      prompt: "ordinary authenticated request",
      task: "chat" as const,
      user_id: "user-1",
      sentiq_tool_context: { authenticated: true, executionMode },
      sentiq_allowed_tool_names: expectedAuthenticatedTools,
      required_capabilities: ["sentiq_tools_streaming"] as const,
      tool_transport_mode: "streaming" as const,
    };
    const toolRequest = buildSentIQToolTransportRequest(streamingCall, true);
    assert.deepEqual(toolRequest?.allowed_tool_names, expectedAuthenticatedTools);
    const bufferedCall = {
      ...streamingCall,
      required_capabilities: ["sentiq_tools_buffered"] as const,
      tool_transport_mode: "buffered" as const,
    };
    const bufferedBody = buildLLMGatewayRequestBody(bufferedCall, { sentiqToolRequest: toolRequest });
    const streamingBody = buildLLMGatewayRequestBody(streamingCall, { sentiqToolRequest: toolRequest });
    assert.deepEqual(bufferedBody.sentiq_tool_request, toolRequest);
    assert.deepEqual(streamingBody.sentiq_tool_request, toolRequest);
    assert.deepEqual(bufferedBody.required_capabilities, ["sentiq_tools_buffered"]);
    assert.deepEqual(streamingBody.required_capabilities, ["sentiq_tools_streaming"]);
    assert.equal(bufferedBody.tool_transport_mode, "buffered");
    assert.equal(streamingBody.tool_transport_mode, "streaming");
    const diagnostic = buildNodeModelToolDiagnostic({
      boundary: "node_stream_request",
      call: { ...streamingCall, model_override: "groq:gpt-oss-120b" },
      request: toolRequest,
      streaming: true,
    });
    assert.equal(diagnostic.provider, "groq");
    assert.equal(diagnostic.resolved_model, "groq:gpt-oss-120b");
    assert.deepEqual(diagnostic.allowed_tool_names, expectedAuthenticatedTools);
    assert.equal("prompt" in diagnostic, false);
    assert.equal("user_id" in diagnostic, false);
  }
} finally {
  for (const [name, value] of previousModelToolEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

assert.deepEqual(findObsoleteModelToolEnvironmentNames({
  SENTIQ_GROQ_MODEL_TOOL_TRANSPORT_ENABLED: "true",
  SENTIQ_MODEL_TOOL_REGISTRY_ENABLE: "true",
  SENTIQ_MODEL_TOOL_REGISTRY_ENABLED: "true",
  SENTIQ_IMAGE_STORAGE_DB: "1",
}), ["SENTIQ_GROQ_MODEL_TOOL_TRANSPORT_ENABLED", "SENTIQ_MODEL_TOOL_REGISTRY_ENABLE"]);

assert.equal(buildSentIQToolTransportRequest({ prompt: "hello", task: "chat" }, false), undefined);
assert.equal(buildSentIQToolTransportRequest({ prompt: "classify", task: "memory_classify" }, true), undefined);
assert.deepEqual(
  buildSentIQToolTransportRequest({ prompt: "hello", task: "chat", user_id: "guest" }, true)?.allowed_tool_names,
  ["web_surf", "image_gen"],
);
assert.equal(buildSentIQToolTransportRequest({ prompt: "title", task: "general", user_id: "user-1" }, true), undefined);
assert.deepEqual(
  buildSentIQToolTransportRequest({
    prompt: "hello",
    task: "chat",
    user_id: "user-1",
    sentiq_tool_context: authenticated,
  }, true)?.allowed_tool_names,
  ["web_surf", "image_gen", "chart_gen", "file_gen", "memory_update"],
);

assert.deepEqual(normalizeBufferedProviderResult({ kind: "assistant_text", text: "ordinary" }, guest), {
  kind: "assistant_text",
  text: "ordinary",
});
assert.equal(normalizeBufferedProviderResult({
  kind: "tool_calls",
  calls: [{ id: "buffered_1", name: "image_gen", arguments: '{"prompt":"A lighthouse","requires_text_rendering":false}' }],
}, guest).kind, "tool_calls");

const explicitToolFixtures = [
  {
    userRequest: "Use WebSurf to find the latest verified update.",
    call: { id: "fixture_web", name: "web_surf", arguments: { query: "latest verified update" } },
  },
  {
    userRequest: "Generate an image of a lighthouse.",
    call: { id: "fixture_image", name: "image_gen", arguments: { prompt: "A lighthouse", requires_text_rendering: false } },
  },
  {
    userRequest: "Create a bar chart for this data.",
    call: { id: "fixture_chart", name: "chart_gen", arguments: { request: "Create the requested bar chart" } },
  },
  {
    userRequest: "Create a downloadable PDF report.",
    call: { id: "fixture_file", name: "file_gen", arguments: { request: "Create the requested report", format: "pdf" } },
  },
  {
    userRequest: "Remember that I prefer concise answers.",
    call: { id: "fixture_memory", name: "memory_update", arguments: { content: "The user prefers concise answers.", type: "preference", scope: "global" } },
  },
] as const;
for (const fixture of explicitToolFixtures) {
  const normalized = normalizeBufferedProviderResult({ kind: "tool_calls", calls: [fixture.call] }, authenticated);
  assert.equal(normalized.kind, "tool_calls", `${fixture.userRequest} normalizes as a model tool call`);
  assert.equal(normalized.kind === "tool_calls" ? normalized.calls[0]?.name : undefined, fixture.call.name);
}

const stream = new ToolCallStreamAccumulator(authenticated, ["file_gen"]);
assert.deepEqual(stream.push({ kind: "tool_call_start", id: "stream_1", name: "file_gen", index: 0 }), [
  { kind: "tool_call_start", id: "stream_1", name: "file_gen", index: 0 },
]);
assert.deepEqual(stream.push({ kind: "tool_argument_delta", id: "stream_1", text: '{"request":"Build', index: 0 }), [
  { kind: "tool_argument_delta", id: "stream_1", text: '{"request":"Build', index: 0 },
]);
stream.push({ kind: "tool_argument_delta", id: "stream_1", text: ' a report","format":"pdf"}', index: 0 });
const completed = stream.push({ kind: "done", finishReason: "tool_calls" });
assert.equal(completed[0]?.kind, "tool_calls_complete");
assert.deepEqual(completed[0]?.kind === "tool_calls_complete" ? completed[0].calls[0]?.arguments : undefined, {
  request: "Build a report",
  format: "pdf",
});
assert.deepEqual(completed[1], { kind: "done", finishReason: "tool_calls" });

const textStream = new ToolCallStreamAccumulator(guest, ["web_surf", "image_gen"]);
assert.deepEqual(textStream.push({ kind: "text_delta", text: "Hello" }), [{ kind: "text_delta", text: "Hello" }]);
assert.throws(
  () => textStream.push({ kind: "tool_call_start", id: "late_1", name: "web_surf", index: 0 }),
  /after visible text/,
);

const incomplete = new ToolCallStreamAccumulator(guest, ["web_surf"]);
incomplete.push({ kind: "tool_call_start", id: "bad_1", name: "web_surf", index: 0 });
incomplete.push({ kind: "tool_argument_delta", id: "bad_1", text: '{"query":', index: 0 });
assert.throws(() => incomplete.push({ kind: "done" }), /valid JSON/);

const mismatched = new ToolCallStreamAccumulator(guest, ["web_surf"]);
mismatched.push({ kind: "tool_call_start", id: "match_1", name: "web_surf", index: 0 });
assert.throws(
  () => mismatched.push({ kind: "tool_argument_delta", id: "match_1", text: "{}", index: 1 }),
  /do not match/,
);

assert.throws(
  () => new ToolCallStreamAccumulator(guest, ["web_surf"]).push({
    kind: "tool_call_start",
    id: "unknown_1",
    name: "file_gen",
    index: 0,
  }),
  /unavailable/,
);
assert.throws(
  () => new ToolCallStreamAccumulator(guest, ["web_surf"]).push({ kind: "done" }),
  /without assistant text or a tool call/,
);

console.log("Model tool capability and transport checks passed.");
