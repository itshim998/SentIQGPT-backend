import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content, "utf8");
}

function replaceExact(path, before, after, expectedCount = 1) {
  const source = read(path);
  const actualCount = source.split(before).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} occurrence(s), found ${actualCount}: ${before}`);
  }
  write(path, source.split(before).join(after));
}

function removeExact(path, text, expectedCount = 1) {
  replaceExact(path, text, "", expectedCount);
}

replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  'import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";\n',
  'import { routeImageGeneration } from "../tools/imageGeneration/imageRouter";\nimport type { ImageModelPreference } from "../tools/imageGeneration/types";\n',
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  "  let preferredModel: string | undefined;",
  "  let preferredModel: ImageModelPreference | undefined;",
);
replaceExact(
  "backend/orchestrator/toolExecutor.ts",
  "      preferredModel: preferredModel as any,",
  "      preferredModel,",
);

replaceExact(
  "backend/server.ts",
  "    const preferredModel = entitledImageRoute.adapterModelOverride as any;",
  "    const preferredModel = entitledImageRoute.adapterModelOverride;",
);

replaceExact(
  "backend/testPriority5Stability.ts",
  '    && toolExecutor.includes("preferredModel: preferredModel as any,")',
  '    && toolExecutor.includes("preferredModel,")\n    && !toolExecutor.includes("preferredModel as any")',
);

for (const path of [".env.example", ".env.template"]) {
  replaceExact(
    path,
    "# --- Image Generation (Pollinations / Flux) ---\n# FLUX_API_KEY is optional — Pollinations works on free tier without it.\n# Set this for premium/priority access to Flux Schnell, FLUX.2 Dev, Z-Image Turbo.\n",
    "# --- Image Generation (Pollinations) ---\n# POLLINATIONS_API_KEY is preferred. FLUX_API_KEY remains a legacy credential alias.\n# Plan-tier image routing is code-owned; prompt-category image model variables are ignored.\n",
  );
  removeExact(path, "SENTIQ_IMAGE_MODEL_NORMAL=pollinations:zimage\n");
  removeExact(path, "SENTIQ_IMAGE_MODEL_TEXT_CORE=pollinations:gptimage\n");
  removeExact(path, "SENTIQ_IMAGE_MODEL_TEXT_PREMIUM=pollinations:gptimage-large\n");
}

for (const path of [
  "backend/orchestrator/toolExecutor.ts",
  "backend/server.ts",
  "backend/testPriority5Stability.ts",
]) {
  const source = read(path);
  if (source.includes("preferredModel as any") || source.includes("adapterModelOverride as any")) {
    throw new Error(`${path}: image-routing any cast remains after patch`);
  }
}

for (const path of [".env.example", ".env.template"]) {
  const source = read(path);
  for (const obsolete of [
    "SENTIQ_IMAGE_MODEL_NORMAL=",
    "SENTIQ_IMAGE_MODEL_TEXT_CORE=",
    "SENTIQ_IMAGE_MODEL_TEXT_PREMIUM=",
  ]) {
    if (source.includes(obsolete)) {
      throw new Error(`${path}: obsolete prompt-category setting remains: ${obsolete}`);
    }
  }
}

console.log("Applied image-policy Pass 2 source cleanup.");
