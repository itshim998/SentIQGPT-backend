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
const existingNodeOptions = String(process.env.NODE_OPTIONS || "").trim();
const nodeOptions = [existingNodeOptions, `--require=${JSON.stringify(preloadPath)}`].filter(Boolean).join(" ");

const result = spawnSync(tsNodeExecutable, [
  "--project",
  resolve(repositoryRoot, "tsconfig.backend.json"),
  resolve(repositoryRoot, "backend/testFrontendBootstrap.ts"),
], {
  cwd: repositoryRoot,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  shell: false,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Frontend bootstrap check could not start: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
