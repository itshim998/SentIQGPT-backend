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
const bootstrapRunnerSource = await readFile(new URL("../../scripts/runFrontendBootstrapCheck.mjs", import.meta.url), "utf8");
const bootstrapPreloadSource = await readFile(new URL("../../scripts/frontendBootstrapDomAliases.cjs", import.meta.url), "utf8");
const runtimeSmokeSource = await readFile(new URL("../../scripts/testFrontendRuntimeSmoke.mjs", import.meta.url), "utf8");
const deploymentVerifySource = await readFile(new URL("../../scripts/verifyFrontendDeployment.mjs", import.meta.url), "utf8");
const deployedRuntimeSource = await readFile(new URL("../../scripts/testDeployedFrontendRuntime.mjs", import.meta.url), "utf8");
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
assert.equal(packageJson.scripts["test:frontend-bootstrap"], "node scripts/runFrontendBootstrapCheck.mjs");
assert.equal(packageJson.scripts["test:frontend-ui-state"], "node scripts/runFrontendUiStateTests.mjs");
assert.equal(packageJson.scripts["test:frontend-billing"], "node --no-warnings frontend/tests/billing-token-usage.test.mjs && node --no-warnings frontend/tests/guest-experience.test.mjs");
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
assert.ok(discovered.includes("startup-observer-safety.test.mjs"));
assert.ok(discovered.includes("ui-state-invariants.test.mjs"));
assert.ok(discovered.includes("ui-state-runtime-contract.test.mjs"));
assert.equal(discovered.includes("billing-token-usage.test.mjs"), false);
assert.equal(discovered.includes("tool-lifecycle-reducer.test.mjs"), false);
assert.deepEqual(discovered, [...discovered].sort((left, right) => left.localeCompare(right)));
assert.equal(new Set(discovered).size, discovered.length);

for (const source of [aggregateSource, stateRunnerSource, bootstrapRunnerSource]) {
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
  'process.platform === "win32" ? "ts-node.cmd" : "ts-node"',
  "scripts/frontendBootstrapDomAliases.cjs",
  "--require=",
  "domReadyListeners[0]();",
  "for (const listener of domReadyListeners) listener();",
  "occurrences !== 1",
  "unlinkSync(generatedPath)",
]) assert.ok(bootstrapRunnerSource.includes(token), `Bootstrap runner missing ${token}`);
assert.equal(bootstrapRunnerSource.includes("--import="), false);

for (const token of [
  '"HTMLFormElement"',
  '"HTMLInputElement"',
  '"HTMLButtonElement"',
  '"SVGElement"',
  '"DocumentFragment"',
  'defineHarnessPrimitive("getPropertyValue"',
  'defineHarnessPrimitive("append"',
  'defineHarnessPrimitive("createComment"',
  'defineHarnessPrimitive("createElementNS"',
]) assert.ok(bootstrapPreloadSource.includes(token), `Bootstrap preload missing ${token}`);

for (const token of [
  "puppeteer-core",
  "setRequestInterception(true)",
  'request.abort("blockedbyclient")',
  "window.MutationObserver = class InstrumentedMutationObserver",
  'cdp.send("Performance.getMetrics")',
  'page.click("#composer-plus-btn")',
  'page.click("#execution-mode-toggle")',
  "domContentLoadedMs > 8_000",
  "mutationRecords > 500",
  "rafExecuted > 180",
]) assert.ok(runtimeSmokeSource.includes(token), `Runtime smoke missing ${token}`);

for (const token of [
  "https://ui-sentiq-liquid-glass-v4.sentiqgpt-frontend.pages.dev/",
  "frontend/deployment-revision.json",
  "deployment-revision.json?token=",
  'cache: "no-store"',
  "AbortSignal.timeout(10_000)",
  "actual.token === expected.token",
  "actual.contentRevision === expected.contentRevision",
  "actual.pass === expected.pass",
  "Verified deployed frontend revision",
]) assert.ok(deploymentVerifySource.includes(token), `Deployment verifier missing ${token}`);
assert.equal(deploymentVerifySource.includes("secrets."), false);

for (const token of [
  "https://ui-sentiq-liquid-glass-v4.sentiqgpt-frontend.pages.dev/",
  "puppeteer-core",
  'waitUntil: "domcontentloaded"',
  'page.waitForSelector("#composer-plus-btn"',
  'page.waitForSelector("#execution-mode-toggle"',
  'page.click("#composer-plus-btn")',
  'page.click("#execution-mode-toggle")',
  'cdp.send("Performance.getMetrics")',
  "domContentLoadedMs > 10_000",
  "taskDuration > 1.2",
  "scriptDuration > 1.0",
  'page.screenshot({ path: "frontend-live-runtime-failure.png"',
  "Deployed frontend runtime smoke passed",
]) assert.ok(deployedRuntimeSource.includes(token), `Deployed runtime smoke missing ${token}`);

for (const token of [
  "name: Frontend checks",
  "pull_request:",
  '      - "ui/**"',
  "workflow_dispatch:",
  "permissions:\n  contents: read",
  "cancel-in-progress: true",
  "uses: actions/checkout@v6",
  "uses: actions/setup-node@v6",
  "uses: actions/upload-artifact@v7",
  "node-version: 20",
  "cache: npm",
  "run: npm ci",
  '      - "scripts/frontendBootstrapDomAliases.cjs"',
  '      - "scripts/runFrontendBootstrapCheck.mjs"',
  '      - "scripts/testFrontendRuntimeSmoke.mjs"',
  '      - "scripts/verifyFrontendDeployment.mjs"',
  '      - "scripts/testDeployedFrontendRuntime.mjs"',
  "puppeteer-core@24.16.0",
  "node scripts/testFrontendRuntimeSmoke.mjs",
  "node scripts/verifyFrontendDeployment.mjs",
  "node scripts/testDeployedFrontendRuntime.mjs",
  "github.event_name == 'push' && github.ref == 'refs/heads/ui/sentiq-liquid-glass-v4'",
  "frontend-bootstrap-failure-${{ github.run_id }}",
  "frontend-ui-state-failure-${{ github.run_id }}",
  "frontend-runtime-failure-${{ github.run_id }}",
  "frontend-deployment-verification-failure-${{ github.run_id }}",
  "frontend-deployed-runtime-failure-${{ github.run_id }}",
  "frontend-live-runtime-failure.png",
  "retention-days: 2",
]) assert.ok(workflowSource.includes(token), `Frontend workflow missing ${token}`);
for (const script of FRONTEND_CHECK_SEQUENCE) {
  assert.ok(workflowSource.includes(`npm run ${script}`), `Frontend workflow must expose ${script} in its own diagnostic step`);
}
assert.equal(workflowSource.includes("secrets."), false, "Frontend checks must remain secret-free");
assert.equal(workflowSource.includes("pull_request_target"), false, "Untrusted pull requests must not run with elevated target-branch context");
assert.equal(workflowSource.includes("contents: write"), false, "Frontend checks must remain read-only");

console.log("Pass 12.2 frontend automation contracts passed: local aggregation, bootstrap adaptation, bounded observer contracts, real Chromium startup diagnostics, exact Pages revision verification, and deployed interactivity checks are deterministic, least-privilege, and fail-closed.");
