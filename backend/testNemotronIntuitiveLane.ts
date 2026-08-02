import assert from "assert";
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildIntuitiveToolSelectionPrompt,
  buildIntuitiveToolSynthesisEvidence,
  isNemotronIntuitiveLaneEnabled,
  shouldRunIntuitiveFinalSynthesis,
} from "./orchestrator/intuitiveTextLane";

const FLAG_NAMES = [
  "SENTIQ_NVIDIA_PROVIDER_ENABLED",
  "SENTIQ_NEMOTRON_INTUITIVE_ENABLED",
  "SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED",
  "SENTIQ_INTUITIVE_QUOTA_UI_ENABLED",
] as const;

function setFlags(values: readonly [boolean, boolean, boolean, boolean]): void {
  FLAG_NAMES.forEach((name, index) => {
    process.env[name] = values[index] ? "true" : "false";
  });
}

function main(): void {
  const original = new Map(FLAG_NAMES.map((name) => [name, process.env[name]]));
  try {
    setFlags([false, false, false, false]);
    assert.strictEqual(isNemotronIntuitiveLaneEnabled("intuitive"), false);

    setFlags([true, false, false, false]);
    assert.strictEqual(isNemotronIntuitiveLaneEnabled("intuitive"), false);

    setFlags([false, true, false, false]);
    assert.strictEqual(isNemotronIntuitiveLaneEnabled("intuitive"), false);

    setFlags([true, true, false, false]);
    assert.strictEqual(isNemotronIntuitiveLaneEnabled("fast"), false);
    assert.strictEqual(isNemotronIntuitiveLaneEnabled("intuitive"), true);

    setFlags([true, true, true, true]);
    assert.strictEqual(
      isNemotronIntuitiveLaneEnabled("intuitive"),
      true,
      "billing-V2 and quota-UI flags must not affect backend routing",
    );

    const selector = buildIntuitiveToolSelectionPrompt(
      "Create a small chart from these values.",
      ["chart_gen", "web_surf"],
    );
    assert(selector.includes("Decide only"));
    assert(selector.includes("Do not answer"));
    assert(selector.includes("exactly NO_TOOL"));
    assert(selector.includes("chart_gen, web_surf"));
    assert(!selector.toLowerCase().includes("nvidia"));
    assert(!selector.toLowerCase().includes("nemotron"));

    const webEvidence = buildIntuitiveToolSynthesisEvidence({
      tool: "web_search",
      reply: "untrusted legacy answer",
      web_search: {
        query: "current topic",
        sources: [{ title: "Source", url: "https://example.test/source" }],
        results: [{
          title: "Source",
          url: "https://example.test/source",
          content: "trusted evidence",
          provider: "must-not-leak",
        } as never],
      },
    });
    const serializedWebEvidence = JSON.stringify(webEvidence);
    assert(serializedWebEvidence.includes("trusted evidence"));
    assert(!serializedWebEvidence.includes("must-not-leak"));
    assert(!serializedWebEvidence.includes("untrusted legacy answer"));
    assert.strictEqual(shouldRunIntuitiveFinalSynthesis({
      tool: "web_search",
      web_search: {
        query: "current topic",
        sources: [],
        results: [],
      },
    }), true);

    const imageEvidence = buildIntuitiveToolSynthesisEvidence({
      tool: "image_generation",
      image: {
        success: true,
        prompt: "a safe image prompt",
        persisted: true,
        image_base64: "secret-binary",
        provider_used: "must-not-leak",
      } as never,
    });
    const serializedImageEvidence = JSON.stringify(imageEvidence);
    assert(serializedImageEvidence.includes("a safe image prompt"));
    assert(!serializedImageEvidence.includes("secret-binary"));
    assert(!serializedImageEvidence.includes("must-not-leak"));

    const chartEvidence = buildIntuitiveToolSynthesisEvidence({
      tool: "chart_generation",
      chart: {
        success: true,
        chart_type: "line",
        renderer: "plotly",
        code: "must-not-enter-synthesis",
      } as never,
    });
    assert(!JSON.stringify(chartEvidence).includes("must-not-enter-synthesis"));

    const fileEvidence = buildIntuitiveToolSynthesisEvidence({
      tool: "file_generation",
      file: {
        success: true,
        format: "txt",
        file_name: "summary.txt",
        mime_type: "text/plain",
        text: "trusted file preview",
        file_url: "must-not-enter-synthesis",
      } as never,
    });
    const serializedFileEvidence = JSON.stringify(fileEvidence);
    assert(serializedFileEvidence.includes("trusted file preview"));
    assert(!serializedFileEvidence.includes("must-not-enter-synthesis"));

    const memoryEvidence = buildIntuitiveToolSynthesisEvidence({
      tool: "memory_update",
      memory: {
        stored: true,
        scope: "global",
        persisted: true,
        deduplicated: false,
        summary: "must-not-enter-synthesis",
        embedding: [1, 2, 3],
      } as never,
    });
    const serializedMemoryEvidence = JSON.stringify(memoryEvidence);
    assert.strictEqual(
      JSON.parse(memoryEvidence[0].content as string).stored,
      true,
    );
    assert(!serializedMemoryEvidence.includes("must-not-enter-synthesis"));
    assert(!serializedMemoryEvidence.includes("embedding"));
    assert.strictEqual(shouldRunIntuitiveFinalSynthesis({
      tool: "memory_update",
      memory: { stored: true },
    }), true);

    const executorSource = readFileSync(
      join(__dirname, "orchestrator", "toolExecutor.ts"),
      "utf8",
    );
    const conversationStart = executorSource.indexOf("async function execConversation");
    const selectionTurn = executorSource.indexOf(
      "const selectedToolCalls = await selectChatToolCalls",
      conversationStart,
    );
    const finalAnswerTurn = executorSource.indexOf(
      "result = await handleChat",
      selectionTurn,
    );
    assert(conversationStart >= 0 && selectionTurn > conversationStart);
    assert(
      finalAnswerTurn > selectionTurn,
      "the selection-only turn must precede the sole ordinary final-answer turn",
    );
    assert(executorSource.includes("allowedModelTools: intuitiveLaneActive ? [] : automaticTools"));
    assert(executorSource.includes("synthesizeIntuitiveToolResult"));
    assert(executorSource.includes("protectIntuitiveFinalSynthesis"));
    assert(executorSource.includes("consumeFutureObligationId: INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID"));
    assert(
      executorSource.includes("const reusesActiveRequestBudget = Boolean(webSurfEvidence && getTokenAllowanceAccounting())"),
      "nested WebSurf synthesis must reuse the outer request-local ledger",
    );

    const chatHandlerSource = readFileSync(join(__dirname, "ai", "ChatHandler.ts"), "utf8");
    const selectorFunctionStart = chatHandlerSource.indexOf("export async function selectChatToolCalls");
    const selectorFunctionEnd = chatHandlerSource.indexOf("export interface ImageTextRenderingDecision", selectorFunctionStart);
    const selectorFunction = chatHandlerSource.slice(selectorFunctionStart, selectorFunctionEnd);
    assert(selectorFunctionStart >= 0 && selectorFunctionEnd > selectorFunctionStart);
    assert(
      selectorFunction.includes('execution_mode: "fast"'),
      "shared Intuitive tool-decision turns must stay on the Fast auxiliary lane",
    );
    assert(
      selectorFunction.includes('reasoning_effort: "low"'),
      "shared Intuitive tool-decision turns must reserve their bounded output for the decision",
    );

    const serverSource = readFileSync(join(__dirname, "server.ts"), "utf8");
    assert(serverSource.includes("const intuitiveToolSelectionActive = intuitiveLaneActive && automaticTools.length > 0"));
    const selectorConfigs = [...serverSource.matchAll(
      /prompt:\s*buildIntuitiveToolSelectionPrompt\([^)]*\)[\s\S]{0,240}?execution_mode:\s*"([^"]+)"[\s\S]{0,120}?reasoning_effort:\s*"([^"]+)"/g,
    )].map((match) => ({ executionMode: match[1], reasoningEffort: match[2] }));
    assert.deepStrictEqual(
      selectorConfigs,
      [
        { executionMode: "fast", reasoningEffort: "low" },
        { executionMode: "fast", reasoningEffort: "low" },
      ],
      "guest and authenticated Intuitive tool-decision turns must stay on the bounded Fast/low auxiliary lane",
    );
    assert(
      serverSource.includes("if (intuitiveToolSelectionActive) return;"),
      "selection text must never be forwarded as a client-visible answer",
    );
    assert(serverSource.includes("toolResult = await synthesizeIntuitiveToolResult"));
    assert(serverSource.includes("protectIntuitiveFinalSynthesis"));
    assert(serverSource.includes("consume_future_obligation_id: INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID"));

    console.log("Nemotron Intuitive lane validation passed.");
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

main();
