import {
  detectCodeQuery,
  detectLogicReasoning,
  detectMathReasoning,
  isBufferedReasoningQuery,
  selectModelForPrompt,
  isCodingPDF,
} from "./orchestrator/modelRouter";
import { buildChatPrompt, selectGroqReasoningEffortForMessage } from "./ai/PromptBuilders";

type RoutingCase = {
  name: string;
  query: string;
  expectCode: boolean;
  expectMath: boolean;
  expectBufferedReasoning: boolean;
  expectedModel: string;
  options?: { hasFile?: boolean; hasImage?: boolean; fileNames?: string[]; fileContent?: string };
};

const cases: readonly RoutingCase[] = [
  {
    name: "Python debugging routes to qwen-coder",
    query: "Why is this Python calculator code not printing anything?",
    expectCode: true,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "qwen-coder",
  },
  {
    name: "Math equation stays on normal chat model",
    query: "Solve 3x + 7 = 19",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Image math prompt uses normal vision route",
    query: "Solve it.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gemini-search",
    options: { hasImage: true },
  },
  {
    name: "Image coding prompt routes to qwen-coder",
    query: "Debug this Python error screenshot.",
    expectCode: true,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "qwen-coder",
    options: { hasImage: true },
  },
  {
    name: "General image prompt routes to gemini-search",
    query: "What is shown here?",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gemini-search",
    options: { hasImage: true },
  },
  {
    name: "Word problem stays on normal chat model",
    query: "A factory makes 2 products with 3 machines and 8 labor hours. How many units maximize profit?",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "False position method stays on normal chat model",
    query: "Use the False Position Method to solve x^3 - 4x - 9 = 0 step by step.",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Gauss elimination stays on normal chat model",
    query: "Solve this system using Gauss elimination for linear equations.",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Academic probability and fuzzy logic comparison stays normal chat",
    query: "Detail the core difference between regular probability and fuzzy logic. How do they handle uncertainty differently? 4 marks",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Numeric probability calculation stays on normal chat model",
    query: "Calculate the probability of getting exactly 2 heads in 4 coin tosses.",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Missionaries and Cannibals is logic, not math",
    query: "Solve this step by step: The Missionaries and Cannibals problem has 3 missionaries and 3 cannibals crossing a river in a boat.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Logic proof prompt stays on normal chat model",
    query: "Prove or disprove: if all bloops are razzies and all razzies are lazzies, then all bloops are lazzies.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "Normal chat routes to gpt-oss-120b",
    query: "Tell me a short story about spring rain.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gpt-oss-120b",
  },
  {
    name: "File upload (non-coding) routes to gemini-search",
    query: "Summarize this document",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gemini-search",
    options: { hasFile: true, fileNames: ["report.pdf"], fileContent: "This is a business report about Q4 earnings." },
  },
  {
    name: "Coding PDF routes to qwen-coder",
    query: "Explain the code in this PDF",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "qwen-coder",
    options: { hasFile: true, fileNames: ["python-tutorial.pdf"], fileContent: "def hello_world():\n    print('Hello')" },
  },
];

let failed = 0;

for (const testCase of cases) {
  const codeDetected = detectCodeQuery(testCase.query);
  const mathDetected = detectMathReasoning(testCase.query);
  const logicDetected = detectLogicReasoning(testCase.query);
  const bufferedReasoning = isBufferedReasoningQuery(testCase.query);
  const model = selectModelForPrompt(testCase.query, undefined, testCase.options);

  const passed =
    codeDetected === testCase.expectCode &&
    mathDetected === testCase.expectMath &&
    bufferedReasoning === testCase.expectBufferedReasoning &&
    model === testCase.expectedModel;

  console.log(
    `${passed ? "PASS" : "FAIL"} | ${testCase.name} | code=${codeDetected} math=${mathDetected} logic=${logicDetected} buffered=${bufferedReasoning} model=${model}`,
  );

  if (!passed) {
    failed += 1;
  }
}

// Additional test for isCodingPDF function
console.log("\n--- Coding PDF Detection Tests ---");
const codingPdfTests = [
  { names: ["python-tutorial.pdf"], content: "", expected: true },
  { names: ["algorithm-guide.pdf"], content: "", expected: true },
  { names: ["business-report.pdf"], content: "", expected: false },
  { names: ["document.pdf"], content: "def foo():\n  return 42", expected: true },
  { names: ["notes.pdf"], content: "Meeting notes for Q4", expected: false },
];

for (const test of codingPdfTests) {
  const result = isCodingPDF(test.names, test.content);
  const passed = result === test.expected;
  console.log(`${passed ? "PASS" : "FAIL"} | isCodingPDF(${test.names[0]}) = ${result}, expected ${test.expected}`);
  if (!passed) failed++;
}

console.log("\n--- GPT-OSS Reasoning Effort Tests ---");
const lowEffortCall = buildChatPrompt({
  userMessage: "Tell me a joke.",
  modelOverride: "gpt-oss-120b",
});
if (lowEffortCall.reasoning_effort !== "low") {
  console.error(`FAIL | short plain GPT-OSS chat expected low, got ${lowEffortCall.reasoning_effort}`);
  failed++;
} else {
  console.log("PASS | short plain GPT-OSS chat uses low reasoning effort");
}

const mediumEffortCall = buildChatPrompt({
  userMessage: "Compare React and Vue in detail, including trade-offs and recommendations.",
  modelOverride: "gpt-oss-120b",
});
if (mediumEffortCall.reasoning_effort !== "medium") {
  console.error(`FAIL | complex GPT-OSS chat expected medium, got ${mediumEffortCall.reasoning_effort}`);
  failed++;
} else {
  console.log("PASS | complex GPT-OSS chat uses medium reasoning effort");
}

const geminiSearchCall = buildChatPrompt({
  userMessage: "Tell me a joke.",
  modelOverride: "gemini-search",
});
if (geminiSearchCall.reasoning_effort !== undefined) {
  console.error(`FAIL | gemini-search should not set reasoning effort, got ${geminiSearchCall.reasoning_effort}`);
  failed++;
} else {
  console.log("PASS | gemini-search does not set GPT-OSS reasoning effort");
}

const qwenCoderCall = buildChatPrompt({
  userMessage: "Why is this Python loop failing?",
  modelOverride: "qwen-coder",
});
if (qwenCoderCall.reasoning_effort !== undefined) {
  console.error(`FAIL | qwen-coder should not set reasoning effort, got ${qwenCoderCall.reasoning_effort}`);
  failed++;
} else {
  console.log("PASS | coding route does not set GPT-OSS reasoning effort");
}

if (selectGroqReasoningEffortForMessage("One line?\nSecond line?") !== "medium") {
  console.error("FAIL | multi-line prompt should use medium reasoning effort");
  failed++;
} else {
  console.log("PASS | multi-line prompt uses medium reasoning effort");
}

if (failed > 0) {
  console.error(`Routing validation failed: ${failed} case(s) failed.`);
  process.exit(1);
}

console.log("Routing validation passed.");
