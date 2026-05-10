import {
  composeUserFacingReply,
  extractUserFacingAnswer,
  finalizeStructuredReply,
  finalizeUserFacingReply,
  DEFAULT_SAFE_REPLY_FALLBACK,
} from "./ai/replyGuard";
import { salvageTruncatedResponse } from "./ai/mathVerifier";

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}${detail ? ` | ${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

const plainTextLeak = [
  "I will solve this step by step.",
  "Let's think about the best approach first.",
  "The solution is 42 because 6 x 7 = 42.",
].join(" ");

const rawJsonReply = JSON.stringify({
  reply: "The derivative of x^2 is 2x.",
});

const fencedJsonAnswer = [
  "```json",
  JSON.stringify({ answer: "The determinant is 5." }),
  "```",
].join("\n");

const finalAnswerJson = JSON.stringify({
  final_answer: "The system has the unique solution x = 3, y = 0, z = 1.",
  disclaimer: "Custom disclaimer.",
});

const explanationJson = JSON.stringify({
  explanation: "Step 1: Write the augmented matrix.\nStep 2: Eliminate x from rows 2 and 3.\nStep 3: Use back substitution to solve for z, y, and x.",
  final_answer: "x = 3, y = 0, z = 1",
});

const providerFailureBlob = JSON.stringify({
  error: "provider_failed",
  provider: "gemini",
  detail: "All providers failed.",
});

const cleanReply = "Neural networks learn patterns by adjusting weights during training.";

const thinkAndFinalReply = `
<think>
I'll compare the two approaches and settle on one.
</think>
Final Answer:
Use binary search because the input is sorted.
`;

const malformedThinkReply = `
<think>
First I evaluate multiple strategies
Final Answer:
Use BFS for shortest unweighted path.
`;

const thinkWithoutFinal = `
<think>
Let's evaluate each option and pick one.
</think>
That means we can iterate through alternatives before deciding.
`;

const truncatedThinkReply = `
<think>
I'll test several branches and compare them before answering.
</think>
Final Answer:
The best choice is option B because it preserves the invariant.
`;

const latexMathReply = "x^2 = 9\nx = \\pm 3";

const leakyFinalPhrases = [
  "That means we can iterate through possible values.",
  "Alternatively, we can iterate over every item.",
  "Final Answer: Use a hash map for O(1) lookups.",
].join("\n");

const noisyMathReply = `
We need to solve this carefully before writing the result.
Let me check the setup once more.

x + y = 3
2x - y = 6

Final Answer: x = 3, y = 0
`;

const truncatedMathReply = `
Step 1: Eliminate y from the second equation.
z = 1
y = 0
x = 3
Therefore the solution is x = 3, y = 0, z =
`;

