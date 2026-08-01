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
];
for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`Missing patch-script syntax marker: ${before}`);
  source = source.replace(before, after);
}
fs.writeFileSync(path, source, "utf8");
console.log("Fixed paid image routing patch syntax and occurrence counts.");
