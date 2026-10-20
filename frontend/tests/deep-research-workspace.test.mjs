import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const statePath = resolve(root, "frontend/scripts/features/deep-research-workspace-state.js");
const core = readFileSync(resolve(root, "frontend/scripts/features/deep-research-workspace.js"), "utf8");
const report = readFileSync(resolve(root, "frontend/scripts/features/deep-research-report-workspace.js"), "utf8");
const progress = readFileSync(resolve(root, "frontend/scripts/features/deep-research-progress-workspace.js"), "utf8");
const domRefs = readFileSync(resolve(root, "frontend/scripts/features/chat/dom-refs.js"), "utf8");
const baseCss = readFileSync(resolve(root, "frontend/styles/modules/36-deep-research-workspace.css"), "utf8");
const reportCss = readFileSync(resolve(root, "frontend/styles/modules/37-deep-research-report.css"), "utf8");
const responsiveCss = readFileSync(resolve(root, "frontend/styles/modules/38-deep-research-responsive.css"), "utf8");
const imports = readFileSync(resolve(root, "frontend/styles/modules/12-reduced-motion.css"), "utf8");
const {
  buildDeepResearchDisclosureKey,
  estimateDeepResearchReadMinutes,
  getDeepResearchStageStates,
  normalizeDeepResearchStage,
} = await import(pathToFileURL(statePath));

assert.equal(normalizeDeepResearchStage({ phase: "plan", percent: 12 }), "scope");
assert.equal(normalizeDeepResearchStage({ phase: "search", percent: 38 }), "sources");
assert.equal(normalizeDeepResearchStage({ statusText: "Writing final report sections", percent: 52 }), "synthesis");
assert.equal(normalizeDeepResearchStage({ status: "completed", percent: 100 }), "complete");
assert.deepEqual(getDeepResearchStageStates("sources", "running"), { scope: "complete", sources: "active", synthesis: "pending" });
assert.deepEqual(getDeepResearchStageStates("complete", "completed"), { scope: "complete", sources: "complete", synthesis: "complete" });
assert.equal(getDeepResearchStageStates("synthesis", "failed").synthesis, "paused");
assert.equal(estimateDeepResearchReadMinutes("word ".repeat(440)), 2);
assert.equal(estimateDeepResearchReadMinutes(""), 0);
assert.match(buildDeepResearchDisclosureKey("report 123"), /^sentiq_deep_research_details:report-123$/);

assert.match(domRefs, /import "\.\.\/deep-research-workspace\.js";/);
for (const file of ["36-deep-research-workspace.css", "37-deep-research-report.css", "38-deep-research-responsive.css"]) {
  assert.match(imports, new RegExp(`@import url\\("\\./${file.replace(".", "\\.")}"\\);`));
}
assert.match(core, /new MutationObserver/);
assert.match(progress, /document\.createElement\("details"\)/);
assert.match(progress, /sessionStorage/);
assert.match(core, /Running in background/);
assert.match(core, /Resumed\. Updates reconnect when this chat is open/);
assert.match(progress, /progressbar/);
assert.match(report, /Saved in this chat/);
assert.match(report, /Open full report/);
assert.doesNotMatch(`${core}\n${progress}\n${report}`, /fetch\(|XMLHttpRequest|SentIQAPI|persistChatMessage|startDeepResearch|subscribeDeepResearchEvents|cloneNode/);

assert.match(baseCss, /data-deep-research-workspace-version="7\.2"/);
assert.match(baseCss, /\.deep-research-stage-rail/);
assert.match(baseCss, /\.deep-research-progress-details/);
assert.match(reportCss, /\.deep-research-report-metadata/);
assert.match(responsiveCss, /@media \(max-width: 640px\)/);
assert.match(responsiveCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(responsiveCss, /@media \(forced-colors: active\)/);
assert.doesNotMatch(`${baseCss}\n${reportCss}\n${responsiveCss}`, /position:\s*fixed|100vw/);

console.log("Deep Research workspace phase-gate checks passed.");
