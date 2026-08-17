import assert from "node:assert/strict";
import { extractSafeConversationTitle } from "../scripts/features/chat/title-sanitizer.js";

const cases = [
  ["clean title", "Natural Testosterone Boost", "Natural Testosterone Boost"],
  ["plain whitespace", "  Clean   Chat Title  ", "Clean Chat Title"],
  ["valid JSON", '{"title":"Python Loop Debugging"}', "Python Loop Debugging"],
  ["fenced JSON", '```json\n{"title":"Groq Title Regression"}\n```', "Groq Title Regression"],
  ["incomplete JSON envelope", '```json\n{"title":"Recovered Title"', "Recovered Title"],
  ["fence only", "```json", ""],
  ["fence plus partial object", "```json {", ""],
  ["closing fence only", "```", ""],
  ["raw JSON object without title", '{"reply":"hello"}', ""],
  ["oversized plain title", "x".repeat(140), "x".repeat(120)],
];

for (const [name, raw, expected] of cases) {
  assert.equal(extractSafeConversationTitle(raw), expected, name);
}

console.log(`PASS | ${cases.length} conversation title sanitization cases`);
