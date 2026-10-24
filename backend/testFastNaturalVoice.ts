import assert from "node:assert/strict";
import {
  buildChatPrompt,
  FAST_NATURAL_VOICE_INSTRUCTIONS,
  isEligibleFastNaturalVoice,
  type ChatContext,
} from "./ai/PromptBuilders";
import { estimateTextTokens } from "./orchestrator/contextBudgetManager";
import { ChatRequestSchema } from "./validation/schemas";
import { FAST_PROFILE, INTUITIVE_PROFILE } from "./orchestrator/executionProfile";
import { runWithRequestBudgetContext } from "./context/requestBudgetContext";

console.log("[Test] Running Fast Natural Voice Contract & Eligibility Tests...");

// =========================================================================
// 1. Compactness & Token Budget Tests
// =========================================================================
const wordCount = FAST_NATURAL_VOICE_INSTRUCTIONS.trim().split(/\s+/).length;
const estimatedTokens = estimateTextTokens(FAST_NATURAL_VOICE_INSTRUCTIONS);

console.log(`[Test] Voice Profile text length: ${FAST_NATURAL_VOICE_INSTRUCTIONS.length} chars, ${wordCount} words, conservative budget estimate: ${estimatedTokens} tokens.`);
assert(
  wordCount >= 40 && wordCount <= 60,
  `Voice profile word count should be approximately 40-50 words (got ${wordCount})`,
);
// In standard BPE tokenizers (GPT/Groq/Gemini), 50 English words is ~45-55 tokens.
// contextBudgetManager uses a conservative upper-bound heuristic (max(bytes/3, words*1.5)).
assert(
  estimatedTokens <= 120,
  `Voice profile conservative token estimate must remain compact (got ${estimatedTokens})`,
);

// =========================================================================
// 2. Unit Eligibility Helper Tests (isEligibleFastNaturalVoice)
// =========================================================================
const baseEligibleContext: ChatContext = {
  userMessage: "What is quantum computing in simple terms?",
  executionMode: "fast",
  fastNaturalVoice: true,
  modelOverride: "gpt-oss-120b",
};

assert.equal(isEligibleFastNaturalVoice(baseEligibleContext), true, "Base fast plain text request must be eligible");

// Untrusted / missing flag
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, fastNaturalVoice: undefined }),
  false,
  "Missing fastNaturalVoice flag must fail closed",
);
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, fastNaturalVoice: false }),
  false,
  "Explicit false fastNaturalVoice must fail closed",
);

// Intuitive mode exclusion
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, executionMode: "intuitive" }),
  false,
  "Intuitive mode must NOT be eligible",
);
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, executionMode: undefined }),
  false,
  "Undefined execution mode must NOT be eligible",
);

// File analysis exclusion
assert.equal(
  isEligibleFastNaturalVoice({
    ...baseEligibleContext,
    fileReferences: [{ filename: "doc.txt", extractedText: "sample" }],
  }),
  false,
  "Requests with file references must NOT be eligible",
);

// Image input exclusion
assert.equal(
  isEligibleFastNaturalVoice({
    ...baseEligibleContext,
    imageAttachments: [{
      filename: "test.png",
      mime_type: "image/png",
      base64: "AAAA",
      size_bytes: 4,
    }],
  }),
  false,
  "Requests with image attachments must NOT be eligible",
);

// Math and reasoning exclusions
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, mathMode: true }),
  false,
  "Dedicated math mode must NOT be eligible",
);
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, reasoningMode: true }),
  false,
  "Dedicated reasoning mode must NOT be eligible",
);

