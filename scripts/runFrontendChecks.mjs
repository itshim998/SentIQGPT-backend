import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;

export const FRONTEND_CHECK_SEQUENCE = Object.freeze([
  "check:frontend-syntax",
  "test:frontend-bootstrap",
  "test:frontend-file-generation",
  "test:frontend-tool-lifecycle",
  "test:frontend-billing",
  "test:frontend-ui-state",
]);

export const FRONTEND_ACTIVITY_LOGO_CHECKS = Object.freeze([
  "frontend/tests/phase4-thinking-logo.test.mjs",
  "frontend/tests/phase5-infinite-dialog.test.mjs",
  "frontend/tests/phase7-logo-theme.test.mjs",
  "frontend/tests/phase8-motion-accessibility.test.mjs",
  "frontend/tests/phase9-logo-performance.test.mjs",
]);

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, SENTIQ_FRONTEND_QA: "1" },
    shell: false,
    stdio: "inherit",
  });

  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
}

export function runFrontendChecks() {
  const completed = [];
  for (const script of FRONTEND_CHECK_SEQUENCE) {
    console.log(`\n[frontend-qa] npm run ${script}`);
    runCommand(npmCommand, ["run", script], script);
    completed.push(script);
  }

  for (const testFile of FRONTEND_ACTIVITY_LOGO_CHECKS) {
    console.log(`\n[frontend-qa] node --no-warnings ${testFile}`);
    runCommand(nodeCommand, ["--no-warnings", testFile], testFile);
    completed.push(testFile);
  }

  console.log(`\nAutomated frontend checks passed (${completed.length} gates).`);
  return Object.freeze([...completed]);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  try {
    runFrontendChecks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
