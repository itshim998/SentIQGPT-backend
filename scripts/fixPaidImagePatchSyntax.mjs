import fs from "node:fs";

function replaceInFile(path, before, after) {
  let content = fs.readFileSync(path, "utf8");
  if (content.includes(after)) return;
  if (!content.includes(before)) throw new Error(`Missing repair marker in ${path}: ${before}`);
  content = content.replace(before, after);
  fs.writeFileSync(path, content, "utf8");
}

const patchPath = "scripts/applyPaidImageTextRoutingPass2.mjs";
let source = fs.readFileSync(patchPath, "utf8");
const replacements = [
  [
    '  assert.equal(visual.model, "zimage", `${plan} non-text image route`);',
    '  assert.equal(visual.model, "zimage", plan + " non-text image route");',
  ],
  [
    '  assert.equal(text.model, "gpt-image-2", `${plan} text-rendering image route`);',
    '  assert.equal(text.model, "gpt-image-2", plan + " text-rendering image route");',
  ],
  [
    "  '                execution_mode: \"fast\" as const,',\n  '                execution_mode: \"intuitive\" as const,',\n  2,",
    "  '                execution_mode: \"fast\" as const,',\n  '                execution_mode: \"intuitive\" as const,',\n  1,",
  ],
  [
    "  '    \"gemini_transport_enabled\": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\\n',\n  '    \"gemini_transport_enabled\": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\\n    \"pollinations_transport_enabled\": SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED,\\n',\n);",
    "  '    \"gemini_transport_enabled\": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\\n',\n  '    \"gemini_transport_enabled\": SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,\\n    \"pollinations_transport_enabled\": SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED,\\n',\n  2,\n);",
  ],
  [
    "  '        max_output_tokens,\\n        effective_images,\\n    )',\n  '        max_output_tokens,\\n        effective_images,\\n        sentiq_tool_request,\\n    )',\n  2,",
    "  '        max_output_tokens,\\n        effective_images,\\n    )',\n  '        max_output_tokens,\\n        effective_images,\\n        sentiq_tool_request,\\n    )',\n  1,",
  ],
];
for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`Missing patch-script syntax marker: ${before}`);
  source = source.replace(before, after);
}

function removeLastReplaceExactBefore(comment, requiredParts) {
  const commentIndex = source.indexOf(comment);
  if (commentIndex < 0) throw new Error(`Missing patch comment: ${comment}`);
  const start = source.lastIndexOf("replaceExact(", commentIndex);
  if (start < 0) return;
  const candidate = source.slice(start, commentIndex);
  if (requiredParts.every((part) => candidate.includes(part))) {
    source = source.slice(0, start) + source.slice(commentIndex);
  }
}

removeLastReplaceExactBefore(
  "// Existing image routing tests now assert the Boolean-driven paid policy.",
  ["backend/testModelToolProviderTransport.py", "GOOGLE_GENAI_MODULE", "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED"],
);
removeLastReplaceExactBefore(
  "// Contract assertions ensure the patch did not leave legacy prompt-based routing.",
  ["docs/BILLING_AND_PRICING.md", "Student Core", "gpt-image-2"],
);
fs.writeFileSync(patchPath, source, "utf8");

replaceInFile(
  "backend/billing/testQuota.ts",
  '  const image = getImageModelForPlan("premium", "make a poster with the title SentIQ Chat");',
  '  const image = getImageModelForPlan("premium", true);',
);
replaceInFile(
  "backend/server.ts",
  '      route: entitledImageRoute.route,\n      metadata: {\n        ...(imageReservation.metadata ?? {}),\n        requires_text_rendering: textRenderingDecision.requiresTextRendering,\n        text_rendering_decision_source: textRenderingDecision.source,\n      },\n    };',
  '      route: entitledImageRoute.route,\n    };',
);
replaceInFile(
  "backend/server.ts",
  '    await billingQuotaService.commit(committedImageReservation, {\n      endpoint: "images.generate",\n      route: "image_generation",\n    });',
  '    await billingQuotaService.commit(committedImageReservation, {\n      endpoint: "images.generate",\n      route: "image_generation",\n      requires_text_rendering: textRenderingDecision.requiresTextRendering,\n      text_rendering_decision_source: textRenderingDecision.source,\n    });',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  '    "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",\n    "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",',
  '    "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",\n    "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",\n    "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  'assert.equal(canUseSentIQTools("pollinations", true), false);',
  'assert.equal(canUseSentIQTools("pollinations", true), true);',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  '  assert.deepEqual(getAutomaticSentIQToolsForRoute({ provider: "pollinations", model: "mistral" }, false), []);',
  '  assert.deepEqual(\n    getAutomaticSentIQToolsForRoute({ provider: "pollinations", model: "mistral" }, false),\n    expectedAuthenticatedTools,\n  );',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  '    geminiTransportEnabled: true,\n    webSurfSelectionEnabled: true,',
  '    geminiTransportEnabled: true,\n    pollinationsTransportEnabled: true,\n    nvidiaTransportEnabled: false,\n    webSurfSelectionEnabled: true,',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  'calls: [{ id: "buffered_1", name: "image_gen", arguments: \'{"prompt":"A lighthouse"}\' }],',
  'calls: [{ id: "buffered_1", name: "image_gen", arguments: \'{"prompt":"A lighthouse","requires_text_rendering":false}\' }],',
);
replaceInFile(
  "backend/testModelToolTransport.ts",
  'call: { id: "fixture_image", name: "image_gen", arguments: { prompt: "A lighthouse" } },',
  'call: { id: "fixture_image", name: "image_gen", arguments: { prompt: "A lighthouse", requires_text_rendering: false } },',
);
replaceInFile(
  "backend/testModelToolProviderTransport.py",
  '    ), patch.object(adapter, "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED", True), patch.object(\n        adapter, "GOOGLE_GENAI_MODULE", object()\n    ),',
  '    ), patch.object(adapter, "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED", True), patch.dict(\n        adapter.os.environ,\n        {\n            "SENTIQ_NVIDIA_PROVIDER_ENABLED": "true",\n            "SENTIQ_NEMOTRON_INTUITIVE_ENABLED": "true",\n        },\n    ), patch.object(\n        adapter, "GOOGLE_GENAI_MODULE", object()\n    ),',
);

console.log("Fixed paid image routing contracts and rollout-gated provider fixtures.");
