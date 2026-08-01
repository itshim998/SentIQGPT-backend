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

replaceOnceOrVerify(
  "backend/orchestrator/toolExecutor.ts",
  'import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";\n',
  'import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";\nimport type { ImageModelPreference } from "../tools/imageGeneration/types";\n',
);
replaceOnceOrVerify(
  "backend/orchestrator/toolExecutor.ts",
  "  let preferredModel: string | undefined;",
  "  let preferredModel: ImageModelPreference | undefined;",
);
replaceOnceOrVerify(
  "backend/orchestrator/toolExecutor.ts",
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
  "backend/orchestrator/toolExecutor.ts",
  "backend/server.ts",
]) {
  const source = read(path);
  if (source.includes("preferredModel as any") || source.includes("adapterModelOverride as any")) {
    throw new Error(`${path}: image-routing any cast remains after patch`);
  }
}

const stabilityTest = read("backend/testPriority5Stability.ts");
if (!stabilityTest.includes('!toolExecutor.includes("preferredModel as any")')) {
  throw new Error("backend/testPriority5Stability.ts: missing no-any regression assertion");
}

console.log("Applied or verified image-policy Pass 2 call-site cleanup.");
