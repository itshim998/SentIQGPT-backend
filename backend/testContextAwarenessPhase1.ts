import assert from "node:assert/strict";
import { CONVERSATION_WINDOW, compressConversation } from "./context/contextCompressor";
import { runWithRequestBudgetContext } from "./context/requestBudgetContext";
import {
  composeContextDetailed,
  detectContextQueryPolicy,
  type ComposerInput,
} from "./orchestrator/contextComposer";

function repeated(label: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${label}-${index}`).join(" ");
}

function occurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function policy(input: Partial<ComposerInput> & Pick<ComposerInput, "userMessage">): string {
  return detectContextQueryPolicy({ systemPrompt: "SYSTEM", ...input });
}

async function main(): Promise<void> {
  assert.equal(CONVERSATION_WINDOW, 20, "the builder must submit a 20-message candidate window");
  const twentyMessages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `message-${index}`,
  }));
  const uncompressed = await compressConversation(twentyMessages);
  assert.equal(uncompressed.recentMessages.length, 20);
  assert.equal(uncompressed.summary, undefined);

  assert.equal(policy({
    userMessage: "What should we do next?",
    conversation: twentyMessages,
  }), "direct_continuation");
  assert.equal(policy({
    userMessage: "What did I say about the rollout in our previous chat?",
    recallEvidenceRequired: true,
  }), "personal_recall");
  assert.equal(policy({
    userMessage: "What date is approved in the file?",
    fileReferences: [{ filename: "brief.pdf", extractedText: "18 August 2026" }],
  }), "file_question");
  assert.equal(policy({
    userMessage: "Summarize the entire document section by section.",
    fileReferences: [{ filename: "brief.pdf", extractedText: "content" }],
  }), "whole_document_summary");
  assert.equal(policy({
    userMessage: "Compare the differences across both files.",
    fileReferences: [
      { filename: "one.pdf", extractedText: "one" },
      { filename: "two.pdf", extractedText: "two" },
    ],
  }), "multi_file_comparison");
  assert.equal(policy({
    userMessage: "Answer from the search result.",
    routeEvidence: [{ content: "trusted result", required: true }],
  }), "tool_result");

  await runWithRequestBudgetContext(
    { planCode: "pro", executionMode: "fast", resolution: "billing" },
    async () => {
      const direct = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What should we do next?",
        conversationCapsule: "CAPSULE DECISION: deploy the API before the client.",
        conversation: [
          { role: "user", content: repeated("OLD-CONTEXT", 250) },
          { role: "assistant", content: repeated("OLD-ANSWER", 250) },
          { role: "user", content: "IMMEDIATE-PRECEDING-INSTRUCTION: keep minReplicas at zero." },
          { role: "assistant", content: "LATEST-ASSISTANT-ANSWER: the backend rollout is ready." },
        ],
        fileReferences: [{ filename: "large.txt", extractedText: repeated("FILE-NOISE", 2_000) }],
        tokenBudget: 650,
      });
      assert.equal(direct.telemetry.queryPolicy, "file_question", "a file-bearing continuation uses the file policy");
      assert(direct.prompt.includes("IMMEDIATE-PRECEDING-INSTRUCTION"));
      assert(direct.prompt.includes("LATEST-ASSISTANT-ANSWER"));
      assert(direct.telemetry.protectedRecentTurnsSelected >= 2);

      const pureDirect = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What should we do next?",
        conversationCapsule: "CAPSULE DECISION: deploy the API before the client.",
        conversation: [
          { role: "assistant", content: "MESSAGE-BEFORE-EXCHANGE" },
          { role: "user", content: "LATEST-USER-INSTRUCTION: keep minReplicas at zero." },
          { role: "assistant", content: "LATEST-ASSISTANT-ANSWER: the backend rollout is ready." },
        ],
        tokenBudget: 500,
      });
      assert.equal(pureDirect.telemetry.queryPolicy, "direct_continuation");
      assert(pureDirect.prompt.includes("MESSAGE-BEFORE-EXCHANGE"));
      assert(pureDirect.prompt.includes("LATEST-USER-INSTRUCTION"));
      assert(pureDirect.prompt.includes("LATEST-ASSISTANT-ANSWER"));
      assert(pureDirect.prompt.includes("CAPSULE DECISION"));

      const personalRecall = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What did I decide about the Atlas rollout earlier?",
        memories: [
          { type: "project", summary: "ATLAS-EXACT-MEMORY: staged rollout with minReplicas zero.", relevance: 1 },
          { type: "preference", summary: repeated("UNRELATED-PREFERENCE", 250), relevance: 0.1 },
        ],
        recallEvidence: [{
          content: "PRIOR-EVIDENCE: the API must deploy before the client.",
          relevance: 1,
        }],
        workspaceCapsule: "WORKSPACE-CAPSULE: Project Atlas owns the rollout.",
        fileReferences: [{ filename: "noise.txt", extractedText: repeated("FILE-NOISE", 2_000) }],
        tokenBudget: 650,
      });
      assert.equal(personalRecall.telemetry.queryPolicy, "file_question", "attached sources retain file-question semantics");

      const recallWithoutFile = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What did I decide about the Atlas rollout earlier?",
        memories: [{ type: "project", summary: "ATLAS-EXACT-MEMORY: staged rollout.", relevance: 1 }],
        recallEvidence: [{ content: "PRIOR-EVIDENCE: API before client.", relevance: 1 }],
        workspaceCapsule: "WORKSPACE-CAPSULE: Atlas rollout.",
        tokenBudget: 450,
      });
      assert.equal(recallWithoutFile.telemetry.queryPolicy, "personal_recall");
      assert(recallWithoutFile.prompt.includes("ATLAS-EXACT-MEMORY"));
      assert(recallWithoutFile.prompt.includes("PRIOR-EVIDENCE"));
      assert(recallWithoutFile.prompt.includes("WORKSPACE-CAPSULE"));

      const middleConstraint = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: [
          repeated("HEAD", 1_000),
          "CONSTRAINT: DO NOT CHANGE ANY AI MODEL PROVIDER SETTINGS.",
          "REQUIRED DELIVERABLE: return a complete implementation and regression tests.",
          repeated("TAIL", 1_000),
        ].join("\n"),
        tokenBudget: 420,
      });
      assert(middleConstraint.telemetry.currentMessageTrimmed);
      assert(middleConstraint.prompt.includes("DO NOT CHANGE ANY AI MODEL PROVIDER SETTINGS"));
      assert(middleConstraint.prompt.includes("complete implementation and regression tests"));

      const elasticFile = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What does the attached source say about ELASTIC-ANSWER?",
        fileReferences: [{
          filename: "source.txt",
          extractedText: `ELASTIC-ANSWER: retain the relevant source even when it must shrink. ${repeated("DETAIL", 1_000)}`,
          retrieved: true,
          relevance: 1,
          sourceChunkCount: 1,
        }],
        conversation: [
          { role: "user", content: "RECENT-INSTRUCTION: answer in two bullets." },
          { role: "assistant", content: "Acknowledged." },
        ],
        tokenBudget: 430,
      });
      assert(elasticFile.prompt.includes("ELASTIC-ANSWER"));
      assert(elasticFile.prompt.includes("context block truncated to the available request budget"));
      assert(elasticFile.telemetry.elasticBlocksReduced >= 1);
      assert(elasticFile.prompt.includes("RECENT-INSTRUCTION"));

      const deduplicated = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "Continue the rollout plan.",
        memories: [{
          type: "project",
          summary: "DUPLICATE-FACT: deploy the API before the client. UNIQUE-MEMORY-FACT: keep rollback ready.",
          relevance: 1,
        }],
        workspaceCapsule: "DUPLICATE-FACT: deploy the API before the client. UNIQUE-WORKSPACE-FACT: rollout is staged.",
        conversationCapsule: "DUPLICATE-FACT: deploy the API before the client. UNIQUE-CAPSULE-FACT: canary first.",
        conversation: [
          { role: "user", content: "DUPLICATE-FACT: deploy the API before the client." },
          { role: "assistant", content: "LATEST-UNIQUE-TURN: readiness checks passed." },
        ],
        tokenBudget: 900,
      });
      assert(deduplicated.telemetry.deduplicatedSegments >= 1);
      assert(occurrences(deduplicated.prompt, "DUPLICATE-FACT") <= 2,
        "repeated capsule, memory, and older-turn facts must not consume every section");
      assert(deduplicated.prompt.includes("UNIQUE-MEMORY-FACT"));
      assert(deduplicated.prompt.includes("LATEST-UNIQUE-TURN"));

      const wholeDocument = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "Summarize the entire document section by section in a table.",
        fileReferences: [{
          filename: "report.txt",
          extractedText: [
            `BEGINNING-SECTION ${repeated("opening", 900)}`,
            `MIDDLE-SECTION ${repeated("middle", 900)}`,
            `FINAL-SECTION ${repeated("ending", 900)}`,
          ].join("\n"),
        }],
        tokenBudget: 1_500,
      });
      assert.equal(wholeDocument.telemetry.queryPolicy, "whole_document_summary");
      assert(wholeDocument.prompt.includes("DOCUMENT MAP"));
      assert(wholeDocument.prompt.includes("report.txt"));
      assert(wholeDocument.telemetry.selectedCounts.file_chunks >= 2,
        "whole-document summaries require section-diverse excerpts");

      const comparison = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "Compare the differences across both files.",
        fileReferences: [
          { filename: "alpha.txt", extractedText: `ALPHA-UNIQUE ${repeated("alpha", 700)}` },
          { filename: "beta.txt", extractedText: `BETA-UNIQUE ${repeated("beta", 700)}` },
        ],
        tokenBudget: 900,
      });
      assert.equal(comparison.telemetry.queryPolicy, "multi_file_comparison");
      assert(comparison.prompt.includes("ALPHA-UNIQUE"));
      assert(comparison.prompt.includes("BETA-UNIQUE"));

      const toolResult = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What changed today?",
        routeEvidence: [{
          label: "web result",
          content: `REQUIRED-TOOL-EVIDENCE ${repeated("tool", 80)}`,
          required: true,
          relevance: 1,
        }],
        conversation: [
          { role: "user", content: "RECENT-TOOL-INSTRUCTION: focus only on pricing." },
          { role: "assistant", content: "Understood." },
        ],
        memories: [{ type: "preference", summary: repeated("OPTIONAL-PERSONAL", 300), relevance: 0.2 }],
        tokenBudget: 550,
      });
      assert.equal(toolResult.telemetry.queryPolicy, "tool_result");
      assert(toolResult.prompt.includes("REQUIRED-TOOL-EVIDENCE"));
      assert(toolResult.prompt.includes("RECENT-TOOL-INSTRUCTION"));
      assert.equal(toolResult.telemetry.requiredEvidenceItemsRemoved, 0);

      const diverseMemories = composeContextDetailed({
        systemPrompt: "SYSTEM",
        userMessage: "What do you remember about the rollout?",
        memories: [
          { type: "project", summary: `ROLLBACK-FACT ${repeated("same rollout wording", 80)}`, relevance: 1 },
          { type: "project", summary: `ROLLBACK-FACT-COPY ${repeated("same rollout wording", 80)}`, relevance: 0.99 },
          { type: "project", summary: "COMPLEMENTARY-CANARY-FACT: canary traffic must be checked separately.", relevance: 0.8 },
        ],
        tokenBudget: 420,
      });
      assert(diverseMemories.prompt.includes("COMPLEMENTARY-CANARY-FACT"),
        "deterministic MMR must preserve complementary evidence before a near-duplicate crowds it out");
    },
  );

  console.log("Contextual-awareness Phase 1 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
