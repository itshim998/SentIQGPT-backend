import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDirectory = resolve(repositoryRoot, "frontend/tests");

// These tests already have dedicated npm scripts and are run explicitly by the
// aggregate frontend gate. Keeping them out of discovery prevents duplicate work.
export const EXPLICIT_FRONTEND_TESTS = Object.freeze(new Set([
  "billing-token-usage.test.mjs",
  "tool-lifecycle-reducer.test.mjs",
]));

export function discoverFrontendUiStateTests(directory = testDirectory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".test.mjs"))
    .filter((name) => !EXPLICIT_FRONTEND_TESTS.has(name))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => resolve(directory, name));
}

export function runFrontendUiStateTests(options = {}) {
  const tests = discoverFrontendUiStateTests(options.directory || testDirectory);
  if (!tests.length) throw new Error("No focused frontend UI-state tests were discovered.");

  const failures = [];
  for (const testPath of tests) {
    const label = basename(testPath);
    console.log(`\n[frontend-ui-state] ${label}`);
    const result = spawnSync(process.execPath, ["--no-warnings", testPath], {
      cwd: repositoryRoot,
      env: { ...process.env, SENTIQ_FRONTEND_UI_STATE_TEST: "1" },
      shell: false,
      stdio: "inherit",
    });

    if (result.error) failures.push(`${label}: ${result.error.message}`);
    else if (result.status !== 0) failures.push(`${label}: exited with ${result.status ?? "unknown status"}`);
  }

  if (failures.length) {
    throw new Error(`Focused frontend UI-state checks failed:\n- ${failures.join("\n- ")}`);
  }

  console.log(`\nFocused frontend UI-state checks passed (${tests.length} files).`);
  return Object.freeze({ count: tests.length, tests: tests.map((path) => basename(path)) });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  try {
    runFrontendUiStateTests();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
