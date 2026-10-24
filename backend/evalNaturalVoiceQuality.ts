import assert from "node:assert/strict";
import {
  buildChatPrompt,
  FAST_NATURAL_VOICE_INSTRUCTIONS,
  isEligibleFastNaturalVoice,
  type ChatContext,
} from "./ai/PromptBuilders";
import { runWithRequestBudgetContext } from "./context/requestBudgetContext";

export interface EvalCase {
  id: number;
  category: string;
  userMessage: string;
  isSpecializedControl?: boolean;
  specializedContext?: Partial<ChatContext>;
  expectedEligible: boolean;
  notes: string;
}

export const EVALUATION_PROMPTS: readonly EvalCase[] = [
  // 1. Simple factual questions
  {
    id: 1,
    category: "Simple factual questions",
    userMessage: "What is the capital of Australia, and why was it chosen over Sydney or Melbourne?",
    expectedEligible: true,
    notes: "Direct factual response without canned opening like 'Certainly! That's a great question.'",
  },
  {
    id: 2,
    category: "Simple factual questions",
    userMessage: "How many kilometers are in a light-year, and how is it calculated?",
    expectedEligible: true,
    notes: "Straightforward numerical definition without inflated excitement.",
  },

  // 2. Greetings and casual conversation
  {
    id: 3,
    category: "Greetings and casual conversation",
    userMessage: "Hey, how's it going today?",
    expectedEligible: true,
    notes: "Quietly warm, natural conversational reply without simulated human feelings or forced enthusiasm.",
  },
  {
    id: 4,
    category: "Greetings and casual conversation",
    userMessage: "I'm thinking about going for a walk, but it looks a bit cloudy outside.",
    expectedEligible: true,
    notes: "Casual relaxed tone matching user rhythm without preachy weather advice.",
  },

  // 3. Explanations
  {
    id: 5,
    category: "Explanations",
    userMessage: "Explain how photosynthesis works to a 10-year-old.",
    expectedEligible: true,
    notes: "Clear, engaging explanation without patronizing tone or robotic AI transitions.",
  },
  {
    id: 6,
    category: "Explanations",
    userMessage: "Why is the night sky dark if the universe has billions of stars? Explain Olbers' paradox.",
    expectedEligible: true,
    notes: "Direct scientific explanation without 'In today's vast universe...' cliché.",
  },

  // 4. Technical troubleshooting
  {
    id: 7,
    category: "Technical troubleshooting",
    userMessage: "My Node.js backend crashes with 'ECONNREFUSED 127.0.0.1:5432'. What should I check first?",
    expectedEligible: true,
    notes: "Direct diagnostic steps without generic 'Don't worry, I can help you fix this!' intro.",
  },
  {
    id: 8,
    category: "Technical troubleshooting",
    userMessage: "I have a merge conflict in package-lock.json after pulling master. What's the cleanest way to resolve it?",
    expectedEligible: true,
    notes: "Concise command instructions without formulaic closing 'Let me know if you run into any more issues!'.",
  },

  // 5. Constructive disagreement
  {
    id: 9,
    category: "Constructive disagreement",
    userMessage: "Isn't microservices architecture always superior to a monolith for any new project?",
    expectedEligible: true,
    notes: "Thoughtful disagreement highlighting trade-offs without generic validation or fawning praise.",
  },
  {
    id: 10,
    category: "Constructive disagreement",
    userMessage: "Adding more engineers to a delayed software project is the quickest way to catch up, right?",
    expectedEligible: true,
    notes: "Polite, reasoned correction (referencing Brooks's Law) without robotic phrases.",
  },

  // 6. User frustration or uncertainty
  {
    id: 11,
    category: "User frustration or uncertainty",
    userMessage: "I've spent 4 hours on this flexbox bug and nothing is aligning. I'm ready to throw my computer out the window.",
    expectedEligible: true,
    notes: "Empathetic and practical without canned therapeutic filler or synthetic cheerleading.",
  },
  {
    id: 12,
    category: "User frustration or uncertainty",
    userMessage: "I don't know if I should learn Rust or Go first for backend services. I'm feeling overwhelmed by all the opinions.",
    expectedEligible: true,
    notes: "Grounded guidance cutting through hype to the practical trade-offs.",
  },

  // 7. Difficult personal topics
  {
    id: 13,
    category: "Difficult personal topics",
    userMessage: "My elderly cat passed away yesterday after 15 years. My apartment feels completely empty.",
    expectedEligible: true,
    notes: "Warm, respectful, genuine condolence without canned robotic therapy scripts.",
  },
  {
    id: 14,
    category: "Difficult personal topics",
    userMessage: "I received very negative feedback on a presentation today and feel humiliated.",
    expectedEligible: true,
    notes: "Grounding perspective without hollow toxic positivity.",
  },

  // 8. Formal email and professional writing requests
  {
    id: 15,
    category: "Formal email and professional writing requests",
    userMessage: "Write a formal email to our client explaining that their shipment will be delayed by 3 business days due to customs clearance.",
    expectedEligible: true,
    notes: "Maintains required formal business tone; personality does not make business writing artificially casual.",
  },
  {
    id: 16,
    category: "Formal email and professional writing requests",
    userMessage: "Draft a concise, professional letter of resignation to my director providing two weeks' notice.",
    expectedEligible: true,
    notes: "Professional, dignified, compliant with standard resignation letter conventions.",
  },

  // 9. Code and structured-output requests
  {
    id: 17,
    category: "Code and structured-output requests",
    userMessage: "Write a TypeScript debounce function with generic arguments and return type.",
    expectedEligible: true,
    notes: "Delivers clean, correct code with minimal chatty filler.",
  },
  {
    id: 18,
    category: "Code and structured-output requests",
    userMessage: "Create a Markdown table comparing SQLite, PostgreSQL, and Redis across primary use case, storage model, and replication support.",
    expectedEligible: true,
    notes: "Produces structured table directly without conversational preamble.",
  },

  // 10. Specialised-route control cases (Must NOT receive voice profile)
  {
    id: 19,
    category: "Specialised-route control cases",
    userMessage: "Solve the system of equations 3x + 2y = 12 and x - y = 1 step by step.",
    isSpecializedControl: true,
    specializedContext: { mathMode: true },
    expectedEligible: false,
    notes: "Dedicated math mode must retain full mathematical/LaTeX system prompt without voice profile.",
  },
  {
    id: 20,
    category: "Specialised-route control cases",
    userMessage: "What does the uploaded quarterly report say about Q3 operating margins?",
    isSpecializedControl: true,
    specializedContext: {
      fileReferences: [{ filename: "q3_report.pdf", extractedText: "Operating margins were 18.2%." }],
    },
    expectedEligible: false,
    notes: "File analysis route must retain FILE ANALYSIS MODE instructions without voice profile.",
  },
  {
    id: 21,
    category: "Specialised-route control cases",
    userMessage: "What are the latest launch dates for NASA Artemis II mission?",
    isSpecializedControl: true,
    specializedContext: {
      webSurfSourceIds: ["S1", "S2"],
    },
    expectedEligible: false,
    notes: "WebSurf synthesis route must retain WEBSURF SOURCE RULES without voice profile.",
  },
  {
    id: 22,
    category: "Specialised-route control cases",
    userMessage: "Analyze this image and extract all text visible on the signboard.",
    isSpecializedControl: true,
    specializedContext: {
      imageAttachments: [{
        filename: "signboard.jpg",
        mime_type: "image/jpeg",
        base64: "dGVzdA==",
        size_bytes: 4,
      }],
    },
    expectedEligible: false,
    notes: "Image input route must retain IMAGE INPUT MODE without voice profile.",
  },
  {
    id: 23,
    category: "Specialised-route control cases",
    userMessage: "Analyze the trade-offs in depth.",
    isSpecializedControl: true,
    specializedContext: {
      executionMode: "intuitive",
      fastNaturalVoice: false,
    },
    expectedEligible: false,
    notes: "Intuitive execution mode must NOT receive fast natural voice profile.",
  },
  {
    id: 24,
    category: "Specialised-route control cases",
    userMessage: "Synthesize the results from step 1.",
    isSpecializedControl: true,
    specializedContext: {
      routeEvidence: [{ content: "Step 1 result: user data extracted", required: true }],
    },
    expectedEligible: false,
    notes: "Multi-step tool synthesis with route evidence must NOT receive voice profile.",
  },
  {
    id: 25,
    category: "Specialised-route control cases",
    userMessage: "Explain gravity.",
    isSpecializedControl: true,
    specializedContext: {
      reasoningMode: true,
    },
    expectedEligible: false,
    notes: "Dedicated reasoning mode must NOT receive voice profile.",
  },
];
// Stylistic evaluation heuristics
export interface StyleMetrics {
  hasCannedOpening: boolean;
  cannedOpeningMatch?: string;
  hasStockClosing: boolean;
  stockClosingMatch?: string;
  emojiCount: number;
  emDashCount: number;
  wordCount: number;
  hasAiClichés: boolean;
  aiClichéMatch?: string;
}

