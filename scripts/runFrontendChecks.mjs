import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export const FRONTEND_CHECK_SEQUENCE = Object.freeze([
  "check:frontend-syntax",
  "test:frontend-bootstrap",
  "test:frontend-file-generation",
  "test:frontend-tool-lifecycle",
  "test:frontend-billing",
  "test:frontend-ui-state",
]);

export function runFrontendChecks() {
  const completed = [];
  for (const script of FRONTEND_CHECK_SEQUENCE) {
    console.log(`\n[frontend-qa] npm run ${script}`);
    const result = spawnSync(npmCommand, ["run", script], {
      cwd: repositoryRoot,
      env: { ...process.env, SENTIQ_FRONTEND_QA: "1" },
      shell: false,
      stdio: "inherit",
    });

    if (result.error) throw new Error(`${script} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status ?? "unknown"}.`);
    completed.push(script);
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
