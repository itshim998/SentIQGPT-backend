import { formatMathResponse } from "./ai/mathFormatter";
import { classifyMathIntent, normalizeMathResponse } from "./ai/mathVerifier";
import { shouldRewriteMathResponse } from "./ai/responseShaper";
import { selectModelForPrompt } from "./orchestrator/modelRouter";

const leakedTrainAnswer = `
Let me solve this 2. Let: 3. - Distance between A and B = D 4. - Speed of train from A = v1 5. - Speed of train from B = v2 6. - They meet at the halfway point, so each travels D/2 7. Time to meet for train from A: t = (D/2)/v1 = D/(2v1) 8. Time to meet for train from B: t = (D/2)/v2 = D/(2v2) 9. Since they leave at the same time and meet simultaneously: 10. D/(2v1) = D/(2v1) = D/(2v2) 11. So v1 = v2? Wait, that doesn't make sense with the different times after meeting 12. Let me reconsider 13. They meet at the halfway point, so both travel D/2 to the meeting point 14. After meeting: 15. - Train from A travels the remaining D/2 to B in 2 hours 16. - Train from B travels the remaining D/2 to A in 8 hours 17. So: 18. v1 = (D/2)/2 = D/4 19. v2 = (D/2)/8 = D/16 20. So v1/v2 = (D/4)/(D/16) = 16/4 = 4 21. The train from A is 4 times faster than the train from B 22. Let me verify: 23. - Both travel D/2 to meet 24. - Time for train A to travel D/2: (D/2)/(D/4) = 2 hours 25. - Time for train B to travel D/2: (D/2)/(D/16) = 8 hours 26. Yes! They meet after 2 hours (train A) and 8 hours (train B)? No wait, that's not right 27. If they meet at the halfway point, the time to reach the meeting point must be the same for both 28. Let t be the time until they meet 29. For train A: D/2 = v1t 30. For train B: D/2 = v2t 31. So v1 = D/(2t) and v2 = D/(2t) 32. After meeting, the remaining distances are both D/2, and the travel times are 2 and 8 hours respectively 33. This gives me v1 = D/4 and v2 = D/16, which means v1/v2 = 4 34. The train from A is four times faster than the train from B 35. But wait-if train A is faster, it should reach the meeting point sooner than train B 36. Yet they meet at the same time, so something's off 37. Let me verify this works: if v1 = D/4 and v2 = D/16, train A takes (D/2)/(D/4) = 2 hours to reach the midpoint, and train B takes (D/2)/(D/16) = 8 hours 38. These aren't equal, so they can't actually meet at the same time with these speeds
`;

const structuredAnswer = `
### Key Insight
- Both trains cover the same remaining distance after meeting.

### Solution
- Train A covers \\(D/2\\) in 2 hours, so \\(v_1 = (D/2)/2 = D/4\\).
- Train B covers \\(D/2\\) in 8 hours, so \\(v_2 = (D/2)/8 = D/16\\).
- Therefore, \\(v_1 / v_2 = 4\\).

### Final Answer
Train A is 4 times as fast as Train B.
`;

const latexAnswer = String.raw`
Train A's speed ratio can be written as \[
\frac{v_1}{v_2} = \frac{(D/2)/2}{(D/2)/8} = 4
\]
Final answer: Train A is 4 times faster.
`;

const promptEchoAnswer = `
Key Insight

- Key Insight

Solution

- One direct line.
- So they show a bullet for Final Answer as well. So we should include a bullet. So we should output:
- That matches the format: bullet for final answer.
- We need to ensure we don't include any extra text.
- State after H = (|0> + |1>)/sqrt(2).
- We should also check that we didn't include any chain-of-th.

Final Answer

final answer is a bullet with the state.
`;

const narrativeTrainAnswer = `
### Key Insight
- We need to solve a typical relative speed problem. Two trains start simultaneously from opposite ends and meet halfway.

### Solution
- 3. (D - x)/v1 =
- 4. x/v2 =
- We have 4 equations, 5 unknowns. We can solve for ratios. Let's express everything in terms of x and D. From (3): D - x = 2 v1 and From (4): x = 8 v2.
- Also from (1): t = x / v1 = x / ((D - x)/2) = 2x/(D - x). From (2): t = (D - x)/v2 = (D - x)/(x/8) = 8(D - x)/x.
- 2x/(D - x) = 8(D - x)/x => 2x * x = 8(D - x) * (D - x) => x = 2(D - x). Solve: x = 2D/3.

### Final Answer
v1 = (D/2)/2 = D/4, v2 = (D/2)/8 = D/16. So v1/v2 = 4, so train 1 is 4 times faster than train 2.
`;