// WebSurf & search synthesis exclusions
assert.equal(
  isEligibleFastNaturalVoice({ ...baseEligibleContext, webSurfSourceIds: ["S1", "S2"] }),
  false,
  "Requests with WebSurf source IDs must NOT be eligible",
);
assert.equal(
  isEligibleFastNaturalVoice({
    ...baseEligibleContext,
    webSurfAnswerPlan: {
      profile: "fast_fact",
      asOfDate: "2026-10-24",
      primaryEntity: "Query",
      interpretation: "direct",
      requiredCoverageGoals: [],
      optionalCoverageGoals: [],
      sections: [],
      maxSections: 2,
      maxWords: 150,
      tablePolicy: "forbidden",
      maxTableRows: 0,
      citationPolicy: {
        currentClaimsRequireCitation: true,
        numericClaimsRequireCitation: true,
        datesRequireCitation: true,
        minimumDistinctSources: 1,
      },
      uncertaintyPolicy: "state_conflicts",
      followUpPolicy: "none",
    } as any,
  }),
  false,
  "Requests with WebSurf answer plan must NOT be eligible",
);

// Route evidence / multi-step synthesis exclusion
assert.equal(
  isEligibleFastNaturalVoice({
    ...baseEligibleContext,
    routeEvidence: [{ content: "prior step result", required: true }],
  }),
  false,
  "Requests with route evidence must NOT be eligible",
);

// =========================================================================
// 3. Prompt Composition & Effective Model Call Tests
// =========================================================================

// Case A: Ordinary Fast-mode text reply (Signed-in or Guest)
const fastCall = buildChatPrompt(baseEligibleContext);
assert(
  fastCall.prompt.includes("STYLE & VOICE:"),
  "Eligible Fast-mode call must include the voice profile header",
);
assert(
  fastCall.prompt.includes("Grounded, direct and quietly warm."),
  "Eligible Fast-mode call must include the voice profile instructions",
);
assert.equal(
  fastCall.execution_mode,
  "fast",
  "LLMAdapterCall should preserve execution_mode",
);

// Applied exactly once
const occurrences = fastCall.prompt.split("Grounded, direct and quietly warm.").length - 1;
assert.equal(occurrences, 1, "Voice profile instructions must appear exactly once in prompt");

// Included before final context composition and before context rules
const voiceIndex = fastCall.prompt.indexOf("STYLE & VOICE:");
const contextRulesIndex = fastCall.prompt.indexOf("CONTEXT HANDLING RULES:");
const userMessageIndex = fastCall.prompt.indexOf("What is quantum computing in simple terms?");
assert(voiceIndex !== -1, "Voice profile must be present");
assert(contextRulesIndex !== -1, "Context handling rules must be present");
assert(voiceIndex < contextRulesIndex, "Voice profile must precede context handling rules");
assert(contextRulesIndex < userMessageIndex, "Context rules must precede user message");

// Safety rules and context provenance rules preserved
assert(
  fastCall.prompt.includes("SAFETY RULES (always observe these):"),
  "Safety rules must be preserved in prompt",
);
assert(
  fastCall.prompt.includes("CONTEXT PROVENANCE RULES:"),
  "Context provenance rules must be preserved in prompt",
);

// Case B: Eligible Fast follow-up conversation with history & memories
const fastFollowUpCall = buildChatPrompt({
  ...baseEligibleContext,
  userMessage: "Can you elaborate on superpositions?",
  recentMessages: [
    { role: "user", content: "What is quantum computing?" },
    { role: "assistant", content: "Quantum computing uses qubits." },
  ],
  memories: [
    { type: "interest", summary: "User is interested in physics.", importance: 7 },
  ],
  conversationCapsule: "User is studying quantum physics.",
});
assert(
  fastFollowUpCall.prompt.includes("STYLE & VOICE:"),
  "Eligible follow-up conversation must include voice profile",
);
assert(
  fastFollowUpCall.prompt.includes("User is interested in physics."),
  "Saved memories must be retained alongside the voice profile",
);
assert(
  fastFollowUpCall.prompt.includes("User is studying quantum physics."),
  "Conversation capsule must be retained alongside the voice profile",
);

