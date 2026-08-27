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
  "conversation title generation must pin the requested Groq model instead of inheriting the global Groq default",
);
assert.match(titleBlock, /max_output_tokens:\s*80/);
assert.match(titleBlock, /budget_class:\s*"auxiliary"/);
assert.match(titleBlock, /auxiliary_budget:\s*"title"/);
assert.match(titleBlock, /skip_wrappers:\s*true/);

// The title-specific override means it must not depend on the global Groq model.
assert.match(
  adapter,
  /GROQ_MODEL\s*=\s*os\.getenv\("GROQ_MODEL",\s*"llama-3\.3-70b-versatile"\)/,
  "baseline confirms the title override is necessary because master still carries the retired global Groq fallback",
);
assert.match(envExample, /GROQ_MODEL=llama-3\.3-70b-versatile/);
assert.match(envExample, /GROQ_CHAT_MODEL=openai\/gpt-oss-120b/);

// Authenticated title requests must not override the title-builder model from the endpoint layer.
const endpointStart = server.indexOf('app.post(\n  "/api/chat/title"');
assert(endpointStart >= 0, "chat title endpoint must exist");
const endpointEnd = server.indexOf('app.', endpointStart + 20);
const endpointBlock = server.slice(endpointStart, endpointEnd > endpointStart ? endpointEnd : endpointStart + 7000);
assert.match(endpointBlock, /modelOverride:\s*isGuest\s*\?\s*GUEST_MODEL_OVERRIDE\s*:\s*undefined/);
assert.match(endpointBlock, /generateTitleWithFallback\(/);

// The provider/model contract used by title generation must remain explicit at source level.
assert.doesNotMatch(
  titleBlock,
  /model_override:\s*"llama-3\.3-70b-versatile"/,
  "the title path must never reference the decommissioned Llama model",
);
assert.doesNotMatch(
  titleBlock,
  /model_override:\s*"openai\/gpt-oss-120b"/,
  "the title path must remain pinned to the requested 20B model rather than ordinary chat's 120B model",
);

console.log("PASS | conversation title routing contract");
console.log("PASS | authenticated title generation explicitly targets Groq openai/gpt-oss-20b");
console.log("PASS | title path is isolated from the retired global Groq default");
console.log("PASS | title path remains distinct from ordinary chat's gpt-oss-120b model");
