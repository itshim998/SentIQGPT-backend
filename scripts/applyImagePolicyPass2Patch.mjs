import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content, "utf8");
}

function replaceOnceOrVerify(path, before, after) {
  const source = read(path);
  const beforeCount = source.split(before).length - 1;
  const afterCount = source.split(after).length - 1;
  if (beforeCount === 1) {
    write(path, source.replace(before, after));
    return;
  }
  if (beforeCount === 0 && afterCount === 1) {
    return;
  }
  throw new Error(
    `${path}: expected exactly one old or new marker; old=${beforeCount} new=${afterCount}`,
  );
}

const toolExecutorPath = "backend/orchestrator/toolExecutor.ts";
const imageTypeImport = 'import type { ImageModelPreference } from "../tools/imageGeneration/types";\n';
const duplicateImageTypeImport = `${imageTypeImport}${imageTypeImport}`;
let toolExecutor = read(toolExecutorPath);
if (toolExecutor.includes(duplicateImageTypeImport)) {
  toolExecutor = toolExecutor.replace(duplicateImageTypeImport, imageTypeImport);
  write(toolExecutorPath, toolExecutor);
} else if ((toolExecutor.split(imageTypeImport).length - 1) === 0) {
  const routerImport = 'import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";\n';
  if ((toolExecutor.split(routerImport).length - 1) !== 1) {
    throw new Error(`${toolExecutorPath}: image router import marker is not unique`);
  }
  write(toolExecutorPath, toolExecutor.replace(routerImport, `${routerImport}${imageTypeImport}`));
} else if ((toolExecutor.split(imageTypeImport).length - 1) !== 1) {
  throw new Error(`${toolExecutorPath}: image model type import is duplicated`);
}

replaceOnceOrVerify(
  toolExecutorPath,
  "  let preferredModel: string | undefined;",
  "  let preferredModel: ImageModelPreference | undefined;",
);
replaceOnceOrVerify(
  toolExecutorPath,
  "      preferredModel: preferredModel as any,",
  "      preferredModel,",
);

replaceOnceOrVerify(
  "backend/server.ts",
  "    const preferredModel = entitledImageRoute.adapterModelOverride as any;",
  "    const preferredModel = entitledImageRoute.adapterModelOverride;",
);

replaceOnceOrVerify(
  "backend/testPriority5Stability.ts",
  '    && toolExecutor.includes("preferredModel: preferredModel as any,")',
  '    && toolExecutor.includes("preferredModel,")\n    && !toolExecutor.includes("preferredModel as any")',
);

for (const path of [
  toolExecutorPath,
  "backend/server.ts",
]) {
  const source = read(path);
  if (source.includes("preferredModel as any") || source.includes("adapterModelOverride as any")) {
    throw new Error(`${path}: image-routing any cast remains after patch`);
  }
}

const finalToolExecutor = read(toolExecutorPath);
if ((finalToolExecutor.split(imageTypeImport).length - 1) !== 1) {
  throw new Error(`${toolExecutorPath}: expected one image model preference import`);
}

const stabilityTest = read("backend/testPriority5Stability.ts");
if (!stabilityTest.includes('!toolExecutor.includes("preferredModel as any")')) {
  throw new Error("backend/testPriority5Stability.ts: missing no-any regression assertion");
}

console.log("Applied or verified image-policy Pass 2 call-site cleanup.");