const finalizedLeak = finalizeUserFacingReply(plainTextLeak);
assert(!/i will solve/i.test(finalizedLeak), "plain-text leakage preamble removed");
assert(!/let's think/i.test(finalizedLeak), "plain-text self-talk removed");
assert(/solution is 42/i.test(finalizedLeak), "plain-text answer preserved");

assert(finalizeUserFacingReply(rawJsonReply) === "The derivative of x^2 is 2x.", "raw JSON reply extracted");
assert(finalizeUserFacingReply(fencedJsonAnswer) === "The determinant is 5.", "fenced JSON answer extracted");

const extractedFinalAnswer = extractUserFacingAnswer(finalAnswerJson);
assert(extractedFinalAnswer.reply === "The system has the unique solution x = 3, y = 0, z = 1.", "final_answer key extracted");
assert(extractedFinalAnswer.disclaimer === "Custom disclaimer.", "disclaimer extracted from JSON envelope");

const extractedExplanation = extractUserFacingAnswer(explanationJson);
assert(extractedExplanation.explanation?.includes("Step 1: Write the augmented matrix.") ?? false, "structured explanation extracted");
assert(extractedExplanation.finalAnswer === "x = 3, y = 0, z = 1", "structured final answer extracted");
assert(
  composeUserFacingReply(extractedExplanation, { preferExplanation: true })?.includes("Final Answer") ?? false,
  "structured explanation composes into explanation plus final answer",
);
assert(
  finalizeStructuredReply(explanationJson, { sanitizeMode: "minimal" }).answer.includes("x = 3, y = 0, z = 1"),
  "minimal finalizer returns final answer without forcing explanation",
);

assert(
  finalizeUserFacingReply(providerFailureBlob) === DEFAULT_SAFE_REPLY_FALLBACK,
  "provider failure blob is blocked and replaced with safe fallback",
);

assert(finalizeUserFacingReply(cleanReply) === cleanReply, "clean reply remains intact");

const extractedThink = extractUserFacingAnswer(thinkAndFinalReply);
assert(extractedThink.thinking?.includes("compare the two approaches") ?? false, "think block extracted into thinking channel");
assert(extractedThink.reply === "Use binary search because the input is sorted.", "final answer extracted after marker");

const finalizedThink = finalizeStructuredReply(thinkAndFinalReply);
assert(finalizedThink.answer === "Use binary search because the input is sorted.", "structured finalizer returns clean answer");
assert(finalizedThink.thinking?.includes("compare the two approaches") ?? false, "structured finalizer returns optional thinking");

const truncatedThinkFinalized = finalizeStructuredReply(truncatedThinkReply, { truncated: true });
assert(/option B/i.test(truncatedThinkFinalized.answer), "truncated structured finalizer preserves valid final answer");
assert(!truncatedThinkFinalized.thinking, "truncated structured finalizer drops partial thinking");

const finalizedMalformedThink = finalizeStructuredReply(malformedThinkReply);
assert(/use bfs/i.test(finalizedMalformedThink.answer), "malformed think output degrades gracefully to usable final answer");

const blockedThinkWithoutFinal = finalizeUserFacingReply(thinkWithoutFinal);
assert(blockedThinkWithoutFinal === DEFAULT_SAFE_REPLY_FALLBACK, "thinking without final answer falls back safely");

const cleanedLeakPhrases = finalizeUserFacingReply(leakyFinalPhrases);
assert(!/that means/i.test(cleanedLeakPhrases), "final answer leakage phrase 'that means' removed");
assert(!/alternatively/i.test(cleanedLeakPhrases), "final answer leakage phrase 'alternatively' removed");
assert(/hash map/i.test(cleanedLeakPhrases), "final answer content preserved after leakage cleanup");

const relaxedThinkReply = "<think>hidden reasoning</think>\nHere is the answer.";
const relaxedFinalized = finalizeStructuredReply(relaxedThinkReply, { sanitizeMode: "minimal" });
assert(relaxedFinalized.answer === "Here is the answer.", "minimal sanitizer strips think blocks");

const unsanitizedOpenAiLargeReply = [
  "That means we can iterate through each case.",
  "Final Answer: Keep every line exactly as returned.",
].join("\n");
const unsanitizedFinalized = finalizeStructuredReply(unsanitizedOpenAiLargeReply, { sanitizeMode: "none" });
assert(unsanitizedFinalized.answer === unsanitizedOpenAiLargeReply, "no-sanitize mode preserves raw reply text");
assert(unsanitizedFinalized.thinking === undefined, "no-sanitize mode does not split thinking");

const unsanitizedProviderFailure = finalizeStructuredReply(providerFailureBlob, { sanitizeMode: "none" });
assert(unsanitizedProviderFailure.answer === DEFAULT_SAFE_REPLY_FALLBACK, "no-sanitize mode still blocks provider failure payloads");

const salvagedMath = salvageTruncatedResponse(truncatedMathReply);
assert(/z = 1/.test(salvagedMath) && /y = 0/.test(salvagedMath), "truncated math keeps valid solved prefix");
assert(!/Response truncated before completion/.test(salvagedMath), "truncated math omits user-facing truncation notice");

console.log("\nChat response pipeline validation passed.");
