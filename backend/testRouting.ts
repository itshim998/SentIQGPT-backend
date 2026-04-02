import { detectCodeQuery, detectMathReasoning, selectModelForPrompt, isCodingPDF } from "./orchestrator/modelRouter";

type RoutingCase = {
  name: string;
  query: string;
  expectCode: boolean;
  expectMath: boolean;
  expectedModel: string;
  options?: { hasFile?: boolean; hasImage?: boolean; fileNames?: string[]; fileContent?: string };
};

const cases: readonly RoutingCase[] = [
  {
    name: "Python debugging routes to qwen-coder",
    query: "Why is this Python calculator code not printing anything?",
    expectCode: true,
    expectMath: false,
    expectedModel: "qwen-coder",
  },
  {
    name: "Math equation routes to minimax",
    query: "Solve 3x + 7 = 19",
    expectCode: false,
    expectMath: true,
    expectedModel: "minimax",
  },
  {
    name: "Word problem routes to minimax",
    query: "A factory makes 2 products with 3 machines and 8 labor hours. How many units maximize profit?",
    expectCode: false,
    expectMath: true,
    expectedModel: "minimax",
  },
  {
    name: "Normal chat routes to mistral",
    query: "Tell me a short story about spring rain.",
    expectCode: false,
    expectMath: false,
    expectedModel: "mistral",
  },
  {
    name: "File upload (non-coding) routes to gemini-fast",
    query: "Summarize this document",
    expectCode: false,
    expectMath: false,
    expectedModel: "gemini-fast",
    options: { hasFile: true, fileNames: ["report.pdf"], fileContent: "This is a business report about Q4 earnings." },
  },
  {
    name: "Coding PDF routes to qwen-coder",
    query: "Explain the code in this PDF",
    expectCode: false,
    expectMath: false,
    expectedModel: "qwen-coder",
    options: { hasFile: true, fileNames: ["python-tutorial.pdf"], fileContent: "def hello_world():\n    print('Hello')" },
  },
];

let failed = 0;

for (const testCase of cases) {
  const codeDetected = detectCodeQuery(testCase.query);
  const mathDetected = detectMathReasoning(testCase.query);
  const model = selectModelForPrompt(testCase.query, undefined, testCase.options);

  const passed =
    codeDetected === testCase.expectCode &&
    mathDetected === testCase.expectMath &&
    model === testCase.expectedModel;

  console.log(
    `${passed ? "PASS" : "FAIL"} | ${testCase.name} | code=${codeDetected} math=${mathDetected} model=${model}`,
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
