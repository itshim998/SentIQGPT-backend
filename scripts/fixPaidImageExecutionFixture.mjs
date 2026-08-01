import fs from "node:fs";

const path = "backend/testModelToolExecution.ts";
let source = fs.readFileSync(path, "utf8");

function replaceOnce(before, after) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Missing model-tool execution fixture marker: ${before}`);
  source = source.replace(before, after);
}

replaceOnce(
  '    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,\n  };',
  '    groq: process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,\n    pollinations: process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED,\n  };',
);
replaceOnce(
  '  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "false";\n  try {',
  '  process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = "false";\n  process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED = "false";\n  try {',
);
replaceOnce(
  '    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;\n  }',
  '    if (previous.groq === undefined) delete process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED = previous.groq;\n    if (previous.pollinations === undefined) delete process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED;\n    else process.env.SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED = previous.pollinations;\n  }',
);

fs.writeFileSync(path, source, "utf8");
console.log("Aligned the all-transports-off model tool execution fixture.");
