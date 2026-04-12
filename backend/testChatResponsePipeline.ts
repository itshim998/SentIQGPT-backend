import { finalizeMathReply } from "./ai/mathAnswerFinalizer";
import {
  extractUserFacingAnswer,
  finalizeUserFacingReply,
  DEFAULT_SAFE_REPLY_FALLBACK,
} from "./ai/replyGuard";
import { normalizeMathResponse, salvageTruncatedResponse } from "./ai/mathVerifier";

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

const providerFailureBlob = JSON.stringify({
  error: "provider_failed",
  provider: "gemini",
  detail: "All providers failed.",
});

const cleanReply = "Neural networks learn patterns by adjusting weights during training.";

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

assert(
  finalizeUserFacingReply(providerFailureBlob) === DEFAULT_SAFE_REPLY_FALLBACK,
  "provider failure blob is blocked and replaced with safe fallback",
);

assert(finalizeUserFacingReply(cleanReply) === cleanReply, "clean reply remains intact");

const finalizedMath = finalizeMathReply(normalizeMathResponse(noisyMathReply));
assert(!/we need to solve/i.test(finalizedMath), "math narrative leakage removed");
assert(!/let me check/i.test(finalizedMath), "math self-talk removed");
assert(/x \+ y = 3/.test(finalizedMath), "math equations preserved");
assert(/x = 3, y = 0/.test(finalizedMath), "math final answer preserved");

const salvagedMath = salvageTruncatedResponse(truncatedMathReply);
assert(/z = 1/.test(salvagedMath) && /y = 0/.test(salvagedMath), "truncated math keeps valid solved prefix");
assert(/\[Response truncated before completion\./.test(salvagedMath), "truncated math appends concise truncation notice");

console.log("\nChat response pipeline validation passed.");
