import fs from "node:fs";

function updateFile(path, changes) {
  let source = fs.readFileSync(path, "utf8");
  for (const [before, after] of changes) {
    if (source.includes(after)) continue;
    if (!source.includes(before)) throw new Error(`Missing fixture marker in ${path}: ${before}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source, "utf8");
}

updateFile("backend/testModelToolExecution.ts", [
  [
    '    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,\n  };',
    '    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,\n    pollinations: process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED,\n  };',
  ],
  [
    '  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "false";\n  try {',
    '  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "false";\n  process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED = "false";\n  try {',
  ],
  [
    '    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;\n  }',
    '    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;\n    if (previous.pollinations === undefined) delete process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED = previous.pollinations;\n  }',
  ],
  [
    '      arguments: { prompt: "A concise executable image prompt for a puppy" },',
    '      arguments: {\n        prompt: "A concise executable image prompt for a puppy",\n        requires_text_rendering: false,\n      },',
  ],
]);

updateFile("backend/testImageRoutingSafety.ts", [
  [
    '  assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");\n  assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");\n  assert.equal(getImageModelForPlan("student_core", false).model, "zimage");\n  assert.equal(getImageModelForPlan("student_core", true).model, "zimage");\n  assert.equal(getImageModelForPlan("premium", false).model, "zimage");\n  assert.equal(getImageModelForPlan("premium", true).model, "zimage");\n  assert.equal(getImageModelForPlan("pro", false).model, "gpt-image-2");\n  assert.equal(getImageModelForPlan("pro", true).model, "gpt-image-2");',
    '  assert.equal(getImageModelForPlan("free", false).model, "dreamshaper");\n  assert.equal(getImageModelForPlan("free", true).model, "dreamshaper");\n  assert.equal(getImageModelForPlan("student_core", false).model, "zimage");\n  assert.equal(getImageModelForPlan("student_core", true).model, "gpt-image-2");\n  assert.equal(getImageModelForPlan("premium", false).model, "zimage");\n  assert.equal(getImageModelForPlan("premium", true).model, "gpt-image-2");\n  assert.equal(getImageModelForPlan("pro", false).model, "zimage");\n  assert.equal(getImageModelForPlan("pro", true).model, "gpt-image-2");',
  ],
  [
    '  assert.deepEqual(routeOrder("student_core", "a puppy in snow").slice(0, 2), ["zimage", "klein"]);\n  assert.deepEqual(routeOrder("premium", "a detailed poster with text", true).slice(0, 2), ["gpt-image-2", "kontext"]);\n  assert.deepEqual(routeOrder("pro", "a puppy in snow").slice(0, 2), ["zimage", "klein"]);\n  assert.deepEqual(routeOrder("pro", "a detailed poster with text").slice(0, 2), ["gpt-image-2", "kontext"]);',
    '  assert.deepEqual(routeOrder("student_core", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);\n  assert.deepEqual(routeOrder("student_core", "a poster reading Welcome", true).slice(0, 2), ["gpt-image-2", "kontext"]);\n  assert.deepEqual(routeOrder("premium", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);\n  assert.deepEqual(routeOrder("premium", "a detailed poster with text", true).slice(0, 2), ["gpt-image-2", "kontext"]);\n  assert.deepEqual(routeOrder("pro", "a puppy in snow", false).slice(0, 2), ["zimage", "klein"]);\n  assert.deepEqual(routeOrder("pro", "a detailed poster with text", true).slice(0, 2), ["gpt-image-2", "kontext"]);',
  ],
]);

console.log("Aligned model-tool execution and paid image-routing safety fixtures.");
