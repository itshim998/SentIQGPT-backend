import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(path));
    else if ([".js", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = collect("frontend").sort();
for (const path of files) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Frontend syntax checks passed (${files.length} files).`);
