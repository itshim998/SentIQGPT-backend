import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { planTask } from "./orchestrator/planner";
import { SENTIQ_TOOL_REGISTRY, type SentIQToolName } from "./orchestrator/toolContract";

type ExpectedOutcome = SentIQToolName | "normal_text" | "clarify";

type GoldenCase = {
  id: string;
  category: string;
  coverage: string;
  prompt: string;
  expected_outcome: ExpectedOutcome;
  requires_context?: string[];
  success_criteria: string[];
};

type GoldenFile = {
  name: string;
  version: number;
  cases: GoldenCase[];
};

const REQUIRED_COVERAGE = new Set([
  "web_current_direct",
  "web_current_indirect",
  "web_explicit_search",
  "image_explicit",
  "image_indirect",
  "chart_request",
  "file_download",
  "memory_explicit",
  "danger_latest",
  "danger_html_image",
  "danger_explain_image",
  "danger_explain_web",
  "danger_websearch_code",
  "danger_button_label",
  "danger_visualize",
  "danger_generate_prose",
  "clarify_ambiguous_entity",
  "clarify_missing_edit_target",
  "clarify_unresolved_reference",
  "clarify_insufficient_tool_info",
]);

const goldenPath = path.join(process.cwd(), "docs", "ai", "golden-prompts.json");
const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8")) as GoldenFile;
assert(Array.isArray(golden.cases) && golden.cases.length > 0, "golden prompt cases are required");

async function main(): Promise<void> {
  const failures: string[] = [];
  const toolNames = new Set<string>(SENTIQ_TOOL_REGISTRY.map((tool) => tool.name));
  const documentedOutcomes = new Set<string>(["normal_text", "clarify", ...toolNames]);
  const seenIds = new Set<string>();
  const seenCoverage = new Set<string>();

  for (const testCase of golden.cases) {
    const plan = await planTask({
      userMessage: testCase.prompt,
      hasFileContext: testCase.requires_context?.includes("file_references"),
    });

    // Automatic semantic selection belongs exclusively to the provider model.
    // These fixtures document expected live outcomes but the local planner must
    // remain a single ordinary conversation step for every case.
    if (plan.steps.length !== 1 || plan.steps[0]?.tool !== "conversation") {
      failures.push(`${testCase.id}: local planner predicted ${plan.steps.map((step) => step.tool).join(",") || "no step"}`);
    }
    if (!documentedOutcomes.has(testCase.expected_outcome)) {
      failures.push(`${testCase.id}: unsupported documented outcome ${testCase.expected_outcome}`);
    }
    if (seenIds.has(testCase.id)) failures.push(`${testCase.id}: duplicate id`);
    seenIds.add(testCase.id);
    seenCoverage.add(testCase.coverage);
    if (!testCase.prompt.trim()) failures.push(`${testCase.id}: prompt is empty`);
    if (!Array.isArray(testCase.success_criteria) || testCase.success_criteria.length === 0) {
      failures.push(`${testCase.id}: success criteria are required`);
    }
  }

  for (const required of REQUIRED_COVERAGE) {
    if (!seenCoverage.has(required)) failures.push(`missing required coverage: ${required}`);
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(
    `Golden structural eval passed (${golden.cases.length} cases; ${REQUIRED_COVERAGE.size} required coverage classes; semantic outcomes remain live-model eval targets).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
