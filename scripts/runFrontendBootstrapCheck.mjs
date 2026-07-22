import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
const tsNodeCli = require.resolve("ts-node/dist/bin.js");
const preloadUrl = pathToFileURL(resolve(repositoryRoot, "scripts/frontendBootstrapDomAliases.mjs")).href;
const existingNodeOptions = String(process.env.NODE_OPTIONS || "").trim();
const nodeOptions = [existingNodeOptions, `--import=${preloadUrl}`].filter(Boolean).join(" ");

const result = spawnSync(process.execPath, [
  tsNodeCli,
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
