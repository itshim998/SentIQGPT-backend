import fs from "node:fs";

function replaceExact(path, before, after, expectedCount = 1) {
  const source = fs.readFileSync(path, "utf8");
  const actualCount = source.split(before).length - 1;
  if (actualCount !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} occurrence(s), found ${actualCount}`);
  }
  fs.writeFileSync(path, source.split(before).join(after), "utf8");
}

replaceExact(
  "backend/tools/imageGeneration/imageRouter.ts",
  "// Plan-primary chains:\n//   Free:      dreamshaper -> flux -> zimage -> HuggingFace -> Z-Image Turbo\n//   Essential: zimage -> klein -> flux -> HuggingFace -> Z-Image Turbo\n//   Plus:      zimage -> klein -> flux -> HuggingFace -> Z-Image Turbo\n//   Pro:       gpt-image-2 -> kontext -> dreamshaper -> flux -> zimage -> HuggingFace -> Z-Image Turbo\n",
  "// Plan-primary chains:\n//   Free:       dreamshaper -> flux -> zimage -> HuggingFace -> Z-Image Turbo\n//   Paid visual: zimage -> klein -> flux -> HuggingFace -> Z-Image Turbo\n//   Paid text:   gpt-image-2 -> kontext -> dreamshaper -> flux -> zimage -> HuggingFace -> Z-Image Turbo\n",
);

replaceExact(
  "backend/tools/imageGeneration/imageRouter.ts",
  'new PollinationsImageModelProvider("klein"),',
  'new PollinationsImageModelProvider("klein", { enhance: true }),',
  2,
);

replaceExact(
  "backend/tools/imageGeneration/imageRouter.ts",
  "  }\n}\n\nexport function getImageProviderOrder(",
  "  }\n\n  // Defensive runtime fallback for malformed or stale external preferences.\n  // Typed call sites cannot reach this branch, but request boundaries and old\n  // clients must degrade to the ordinary chain instead of crashing.\n  return mode === \"complex\" ? complexProviders : standardProviders;\n}\n\nexport function getImageProviderOrder(",
);

replaceExact(
  "backend/testImageRoutingSafety.ts",
  '  assert.equal(getImageProviderOrder("a puppy in snow", "flux")[0], "flux");\n',
  '  assert.equal(getImageProviderOrder("a puppy in snow", "flux")[0], "flux");\n  assert.deepEqual(\n    getImageProviderOrder("a puppy in snow", "unexpected-model" as ImageModelPreference).slice(0, 2),\n    ["dreamshaper", "flux"],\n    "an unexpected runtime preference degrades to the safe ordinary chain",\n  );\n',
);

replaceExact(
  "backend/testImagePolicyPass2.ts",
  'assert.match(imageRouter, /PollinationsImageModelProvider\\(\"klein\"\\)/);',
  'assert.match(imageRouter, /PollinationsImageModelProvider\\(\"klein\", \\{ enhance: true \\}\\)/);',
);

console.log("Applied image router review fixes.");
