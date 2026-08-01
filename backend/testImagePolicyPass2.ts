import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

const server = read("backend/server.ts");
const toolExecutor = read("backend/orchestrator/toolExecutor.ts");
const imageRouter = read("backend/tools/imageGeneration/imageRouter.ts");
const imageTypes = read("backend/tools/imageGeneration/types.ts");
const capabilitySelector = read("backend/orchestrator/capabilityModelSelector.ts");
const modelRouter = read("backend/billing/modelEntitlementRouter.ts");
const pollinationsUtils = read("backend/tools/imageGeneration/pollinationsUtils.ts");
const envExample = read(".env.example");
const envTemplate = read(".env.template");
const billingDocs = read("docs/BILLING_AND_PRICING.md");
const rolloutDocs = read("docs/PLAN_TIER_IMAGE_POLICY_ROLLOUT.md");
const migration = read("supabase/migrations/20260801091500_plan_tier_image_policy.sql");

for (const source of [server, toolExecutor, imageRouter]) {
  assert(!source.includes("preferredModel as any"), "image model preference must not use an any cast");
  assert(!source.includes("adapterModelOverride as any"), "typed image route overrides must not use an any cast");
}
assert.match(toolExecutor, /let preferredModel: ImageModelPreference \| undefined/);
assert.match(toolExecutor, /import type \{ ImageModelPreference \} from "\.\.\/tools\/imageGeneration\/types"/);
assert.match(server, /const preferredModel = entitledImageRoute\.adapterModelOverride;/);

assert.match(imageTypes, /export type ImageModelPreference/);
assert.match(imageTypes, /"dreamshaper"/);
assert.match(imageTypes, /"gpt-image-2"/);
assert.match(imageTypes, /"kontext"/);
assert.match(capabilitySelector, /import type \{ ImageModelPreference \}/);
assert.match(modelRouter, /Readonly<Record<BillingPlanCode, ImageModelPreference>>/);
assert.match(imageRouter, /PollinationsImageModelProvider\("klein"\)/);
assert.match(imageRouter, /PollinationsImageModelProvider\("kontext"\)/);
assert.match(imageRouter, /PollinationsImageModelProvider\("gpt-image-2"\)/);
assert(!imageRouter.includes("GptImageProvider"));
assert(!existsSync(resolve(root, "backend/tools/imageGeneration/providers/gptImageProvider.ts")));

assert.match(pollinationsUtils, /describePollinationsRequest/);
assert(!pollinationsUtils.includes("imageUrl.slice"));
assert(!pollinationsUtils.includes("request url="));

for (const source of [envExample, envTemplate]) {
  assert(!source.includes("SENTIQ_IMAGE_MODEL_NORMAL="));
  assert(!source.includes("SENTIQ_IMAGE_MODEL_TEXT_CORE="));
  assert(!source.includes("SENTIQ_IMAGE_MODEL_TEXT_PREMIUM="));
  assert.match(source, /Plan-tier image routing is code-owned/);
}
assert.match(billingDocs, /Free[\s\S]*dreamshaper[\s\S]*flux/i);
assert.match(billingDocs, /Pro[\s\S]*gpt-image-2[\s\S]*kontext/i);
assert.match(rolloutDocs, /auth\/control database only/i);
assert.match(rolloutDocs, /Data shards 2–4: no migration required/i);
assert.match(migration, /RUN ON: Auth\/control database only/i);
assert.match(migration, /DO NOT RUN ON: Data shards 2, 3, or 4/i);

console.log("Image policy Pass 2 source, configuration, typing, logging, and rollout checks passed.");
