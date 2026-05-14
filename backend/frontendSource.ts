import { readdirSync, readFileSync } from "fs";
import { join, relative, resolve } from "path";

export type FrontendSourceFile = {
  relativePath: string;
  content: string;
};

export type FrontendSources = {
  indexHtml: string;
  scriptFiles: FrontendSourceFile[];
  styleFiles: FrontendSourceFile[];
  scripts: Record<string, string>;
  styles: Record<string, string>;
  combined: string;
};

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function collectFiles(dir: string, extensions: Set<string>, frontendRoot: string): FrontendSourceFile[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const files: FrontendSourceFile[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, extensions, frontendRoot));
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!extensions.has(ext)) continue;
    files.push({
      relativePath: normalizePath(relative(frontendRoot, fullPath)),
      content: readFileSync(fullPath, "utf8"),
    });
  }

  return files;
}

export function readFrontendSources(repoRoot = process.cwd()): FrontendSources {
  const frontendRoot = resolve(repoRoot, "frontend");
  const indexHtml = readFileSync(join(frontendRoot, "index.html"), "utf8");
  const scriptFiles = collectFiles(join(frontendRoot, "scripts"), new Set([".js"]), frontendRoot);
  const styleFiles = collectFiles(join(frontendRoot, "styles"), new Set([".css"]), frontendRoot);
  const scripts = Object.fromEntries(scriptFiles.map((file) => [file.relativePath, file.content]));
  const styles = Object.fromEntries(styleFiles.map((file) => [file.relativePath, file.content]));
  const combined = [
    indexHtml,
    ...styleFiles.map((file) => file.content),
    ...scriptFiles.map((file) => file.content),
  ].join("\n");

  return {
    indexHtml,
    scriptFiles,
    styleFiles,
    scripts,
    styles,
    combined,
  };
}