// Case C: Intuitive-mode requests do NOT receive the profile
const intuitiveCall = buildChatPrompt({
  userMessage: "Explain quantum computing in detail.",
  executionMode: "intuitive",
  fastNaturalVoice: false,
  modelOverride: "gpt-oss-120b",
});
assert(
  !intuitiveCall.prompt.includes("STYLE & VOICE:"),
  "Intuitive request must NOT receive the voice profile",
);
assert(
  !intuitiveCall.prompt.includes("Grounded, direct and quietly warm."),
  "Intuitive request must NOT receive voice profile text",
);

// Even if client/caller attempts to pass fastNaturalVoice: true with Intuitive mode:
const intuitiveAttemptCall = buildChatPrompt({
  userMessage: "Explain quantum computing in detail.",
  executionMode: "intuitive",
  fastNaturalVoice: true,
  modelOverride: "gpt-oss-120b",
});
assert(
  !intuitiveAttemptCall.prompt.includes("STYLE & VOICE:"),
  "Intuitive request with fastNaturalVoice flag must fail closed",
);

// Case D: Requests with files do NOT receive the profile
const fileCall = buildChatPrompt({
  userMessage: "Summarize this uploaded document.",
  executionMode: "fast",
  fastNaturalVoice: true,
  fileReferences: [{ filename: "report.pdf", extractedText: "Quarterly earnings report content." }],
});
assert(
  !fileCall.prompt.includes("STYLE & VOICE:"),
  "File analysis must NOT receive the fast natural voice profile",
);
assert(
  fileCall.prompt.includes("FILE ANALYSIS MODE:"),
  "File analysis mode instructions must be present",
);

// Case E: Web search synthesis does NOT receive the profile
const webSurfCall = buildChatPrompt({
  userMessage: "What are the latest SpaceX launches?",
  executionMode: "fast",
  fastNaturalVoice: true,
  webSurfSourceIds: ["S1", "S2"],
});
assert(
  !webSurfCall.prompt.includes("STYLE & VOICE:"),
  "WebSurf synthesis must NOT receive the fast natural voice profile",
);
assert(
  webSurfCall.prompt.includes("WEBSURF SOURCE RULES:"),
  "WebSurf rules must be present instead",
);

// Case F: Dedicated math mode does NOT receive the profile
const mathCall = runWithRequestBudgetContext(
  { planCode: "pro", executionMode: "fast", resolution: "billing" },
  () => buildChatPrompt({
    userMessage: "Solve 2x + 5 = 15",
    executionMode: "fast",
    fastNaturalVoice: true,
    mathMode: true,
  }),
);
assert(
  !mathCall.prompt.includes("STYLE & VOICE:"),
  "Math mode must NOT receive the fast natural voice profile",
);

// Case G: Default fallback model (non-mistral/groq) also receives profile when eligible
const defaultModelCall = buildChatPrompt({
  userMessage: "Hello, how are you?",
  executionMode: "fast",
  fastNaturalVoice: true,
  modelOverride: "gemini",
});
assert(
  defaultModelCall.prompt.includes("STYLE & VOICE:"),
  "Default model in eligible Fast mode must also receive the voice profile",
);
assert(
  defaultModelCall.prompt.includes("KNOWLEDGE RULES:"),
  "Default system prompt safety rules must remain intact",
);

// =========================================================================
// 4. Client Request Schema Security Test
// =========================================================================
const clientPayload = {
  message: "Hello world",
  executionMode: "fast",
  fastNaturalVoice: true, // Attacker or client attempting to inject internal flag
  fast_natural_voice: true,
};
const parsed = ChatRequestSchema.parse(clientPayload);
assert.equal(
  (parsed as any).fastNaturalVoice,
  undefined,
  "ChatRequestSchema must not expose fastNaturalVoice to client",
);
assert.equal(
  (parsed as any).fast_natural_voice,
  undefined,
  "ChatRequestSchema must not expose fast_natural_voice to client",
);

console.log("PASS | All Fast Natural Voice Contract & Eligibility Tests Passed.");
