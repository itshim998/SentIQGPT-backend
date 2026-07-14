import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planTask } from "./orchestrator/planner";

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

const goldenPath = path.join(process.cwd(), "docs", "ai", "golden-prompts.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;
assert(Array.isArray(golden.cases) && golden.cases.length > 0, "golden prompt cases are required");

async function main(): Promise<void> {
  const failures: string[] = [];
  const documentedOutcomes = new Set(["normal_chat", "file_analysis", "memory_update", "chart_generation", "image_generation"]);
  for (const testCase of golden.cases) {
    const plan = await planTask({
      userMessage: testCase.prompt,
      hasFileContext: testCase.requires_context?.includes("file_references"),
    });
    if (plan.steps[0]?.tool !== "conversation") {
      failures.push(`${testCase.id}: local planner predicted ${plan.steps[0]?.tool}`);
    }
    if (!documentedOutcomes.has(testCase.expected_route)) {
      failures.push(`${testCase.id}: unsupported documented outcome ${testCase.expected_route}`);
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

  console.log(`Golden prompt structural eval passed (${golden.cases.length} cases; semantic outcomes remain live-model eval targets).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
