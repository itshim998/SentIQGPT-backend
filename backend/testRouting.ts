import {
  detectCodeQuery,
  detectLogicReasoning,
  detectMathReasoning,
  isBufferedReasoningQuery,
  selectModelForPrompt,
  isCodingPDF,
} from "./orchestrator/modelRouter";

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
    name: "Math equation routes to openai-large",
    query: "Solve 3x + 7 = 19",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: true,
    expectedModel: "openai-large",
  },
  {
    name: "Image math prompt routes to openai-large",
    query: "Solve it.",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: true,
    expectedModel: "openai-large",
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
    name: "Word problem routes to openai-large",
    query: "A factory makes 2 products with 3 machines and 8 labor hours. How many units maximize profit?",
    expectCode: false,
    expectMath: true,
    expectBufferedReasoning: true,
    expectedModel: "openai-large",
  },
  {
    name: "Logic proof prompt is buffered but keeps chat model",
    query: "Prove or disprove: if all bloops are razzies and all razzies are lazzies, then all bloops are lazzies.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: true,
    expectedModel: "gemini-search",
  },
  {
    name: "Normal chat routes to gemini-search",
    query: "Tell me a short story about spring rain.",
    expectCode: false,
    expectMath: false,
    expectBufferedReasoning: false,
    expectedModel: "gemini-search",
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

if (failed > 0) {
  console.error(`Routing validation failed: ${failed} case(s) failed.`);
  process.exit(1);
}

console.log("Routing validation passed.");