const rewriteTriggerAnswer = `
### Solution
- We need to solve the setup carefully before doing the algebra.
- We can rewrite the expressions in a cleaner form and check each one.
- From here we can compare the two ratios directly.
- x / v1 = 2x / (D - x)
- (D - x) / v2 = 8(D - x) / x
- Therefore the ratio is 4.

### Final Answer
Train A is 4 times faster.
`;

const cleanShortAnswer = `
### Solution
- v1 = (D/2)/2 = D/4
- v2 = (D/2)/8 = D/16

### Final Answer
Train A is 4 times faster than Train B.
`;

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

function includesNone(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => !pattern.test(text));
}

const normalizedLeaked = normalizeMathResponse(leakedTrainAnswer);
console.log("\nNormalized leaked sample:\n");
console.log(normalizedLeaked);
console.log("\n----\n");

assert(/^### Solution/m.test(normalizedLeaked) || /^### Key Insight/m.test(normalizedLeaked), "leaked sample is reformatted into markdown sections");
assert(/^### Final Answer/m.test(normalizedLeaked), "leaked sample has a final answer section");
assert(includesNone(normalizedLeaked, [
  /\bwait\b/i,
  /\blet me reconsider\b/i,
  /\blet me verify\b/i,
  /\bsomething's off\b/i,
  /\bno wait\b/i,
]), "leaked sample removes self-talk and contradiction phrases");
assert(/4 times faster|four times faster/i.test(normalizedLeaked), "leaked sample preserves the correct train-speed conclusion");

const normalizedStructured = normalizeMathResponse(structuredAnswer);
assert(/^### Key Insight/m.test(normalizedStructured), "well-structured answer keeps the key insight heading");
assert(/Train A is 4 times as fast as Train B\./i.test(normalizedStructured), "well-structured answer preserves the final answer");

const normalizedLatex = normalizeMathResponse(latexAnswer);
const formattedLatex = formatMathResponse(latexAnswer);
assert(formattedLatex.includes("$$") && formattedLatex.includes("\\frac{v_1}{v_2}"), "LaTeX display math is preserved and normalized");
assert(
  /Train A is 4 times faster/i.test(normalizedLatex) || /\\frac\{v_1\}\{v_2\}/.test(normalizedLatex),
  "LaTeX answer stays readable even without forced section headings",
);

const normalizedPromptEcho = normalizeMathResponse(promptEchoAnswer);
assert(includesNone(normalizedPromptEcho, [
  /\bone direct line\b/i,
  /\bwe should output\b/i,
  /\bbullet for final answer\b/i,
  /\bchain-of-th(?:ought)?\b/i,
]), "prompt-echo sample removes formatting commentary");
assert(/\(\|0\>\s*\+\s*\|1\>\)\/sqrt\(2\)/i.test(normalizedPromptEcho), "prompt-echo sample preserves the actual math state");

const normalizedNarrative = normalizeMathResponse(narrativeTrainAnswer);
assert(includesNone(normalizedNarrative, [
  /\bwe need to\b/i,
  /\blet'?s\b/i,
  /\bwe can\b/i,
  /\btypical relative speed problem\b/i,
]), "narrative sample removes formal narration");
assert(/D - x = 2 v1/i.test(normalizedNarrative) || /2x\/\(D - x\)/i.test(normalizedNarrative), "narrative sample preserves the actual equations");
assert(/4 times faster/i.test(normalizedNarrative), "narrative sample preserves the final answer");

assert(shouldRewriteMathResponse(rewriteTriggerAnswer), "noisy narrative answer is marked for one rewrite fallback");
assert(!shouldRewriteMathResponse(cleanShortAnswer), "clean short answer does not trigger rewrite fallback");

assert(classifyMathIntent("Solve a quantum computing math as an example.") === "example", "example-style solve prompt routes to example math intent");
assert(classifyMathIntent("Give me a quantum computing math example and solve it.") === "example", "explicit example-and-solve prompt routes to example math intent");
assert(classifyMathIntent("Solve 3x + 7 = 19") === "solve", "concrete math solve prompt stays on solve intent");
assert(selectModelForPrompt("Solve 3x + 7 = 19") === "minimax", "concrete solve prompt still routes to minimax");

console.log("\nMath response shaping validation passed.");
