import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  FRONTEND_CHECK_SEQUENCE,
} from "../../scripts/runFrontendChecks.mjs";
import {
  EXPLICIT_FRONTEND_TESTS,
  discoverFrontendUiStateTests,
} from "../../scripts/runFrontendUiStateTests.mjs";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const aggregateSource = await readFile(new URL("../../scripts/runFrontendChecks.mjs", import.meta.url), "utf8");
const stateRunnerSource = await readFile(new URL("../../scripts/runFrontendUiStateTests.mjs", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../../.github/workflows/frontend-checks.yml", import.meta.url), "utf8");

assert.deepEqual(FRONTEND_CHECK_SEQUENCE, [
  "check:frontend-syntax",
  "test:frontend-bootstrap",
  "test:frontend-file-generation",
  "test:frontend-tool-lifecycle",
  "test:frontend-billing",
  "test:frontend-ui-state",
]);

assert.equal(packageJson.scripts["test:frontend"], "node scripts/runFrontendChecks.mjs");
assert.equal(packageJson.scripts["test:frontend-ui-state"], "node scripts/runFrontendUiStateTests.mjs");
assert.equal(packageJson.scripts["test:frontend-billing"], "node --no-warnings frontend/tests/billing-token-usage.test.mjs");
for (const script of FRONTEND_CHECK_SEQUENCE) {
  assert.equal(typeof packageJson.scripts[script], "string", `Missing npm script: ${script}`);
}

assert.deepEqual([...EXPLICIT_FRONTEND_TESTS].sort(), [
  "billing-token-usage.test.mjs",
  "tool-lifecycle-reducer.test.mjs",
]);

const discovered = discoverFrontendUiStateTests().map((path) => basename(path));
assert.ok(discovered.length >= 3, "Focused UI-state discovery should find the established pass gates");
assert.ok(discovered.includes("accessibility-verification.test.mjs"));
assert.ok(discovered.includes("blur-layer-budget.test.mjs"));
assert.ok(discovered.includes("ui-state-invariants.test.mjs"));
assert.equal(discovered.includes("billing-token-usage.test.mjs"), false);
assert.equal(discovered.includes("tool-lifecycle-reducer.test.mjs"), false);
assert.deepEqual(discovered, [...discovered].sort((left, right) => left.localeCompare(right)));
assert.equal(new Set(discovered).size, discovered.length);

for (const source of [aggregateSource, stateRunnerSource]) {
  assert.ok(source.includes("spawnSync"));
  assert.ok(source.includes("shell: false"));
  assert.ok(source.includes('stdio: "inherit"'));
  assert.equal(source.includes("shell: true"), false);
  assert.equal(source.includes("execSync"), false);
}
assert.ok(aggregateSource.includes('process.platform === "win32" ? "npm.cmd" : "npm"'));
assert.ok(stateRunnerSource.includes('name.endsWith(".test.mjs")'));
assert.ok(stateRunnerSource.includes("failures.push"));
assert.ok(stateRunnerSource.includes("No focused frontend UI-state tests were discovered"));

for (const token of [
  "name: Frontend checks",
  "pull_request:",
  '      - "ui/**"',
  "workflow_dispatch:",
  "permissions:\n  contents: read",
  "cancel-in-progress: true",
  "uses: actions/checkout@v4",
  "uses: actions/setup-node@v4",
  "node-version: 20",
  "cache: npm",
  "run: npm ci",
]) assert.ok(workflowSource.includes(token), `Frontend workflow missing ${token}`);
for (const script of FRONTEND_CHECK_SEQUENCE) {
  assert.ok(workflowSource.includes(`run: npm run ${script}`), `Frontend workflow must expose ${script} as its own diagnostic step`);
}
assert.equal(workflowSource.includes("secrets."), false, "Frontend checks must remain secret-free");
assert.equal(workflowSource.includes("pull_request_target"), false, "Untrusted pull requests must not run with elevated target-branch context");

console.log("Pass 12.2 frontend automation contracts passed: local aggregation and CI diagnostics are deterministic, cross-platform, non-duplicating, least-privilege, and fail-closed.");
