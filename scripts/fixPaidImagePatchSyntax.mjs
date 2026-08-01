import fs from "node:fs";

const path = "scripts/applyPaidImageTextRoutingPass2.mjs";
let source = fs.readFileSync(path, "utf8");
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
  [
    "replaceExact(\n  \"backend/testModelToolProviderTransport.py\",\n  '    ), patch.object(adapter, \\\"GOOGLE_GENAI_MODULE\\\", object()\\n    ), patch.object(',\n  '    ), patch.object(adapter, \\\"SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED\\\", True), patch.object(adapter, \\\"GOOGLE_GENAI_MODULE\\\", object()\\n    ), patch.object(',\n  1,\n);\n",
    "",
  ],
];
for (const [before, after] of replacements) {
  if (after && source.includes(after)) continue;
  if (!source.includes(before)) {
    if (!after) continue;
    throw new Error(`Missing patch-script syntax marker: ${before}`);
  }
  source = source.replace(before, after);
}
fs.writeFileSync(path, source, "utf8");
console.log("Fixed paid image routing patch syntax and occurrence counts.");
