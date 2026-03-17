import { detectCodeQuery, detectMathReasoning, selectModelForPrompt } from "./orchestrator/modelRouter";

type RoutingCase = {
  name: string;
  query: string;
  expectCode: boolean;
  expectMath: boolean;
  expectedModel: string;
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
    name: "Math equation routes to deepseek",
    query: "Solve 3x + 7 = 19",
    expectCode: false,
    expectMath: true,
    expectedModel: "deepseek",
  },
  {
    name: "Word problem routes to deepseek",
    query: "A factory makes 2 products with 3 machines and 8 labor hours. How many units maximize profit?",
    expectCode: false,
    expectMath: true,
    expectedModel: "deepseek",
  },
  {
    name: "Normal chat routes to gemini-fast",
    query: "Tell me a short story about spring rain.",
    expectCode: false,
    expectMath: false,
    expectedModel: "gemini-fast",
  },
];

let failed = 0;

for (const testCase of cases) {
  const codeDetected = detectCodeQuery(testCase.query);
  const mathDetected = detectMathReasoning(testCase.query);
  const model = selectModelForPrompt(testCase.query);

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

if (failed > 0) {
  console.error(`Routing validation failed: ${failed} case(s) failed.`);
  process.exit(1);
}

console.log("Routing validation passed.");
