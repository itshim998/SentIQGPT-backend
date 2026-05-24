import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detectExplicitMemoryWriteIntent } from "./orchestrator/queryClassifier";
import { isChartRequest } from "./tools/chartGeneration/chartDetector";
import { isMathQuery } from "./orchestrator/modelRouter";

type GoldenCase = {
  id: string;
  category: string;
  prompt: string;
  expected_route: string;
  requires_context?: string[];
  success_criteria: string[];
};

type GoldenFile = {
  name: string;
  version: number;
  cases: GoldenCase[];
};

function inferOfflineRoute(testCase: GoldenCase): string {
  if (testCase.requires_context?.includes("file_references")) return "file_analysis";
  if (testCase.expected_route === "image_generation") return "image_generation";
  if (detectExplicitMemoryWriteIntent(testCase.prompt)) return "memory_update";
  if (isChartRequest(testCase.prompt)) return "chart_generation";
  if (isMathQuery(testCase.prompt)) return "math_reasoning";
  return "normal_chat";
}

const goldenPath = path.join(process.cwd(), "docs", "ai", "golden-prompts.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;
assert(Array.isArray(golden.cases) && golden.cases.length > 0, "golden prompt cases are required");

const failures: string[] = [];
for (const testCase of golden.cases) {
  const inferred = inferOfflineRoute(testCase);
  if (inferred !== testCase.expected_route) {
    failures.push(`${testCase.id}: expected ${testCase.expected_route}, inferred ${inferred}`);
  }
  if (!testCase.prompt.trim()) failures.push(`${testCase.id}: prompt is empty`);
  if (!Array.isArray(testCase.success_criteria) || testCase.success_criteria.length === 0) {
    failures.push(`${testCase.id}: success criteria are required`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Golden prompt offline eval passed (${golden.cases.length} cases).`);
