import assert from "assert/strict";
import {
  extractTitleFromRaw,
  sanitizeAndValidateTitleCandidate,
  isGenericConversationTitle,
  titleLooksLikeFirstMessageFallback,
} from "./serverLegacy";

// @ts-ignore - JS module without type declaration
import { extractSafeConversationTitle } from "../frontend/scripts/features/chat/title-sanitizer.js";

function testExtractTitleFromRaw(): void {
  console.log("--- 1. Testing extractTitleFromRaw ---");

  // 1. Valid raw JSON
  const validRaw = '{"title":"Python Loop Debugging"}';
  assert.equal(
    extractTitleFromRaw(validRaw),
    "Python Loop Debugging",
    "Valid raw JSON should yield extracted title",
  );

  // 2. Valid fenced JSON
  const validFenced = '```json\n{"title":"Python Loop Debugging"}\n```';
  assert.equal(
    extractTitleFromRaw(validFenced),
    "Python Loop Debugging",
    "Valid fenced JSON should yield extracted title",
  );

  // 3. Exact malformed outputs observed in production
  assert.equal(
    extractTitleFromRaw("```json"),
    "",
    "Malformed '```json' must yield empty string (NO LLM title)",
  );

  assert.equal(
    extractTitleFromRaw("```"),
    "",
    "Malformed '```' must yield empty string (NO LLM title)",
  );

  assert.equal(
    extractTitleFromRaw("```json {"),
    "",
    "Malformed '```json {' must yield empty string (NO LLM title)",
  );

  assert.equal(
    extractTitleFromRaw("{"),
    "",
    "Malformed '{' must yield empty string (NO LLM title)",
  );

  // 4. JSON containing no title field
  assert.equal(
    extractTitleFromRaw('{"foo":"bar"}'),
    "",
    "JSON with no title field must yield empty string (NO LLM title)",
  );

  // 5. Empty and whitespace-only output
  assert.equal(extractTitleFromRaw(""), "", "Empty string must yield empty title");
  assert.equal(extractTitleFromRaw("   \n\t  "), "", "Whitespace must yield empty title");

  // 6. Whitespace normalization
  const padded = '{"title":"   Python   Loop   Debugging   "}';
  assert.equal(
    extractTitleFromRaw(padded),
    "Python Loop Debugging",
    "Whitespace in title must be normalized",
  );

  // 7. Malformed shells inside title field
  assert.equal(
    extractTitleFromRaw('{"title":"```json"}'),
    "",
    "Title containing markdown fence must be rejected",
  );
  assert.equal(
    extractTitleFromRaw('{"title":"{"}'),
    "",
    "Title containing raw brace must be rejected",
  );

  // 8. Oversized title (>120 chars)
  const oversized = `{"title":"${"Word ".repeat(30)}"}`;
  assert.equal(
    extractTitleFromRaw(oversized),
    "",
    "Oversized title must be safely rejected",
  );

  // 9. Provider error payloads
  assert.equal(
    extractTitleFromRaw('{"error":{"message":"Rate limit exceeded","code":429}}'),
    "",
    "Provider error object must yield empty string",
  );
  assert.equal(
    extractTitleFromRaw('{"error":"failed to validate json"}'),
    "",
    "Provider error string must yield empty string",
  );
  assert.equal(
    extractTitleFromRaw('{"status":"error","detail":"Service unavailable"}'),
    "",
    "Provider status error must yield empty string",
  );

  console.log("PASS: All extractTitleFromRaw regression tests passed.");
}

function testTitleReplacementEligibility(): void {
  console.log("--- 2. Testing title replacement eligibility ---");

  const userMessage = "Can you help me understand Python while loops and break statements?";
  const initialFallbackTitle = "Can you help me understand Python while loops and break";

  // Check fallback detection
  assert.equal(
    titleLooksLikeFirstMessageFallback(initialFallbackTitle, userMessage),
    true,
    "Initial title derived from first message must be recognized as fallback",
  );

  assert.equal(
    isGenericConversationTitle("New Chat"),
    true,
    "'New Chat' must be recognized as generic",
  );

  // Case A: Valid Groq title replaces fallback
  const validGroqRaw = '{"title":"Understanding Python Loops"}';
  const extractedValid = extractTitleFromRaw(validGroqRaw);
  assert.equal(extractedValid, "Understanding Python Loops");
  const sourceValid: string = extractedValid ? "llm" : "fallback";
  assert.equal(sourceValid, "llm");

  const canReplaceValid = Boolean(
    true && // allowFallbackReplacement
    sourceValid === "llm" &&
    userMessage &&
    titleLooksLikeFirstMessageFallback(initialFallbackTitle, userMessage)
  );
  assert.equal(canReplaceValid, true, "Valid LLM title MUST be allowed to replace first-message fallback");

  // Case B: Malformed Groq output rejected, fallback remains intact
  const malformedOutputs = ["```json", "```", "```json {", "{", '{"foo":"bar"}'];
  for (const badOutput of malformedOutputs) {
    const extractedBad = extractTitleFromRaw(badOutput);
    assert.equal(extractedBad, "", `Malformed output '${badOutput}' must extract to empty string`);
    const sourceBad: string = extractedBad ? "llm" : "fallback";
    assert.equal(sourceBad, "fallback");

    const canReplaceBad = Boolean(
      true &&
      (sourceBad as any) === "llm" &&
      userMessage &&
      titleLooksLikeFirstMessageFallback(initialFallbackTitle, userMessage)
    );
    assert.equal(canReplaceBad, false, `Malformed output '${badOutput}' MUST NOT replace fallback title`);
  }

  // Case C: User-customized title is protected against overwrite
  const customTitle = "My Custom Python Project";
  const canReplaceCustom = Boolean(
    true &&
    sourceValid === "llm" &&
    userMessage &&
    titleLooksLikeFirstMessageFallback(customTitle, userMessage)
  );
  assert.equal(canReplaceCustom, false, "Custom user title must NOT be replaced by LLM title");

  console.log("PASS: Title replacement eligibility tests passed.");
}

function testFrontendTitleSanitizer(): void {
  console.log("--- 3. Testing frontend title sanitizer ---");

  // Malformed values stored from past corruption
  assert.equal(extractSafeConversationTitle("```json"), "", "```json must be sanitized to empty");
  assert.equal(extractSafeConversationTitle("```"), "", "``` must be sanitized to empty");
  assert.equal(extractSafeConversationTitle("```json {"), "", "```json { must be sanitized to empty");
  assert.equal(extractSafeConversationTitle("{"), "", "{ must be sanitized to empty");
  assert.equal(extractSafeConversationTitle('{"foo":"bar"}'), "", "JSON object with no title must be sanitized to empty");

  // Valid values
  assert.equal(
    extractSafeConversationTitle("Understanding Python Loops"),
    "Understanding Python Loops",
    "Plain valid title must remain unchanged",
  );
  assert.equal(
    extractSafeConversationTitle('{"title":"Understanding Python Loops"}'),
    "Understanding Python Loops",
    "Embedded JSON title must be unwrapped cleanly",
  );

  console.log("PASS: Frontend title sanitizer tests passed.");
}

function run(): void {
  testExtractTitleFromRaw();
  testTitleReplacementEligibility();
  testFrontendTitleSanitizer();
  console.log("\nALL TITLE GENERATION REGRESSION TESTS PASSED SUCCESSFULLY!");
  process.exit(0);
}

run();