const CANNED_OPENINGS = [
  /^(?:absolutely|certainly|sure thing|great question|that's a great question|i'd be happy to (?:help|assist)|i'd love to help|let's dive into|welcome to|of course)[!.,:]/i,
  /^(?:i(?:'m| am) (?:thrilled|delighted|happy) to (?:help|assist)|what a fantastic idea)/i,
];

const STOCK_CLOSINGS = [
  /(?:let me know if you (?:need|have any|have further|require)[^.!?\n]*|feel free to (?:ask|reach out)[^.!?\n]*|hope (?:this|that) helps|i'm here to help)[!.]?\s*$/i,
];

const AI_CLICHES = [
  /\bit's not just\b[\s\S]*?\bit's\b/i,
  /\bin today's fast-paced world\b/i,
  /\bhere's the ultimate guide\b/i,
  /\ba testament to\b/i,
  /\bdelve into\b/i,
];

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

export function analyzeStyle(text: string): StyleMetrics {
  const trimmed = text.trim();
  let hasCannedOpening = false;
  let cannedOpeningMatch: string | undefined;
  for (const pattern of CANNED_OPENINGS) {
    const match = trimmed.match(pattern);
    if (match) {
      hasCannedOpening = true;
      cannedOpeningMatch = match[0];
      break;
    }
  }

  let hasStockClosing = false;
  let stockClosingMatch: string | undefined;
  for (const pattern of STOCK_CLOSINGS) {
    const match = trimmed.match(pattern);
    if (match) {
      hasStockClosing = true;
      stockClosingMatch = match[0];
      break;
    }
  }

  let hasAiClichés = false;
  let aiClichéMatch: string | undefined;
  for (const pattern of AI_CLICHES) {
    const match = trimmed.match(pattern);
    if (match) {
      hasAiClichés = true;
      aiClichéMatch = match[0];
      break;
    }
  }

  const emDashMatches = trimmed.match(/—|--/g) ?? [];
  const emojis = trimmed.match(new RegExp(EMOJI_REGEX.source, "gu")) ?? [];
  const words = (trimmed.match(/\S+/g) ?? []).length;

  return {
    hasCannedOpening,
    cannedOpeningMatch,
    hasStockClosing,
    stockClosingMatch,
    emojiCount: emojis.length,
    emDashCount: emDashMatches.length,
    wordCount: words,
    hasAiClichés,
    aiClichéMatch,
  };
}

export interface StyleFixture {
  description: string;
  text: string;
  expected: Partial<StyleMetrics>;
}

export const STYLE_ANALYSIS_FIXTURES: readonly StyleFixture[] = [
  // Canned openings: Positive fixtures
  {
    description: "Canned opening: 'Certainly!'",
    text: "Certainly! Here are the steps to configure your database.",
    expected: { hasCannedOpening: true },
  },
  {
    description: "Canned opening: 'Great question!'",
    text: "Great question! Let's explore the causes of Olbers' paradox.",
    expected: { hasCannedOpening: true },
  },
  {
    description: "Canned opening: 'Absolutely,'",
    text: "Absolutely, I would be glad to help with that problem.",
    expected: { hasCannedOpening: true },
  },
  {
    description: "Canned opening: 'I'm thrilled to help'",
    text: "I'm thrilled to help you build your new web application.",
    expected: { hasCannedOpening: true },
  },
  {
    description: "Canned opening: 'Sure thing!'",
    text: "Sure thing! Let's dive into this issue together.",
    expected: { hasCannedOpening: true },
  },
  // Canned openings: Negative fixtures (direct openings)
  {
    description: "Direct opening: Factual statement",
    text: "The capital of Australia is Canberra.",
    expected: { hasCannedOpening: false },
  },
  {
    description: "Direct opening: Troubleshooting check",
    text: "Check if the PostgreSQL service is listening on port 5432.",
    expected: { hasCannedOpening: false },
  },
  {
    description: "Direct opening: Constructive disagreement",
    text: "No. Microservices are not automatically superior to a monolith for every project.",
    expected: { hasCannedOpening: false },
  },

  // Stock closings: Positive fixtures
  {
    description: "Stock closing: 'Let me know if you need anything else!'",
    text: "Your server configuration is updated. Let me know if you need anything else!",
    expected: { hasStockClosing: true },
  },
  {
    description: "Stock closing: 'Hope this helps.'",
    text: "The syntax error was caused by a missing bracket. Hope this helps.",
    expected: { hasStockClosing: true },
  },
  {
    description: "Stock closing: 'Feel free to reach out'",
    text: "Here is the summary of the meeting. Feel free to reach out if you have questions.",
    expected: { hasStockClosing: true },
  },
  // Stock closings: Negative fixtures (direct conclusions)
  {
    description: "Direct closing: Actionable command",
    text: "Run `npm run build` to verify the compiled bundle.",
    expected: { hasStockClosing: false },
  },
  {
    description: "Direct closing: Technical explanation end",
    text: "This satisfies the invariant that timestamps are monotonically increasing.",
    expected: { hasStockClosing: false },
  },

  // AI clichés: Positive fixtures
  {
    description: "AI cliché: 'In today's fast-paced world...'",
    text: "In today's fast-paced world, software teams must deliver value rapidly.",
    expected: { hasAiClichés: true },
  },
  {
    description: "AI cliché: 'It's not just X; it's Y'",
    text: "It's not just a database; it's an intelligent knowledge engine.",
    expected: { hasAiClichés: true },
  },
  {
    description: "AI cliché: 'delve into'",
    text: "Let's delve into the nuances of quantum entanglement.",
    expected: { hasAiClichés: true },
  },
  {
    description: "AI cliché: 'a testament to'",
    text: "The architectural design stands as a testament to modular design principles.",
    expected: { hasAiClichés: true },
  },
  // AI clichés: Negative fixtures
  {
    description: "Natural phrasing without clichés",
    text: "Modern teams deploy changes frequently using automated continuous integration.",
    expected: { hasAiClichés: false },
  },

  // Em dash counts
  {
    description: "Multiple em dashes counted accurately",
    text: "Canberra was chosen — not Sydney — because of historical rivalry — a classic compromise.",
    expected: { emDashCount: 3 },
  },
  {
    description: "Double hyphen em dashes counted",
    text: "Step 1 -- initialize the database. Step 2 -- seed plans.",
    expected: { emDashCount: 2 },
  },
  {
    description: "Zero em dashes in clean text",
    text: "Sydney and Melbourne were both major candidates for the capital.",
    expected: { emDashCount: 0 },
  },

  // Emoji counts
  {
    description: "Emojis counted accurately",
    text: "Congratulations on the launch! 🎉 Rocket ready 🚀✨",
    expected: { emojiCount: 3 },
  },
  {
    description: "Zero emojis in professional text",
    text: "The shipment was delayed by 3 business days due to customs clearance.",
    expected: { emojiCount: 0 },
  },
];

export function testAnalyzeStyleFixtures(): number {
  console.log("-------------------------------------------------------------------------------");
  console.log("Part 1: Deterministic Style Heuristic Unit Tests (analyzeStyle fixtures)");
  console.log("-------------------------------------------------------------------------------");

  let passed = 0;
  for (const fixture of STYLE_ANALYSIS_FIXTURES) {
    const metrics = analyzeStyle(fixture.text);
    for (const [key, expectedVal] of Object.entries(fixture.expected)) {
      const actualVal = (metrics as unknown as Record<string, unknown>)[key];
      assert.equal(
        actualVal,
        expectedVal,
        `Fixture '${fixture.description}' failed on metric '${key}': expected ${expectedVal}, got ${actualVal}`,
      );
    }
    passed += 1;
    console.log(`  [OK] ${fixture.description}`);
  }

  console.log(`\nStyle Heuristic Unit Tests: ${passed}/${STYLE_ANALYSIS_FIXTURES.length} fixtures passed.\n`);
  return passed;
}

export function testPromptContracts(): { totalCases: number; promptChecksPassed: number; eligibleCount: number; nonEligibleCount: number } {
  console.log("-------------------------------------------------------------------------------");
  console.log("Part 2: Fast Natural Voice Prompt Contract & Eligibility Verification (25 Prompts)");
  console.log("-------------------------------------------------------------------------------");

  let totalCases = 0;
  let eligibleCount = 0;
  let nonEligibleCount = 0;
  let promptChecksPassed = 0;

  for (const testCase of EVALUATION_PROMPTS) {
    totalCases += 1;
    const ctx: ChatContext = {
      userMessage: testCase.userMessage,
      executionMode: testCase.specializedContext?.executionMode ?? "fast",
      fastNaturalVoice: !testCase.isSpecializedControl,
      modelOverride: "gpt-oss-120b",
      ...testCase.specializedContext,
    };

    const isEligible = isEligibleFastNaturalVoice(ctx);
    if (isEligible) eligibleCount += 1;
    else nonEligibleCount += 1;

    assert.equal(
      isEligible,
      testCase.expectedEligible,
      `Case ${testCase.id} [${testCase.category}] expected eligible=${testCase.expectedEligible}, got ${isEligible}`,
    );

    // Build effective prompt
    const call = runWithRequestBudgetContext(
      { planCode: "pro", executionMode: ctx.executionMode ?? "fast", resolution: "billing" },
      () => buildChatPrompt(ctx),
    );

    const hasVoiceProfile = call.prompt.includes("STYLE & VOICE:");
    assert.equal(
      hasVoiceProfile,
      testCase.expectedEligible,
      `Case ${testCase.id} [${testCase.category}] prompt contains STYLE & VOICE: expected ${testCase.expectedEligible}, got ${hasVoiceProfile}`,
    );

    promptChecksPassed += 1;
    console.log(
      `  [Case ${String(testCase.id).padStart(2, "0")}] ${testCase.category.padEnd(46, " ")} | Eligible: ${String(isEligible).padEnd(5)} | Profile in Prompt: ${String(hasVoiceProfile).padEnd(5)} | Status: OK`,
    );
  }

  return { totalCases, promptChecksPassed, eligibleCount, nonEligibleCount };
}

export async function runEvaluation(): Promise<void> {
  console.log("===============================================================================");
  console.log("SentIQ Chat — Fast Natural Voice Prompt Contract & Style Heuristics Verification");
  console.log("===============================================================================");
  console.log("[SCOPE NOTICE]");
  console.log("This deterministic test suite verifies prompt construction contracts, token");
  console.log("accounting, route eligibility, and style-analysis heuristic detectors.");
  console.log("It runs 100% deterministically with ZERO external model calls.");
  console.log("Passing these checks confirms correct prompt assembly and heuristic classification;");
  console.log("it does NOT assert or prove generated prose quality from an actual LLM.");
  console.log("For empirical before-and-after model output evaluation, run:");
  console.log("  SENTIQ_NATURAL_VOICE_LIVE_EVAL=1 npm run eval:natural-voice:live\n");

  const stylePassed = testAnalyzeStyleFixtures();
  const contractResults = testPromptContracts();

  console.log("\n===============================================================================");
  console.log("Verification Summary:");
  console.log(`- Style Heuristic Fixtures: ${stylePassed}/${STYLE_ANALYSIS_FIXTURES.length} passed.`);
  console.log(`- Prompt Contract & Eligibility Cases: ${contractResults.promptChecksPassed}/${contractResults.totalCases} verified.`);
  console.log(`  * Eligible Fast text cases: ${contractResults.eligibleCount}`);
  console.log(`  * Excluded specialised/intuitive control cases: ${contractResults.nonEligibleCount}`);
  console.log("- External Model Calls Made: 0 (deterministic offline verification)");
  console.log("===============================================================================");
  console.log("Prompt contract and heuristic integrity checks completed successfully.");
  console.log("===============================================================================\n");
}

if (require.main === module) {
  runEvaluation().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
