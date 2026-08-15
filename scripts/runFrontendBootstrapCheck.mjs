import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsNodeExecutable = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ts-node.cmd" : "ts-node",
);
const preloadPath = resolve(repositoryRoot, "scripts/frontendBootstrapDomAliases.cjs");
const sourcePath = resolve(repositoryRoot, "backend/testFrontendBootstrap.ts");
const generatedPath = resolve(repositoryRoot, "backend/.testFrontendBootstrap.pass12.generated.ts");
const startupLogoTestPath = resolve(repositoryRoot, "frontend/tests/bootstrap-startup-logo.test.mjs");
const existingNodeOptions = String(process.env.NODE_OPTIONS || "").trim();
const nodeOptions = [existingNodeOptions, `--require=${JSON.stringify(preloadPath)}`].filter(Boolean).join(" ");

const originalSource = readFileSync(sourcePath, "utf8");
const singleListenerCall = "domReadyListeners[0]();";
const allListenerCall = "for (const listener of domReadyListeners) listener();";
const occurrences = originalSource.split(singleListenerCall).length - 1;
if (occurrences !== 1) {
  throw new Error(`Frontend bootstrap adapter expected one startup-listener call, found ${occurrences}.`);
}
writeFileSync(generatedPath, originalSource.replace(singleListenerCall, allListenerCall), "utf8");

let result;
try {
  result = spawnSync(tsNodeExecutable, [
    "--project",
    resolve(repositoryRoot, "tsconfig.backend.json"),
    generatedPath,
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, NODE_OPTIONS: nodeOptions },
    shell: false,
    stdio: "inherit",
  });
} finally {
  try { unlinkSync(generatedPath); } catch { /* best-effort test cleanup */ }
}

if (result?.error) {
  console.error(`Frontend bootstrap check could not start: ${result.error.message}`);
  process.exitCode = 1;
} else if ((result?.status ?? 1) !== 0) {
  process.exitCode = result?.status ?? 1;
} else {
  const startupLogoResult = spawnSync(process.execPath, [startupLogoTestPath], {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  process.exitCode = startupLogoResult.error ? 1 : (startupLogoResult.status ?? 1);
}
