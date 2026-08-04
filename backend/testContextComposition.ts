import assert from "node:assert/strict";
import { buildChatPrompt } from "./ai/PromptBuilders";
import { runWithRequestBudgetContext } from "./context/requestBudgetContext";
import { composeContextDetailed } from "./orchestrator/contextComposer";

function repeated(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${label}-${index}`).join(" ");
}

function indexOfOrFail(prompt: string, marker: string): number {
  const index = prompt.indexOf(marker);
  assert(index >= 0, `expected prompt to contain ${marker}`);
  return index;
}

async function main(): Promise<void> {
  await runWithRequestBudgetContext(
    { planCode: "pro", executionMode: "intuitive", resolution: "billing" },
    async () => {
      const ordered = composeContextDetailed({
        systemPrompt: "SYSTEM POLICY MARKER",
        stableContext: "STABLE CONTEXT MARKER",
        workspaceCapsule: "WORKSPACE CAPSULE MARKER",
        memories: [{ type: "preference", summary: "MEMORY MARKER", importance: 9 }],
        fileReferences: [{ filename: "notes.txt", extractedText: "FILE MARKER" }],
        routeEvidence: [{ content: "ROUTE EVIDENCE MARKER", required: true }],
        conversationSummary: "ROLLING SUMMARY MARKER",
        conversationCapsule: "CONVERSATION CAPSULE MARKER",
        conversation: [{ role: "assistant", content: "RECENT TURN MARKER" }],
        userMessage: "CURRENT USER MARKER",
        tokenBudget: 10_000,
      });
      const markers = [
        "SYSTEM POLICY MARKER",
        "CONTEXT HANDLING RULES",
        "ROUTE EVIDENCE MARKER",
        "FILE MARKER",
        "MEMORY MARKER",
        "STABLE CONTEXT MARKER",
        "WORKSPACE CAPSULE MARKER",
        "ROLLING SUMMARY MARKER",
        "CONVERSATION CAPSULE MARKER",
        "RECENT TURN MARKER",
        "CURRENT USER MARKER",
      ];
      const positions = markers.map((marker) => indexOfOrFail(ordered.prompt, marker));
      assert.deepEqual([...positions].sort((a, b) => a - b), positions, "context sections follow the required stable-to-dynamic order");
      assert(ordered.prompt.trimEnd().endsWith("CURRENT USER MARKER"), "current user message is last");

      const optionalEvidenceFirst = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "Answer using the attached note.",
        memories: [{ type: "preference", summary: "Keep the explanation concise.", importance: 10 }],
        fileReferences: [{ filename: "note.txt", extractedText: "The required note says the launch date is Friday." }],
        routeEvidence: [{ content: repeated("OPTIONAL-WEB", 700), required: false, relevance: 0.1 }],
        conversationSummary: "Earlier discussion concerned launch planning.",
        conversation: [{ role: "user", content: "We are reviewing the launch note." }],
        tokenBudget: 700,
      });
      assert(
        optionalEvidenceFirst.telemetry.droppedCounts.optional_evidence > 0
          || optionalEvidenceFirst.telemetry.elasticBlocksReduced > 0,
        "optional evidence degrades before protected file and memory context",
      );
      assert.equal(optionalEvidenceFirst.telemetry.selectedCounts.file_chunks, 1, "file context survives optional evidence degradation");
      assert.equal(optionalEvidenceFirst.telemetry.selectedCounts.memories, 1, "relevant memory survives optional evidence degradation");

      const longHistory = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "CURRENT QUESTION MUST SURVIVE",
        conversation: Array.from({ length: 24 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: repeated(`OLD-TURN-${index}`, 40),
        })),
        tokenBudget: 500,
      });
      assert(longHistory.telemetry.droppedCounts.recent_turns > 0, "oldest recent turns are dropped under pressure");
      assert(longHistory.prompt.includes("CURRENT QUESTION MUST SURVIVE"), "long history cannot crowd out current question");
      assert(longHistory.prompt.trimEnd().endsWith("CURRENT QUESTION MUST SURVIVE"), "current question remains last after trimming");

      const capsuleBackedHistory = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What should we do next?",
        workspaceCapsule: "WORKSPACE PROJECT: Atlas uses a staged rollout.",
        conversationCapsule: "CONVERSATION DECISIONS: deploy the API before the client.",
        conversation: Array.from({ length: 6 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: `RECENT-${index}: short recent turn`,
        })),
        tokenBudget: 1_000,
      });
      assert(capsuleBackedHistory.prompt.includes("WORKSPACE PROJECT: Atlas"), "workspace capsule is available across conversations");
      assert(capsuleBackedHistory.prompt.includes("CONVERSATION DECISIONS"), "conversation capsule carries compact older context");
      assert(capsuleBackedHistory.prompt.includes("RECENT-5"), "recent turns remain alongside the capsule");
      assert(capsuleBackedHistory.prompt.trimEnd().endsWith("What should we do next?"), "current question stays protected with capsules");

      const oversizedCapsules = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "CURRENT CAPSULE QUESTION",
        workspaceCapsule: repeated("OLD-WORKSPACE-CONTEXT", 1_200),
        conversationCapsule: repeated("OLD-CONVERSATION-CONTEXT", 1_200),
        tokenBudget: 350,
      });
      assert(oversizedCapsules.telemetry.droppedCounts.summaries > 0, "capsules are degraded under budget pressure");
      assert(oversizedCapsules.prompt.includes("CURRENT CAPSULE QUESTION"), "capsule trimming cannot displace the current question");

      const largeFileText = [
        repeated("opening", 3_000),
        "UNIQUE RELEVANT NEEDLE: quarterly margin improved to 42 percent.",
        repeated("appendix", 3_000),
      ].join("\n");
      const largeFile = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What was the quarterly margin?",
        fileReferences: [{ filename: "large-report.txt", extractedText: largeFileText }],
        tokenBudget: 1_000,
      });
      assert(largeFile.telemetry.droppedCounts.file_chunks > 0, "large file is chunked and reduced");
      assert(largeFile.prompt.includes("quarterly margin improved to 42 percent"), "query-relevant file chunk is retained");
      assert(largeFile.prompt.length < largeFileText.length / 4, "raw file text is not injected wholesale");

      const requiredEvidence = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What changed today?",
        routeEvidence: [
          { content: "REQUIRED CURRENT FACT MARKER", required: true, relevance: 1 },
          { content: repeated("LOW-RANKED-EVIDENCE", 800), required: false, relevance: 0 },
        ],
        tokenBudget: 500,
      });
      assert(requiredEvidence.prompt.includes("REQUIRED CURRENT FACT MARKER"), "route-required evidence is protected");
      assert(requiredEvidence.telemetry.droppedCounts.optional_evidence > 0, "low-ranked web evidence is removed first");

      const fileAwareCall = buildChatPrompt({
        userMessage: "Use the file and remember my formatting preference.",
        modelOverride: "gpt-oss-120b",
        memories: [{ type: "preference", summary: "Use compact bullet points.", importance: 9 }],
        workspaceCapsule: "The recurring workspace is Project Atlas.",
        conversationCapsule: "The current conversation selected milestone three.",
        fileReferences: [{ filename: "brief.txt", extractedText: "The brief contains three milestones." }],
      });
      assert(fileAwareCall.prompt.includes("Project Atlas"), "chat prompt carries workspace capsule context");
      assert(fileAwareCall.prompt.includes("selected milestone three"), "chat prompt carries conversation capsule context");
      assert(fileAwareCall.prompt.includes("Use compact bullet points."), "file-aware chat keeps relevant memory when budget allows");
      assert(fileAwareCall.prompt.includes("The brief contains three milestones."), "file-aware chat keeps selected file content");

      const oversizedCurrent = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: `MESSAGE-START ${repeated("middle", 2_000)} MESSAGE-END`,
        tokenBudget: 256,
      });
      assert(oversizedCurrent.telemetry.currentMessageTrimmed, "oversized current message is trimmed only as final safeguard");
      assert(oversizedCurrent.prompt.includes("MESSAGE-START"), "current message head is retained");
      assert(oversizedCurrent.prompt.includes("MESSAGE-END"), "current message tail is retained");
    },
  );

  const composeFree = (executionMode: "fast" | "intuitive", complexity: "normal" | "heavy") =>
    runWithRequestBudgetContext(
      { planCode: "free", executionMode, resolution: "billing" },
      () => composeContextDetailed({
        systemPrompt: "SYSTEM POLICY",
        userMessage: "CURRENT MESSAGE MUST REMAIN AVAILABLE",
        complexity,
        fileReferences: [{
          filename: "large-context.txt",
          extractedText: repeated("RELEVANT-CONTEXT", 12_000),
        }],
        conversation: Array.from({ length: 18 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: repeated(`HISTORY-${index}`, 180),
        })),
      }),
    );

  const freeFastOrdinary = composeFree("fast", "normal");
  const freeFastComplex = composeFree("fast", "heavy");
  const freeIntuitiveOrdinary = composeFree("intuitive", "normal");
  const freeIntuitiveComplex = composeFree("intuitive", "heavy");
  assert.equal(freeFastOrdinary.telemetry.inputContextCeilingTokens, 3_200);
  assert.equal(freeFastComplex.telemetry.inputContextCeilingTokens, 4_000);
  assert.equal(freeIntuitiveOrdinary.telemetry.inputContextCeilingTokens, 6_000);
  assert.equal(freeIntuitiveComplex.telemetry.inputContextCeilingTokens, 8_000);
  assert(freeFastOrdinary.telemetry.finalEstimatedInputTokens <= 3_200);
  assert(freeFastComplex.telemetry.finalEstimatedInputTokens <= 4_000);
  assert(freeIntuitiveOrdinary.telemetry.finalEstimatedInputTokens <= 6_000);
  assert(freeIntuitiveComplex.telemetry.finalEstimatedInputTokens <= 8_000);
  assert(
    freeIntuitiveOrdinary.telemetry.finalEstimatedInputTokens
      > freeFastOrdinary.telemetry.finalEstimatedInputTokens,
    "Free Intuitive ordinary retains more composed input than Free Fast ordinary",
  );
  assert(
    freeIntuitiveComplex.telemetry.finalEstimatedInputTokens
      > freeIntuitiveOrdinary.telemetry.finalEstimatedInputTokens,
    "Free Intuitive complex retains more composed input than Free Intuitive ordinary",
  );
  for (const composition of [
    freeFastOrdinary,
    freeFastComplex,
    freeIntuitiveOrdinary,
    freeIntuitiveComplex,
  ]) {
    assert(composition.prompt.includes("CURRENT MESSAGE MUST REMAIN AVAILABLE"));
  }

  console.log("Context composition Phase 2 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
