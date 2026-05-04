import { finalizeReply, mergeResults } from "./orchestrator/aiOrchestrator";
import type { StepResult } from "./orchestrator/toolExecutor";

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}${detail ? ` | ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

const rawOpenAiLargeReply = [
  "That means we can iterate through possible values.",
  "Final Answer: Keep this wording untouched.",
].join("\n");

const merged = mergeResults(
  [
    {
      step: 1,
      tool: "conversation",
      reply: rawOpenAiLargeReply,
      model_used: "openai-large",
      sanitize_bypass: true,
    } satisfies StepResult,
  ],
  { stored: false },
);

assert((merged as { _sanitize_bypass?: boolean })._sanitize_bypass === true, "mergeResults carries sanitize bypass metadata");

const finalizedRawReply = finalizeReply(
  merged.reply,
  "Sorry, something went wrong. Please try again.",
  (merged as { _sanitize_bypass?: boolean })._sanitize_bypass === true,
);

assert(finalizedRawReply === rawOpenAiLargeReply, "orchestrator finalizer preserves raw openai-large replies");

const sanitizedNormalReply = finalizeReply(rawOpenAiLargeReply);
assert(sanitizedNormalReply !== rawOpenAiLargeReply, "standard orchestrator finalizer still sanitizes normal replies");

const mathMerged = mergeResults(
  [
    {
      step: 1,
      tool: "conversation",
      reply: "Final Answer: x = 2",
      isMathResult: true,
      model_used: "openai-large",
      sanitize_bypass: true,
    } satisfies StepResult,
  ],
  { stored: false },
);

assert(mathMerged.route === "math_reasoning", "mergeResults preserves math route");
assert((mathMerged as { _sanitize_bypass?: boolean })._sanitize_bypass === true, "math results remain marked as raw");

console.log("\nOrchestrator reply finalization validation passed.");
