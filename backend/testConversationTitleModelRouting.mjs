import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const promptBuilders = fs.readFileSync(path.join(root, "backend/ai/PromptBuilders.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "backend/server.ts"), "utf8");
const adapter = fs.readFileSync(path.join(root, "llm_adapter.py"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

const titleStart = promptBuilders.indexOf("export function buildTitleGeneratePrompt");
assert(titleStart >= 0, "title prompt builder must exist");
const titleEnd = promptBuilders.indexOf("// ==============================\n// Fallback response", titleStart);
assert(titleEnd > titleStart, "title prompt builder boundary must exist");
const titleBlock = promptBuilders.slice(titleStart, titleEnd);

assert.match(titleBlock, /task:\s*"general"/);
assert.match(titleBlock, /prefer:\s*"groq"/);
assert.match(
  titleBlock,
  /model_override:\s*"openai\/gpt-oss-20b"/,
  "conversation title generation must pin the requested Groq model instead of inheriting the retired global default",
);
assert.match(titleBlock, /max_output_tokens:\s*80/);
assert.match(titleBlock, /skip_wrappers:\s*true/);

assert.match(
  adapter,
  /GROQ_MODEL\s*=\s*os\.getenv\("GROQ_MODEL",\s*"llama-3\.3-70b-versatile"\)/,
  "the legacy global default is still identifiable, so the title test proves the override is intentional",
);
assert.match(envExample, /GROQ_MODEL=llama-3\.3-70b-versatile/);
assert.match(envExample, /GROQ_CHAT_MODEL=openai\/gpt-oss-120b/);

const titleParserStart = server.indexOf("function extractTitleFromRaw");
assert(titleParserStart >= 0, "server title parser must exist");
const titleParserEnd = server.indexOf("type TitleGenerationResult", titleParserStart);
assert(titleParserEnd > titleParserStart, "server title parser boundary must exist");
const titleParserBlock = server.slice(titleParserStart, titleParserEnd);

assert.match(titleParserBlock, /const fallbackTitle\s*=\s*fallbackTitleFromMessage|JSON\.parse|strictParseJsonObject|title/);
assert.match(
  titleParserBlock,
  /return\s+normalizeTitleCandidate\(trimmed\);/,
  "baseline parser contract is present before the hardened fallback guard is applied",
);

console.log("PASS | conversation title routing regression contract");
console.log("PASS | title model is pinned to openai/gpt-oss-20b through the Groq transport");
