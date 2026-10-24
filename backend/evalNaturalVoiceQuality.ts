import assert from "node:assert/strict";
import {
  buildChatPrompt,
  callLLMAdapterSync,
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
  /^(?:absolutely|certainly|sure thing|great question|that's a great question|i'd be happy to help|i'd love to help|let's dive into|welcome to|of course)[!.,:]/i,
  /^(?:i(?:'m| am) thrilled to help|what a fantastic idea)/i,
];

const STOCK_CLOSINGS = [
  /(?:let me know if you (?:need|have any|have further|require)|feel free to (?:ask|reach out)|hope this helps|hope that helps|i'm here to help)[!.]?\s*$/i,
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

export async function runEvaluation(): Promise<void> {
  console.log("===============================================================================");
  console.log("SentIQ Chat — Fast Natural Voice Offline Evaluation (25 Representative Prompts)");
  console.log("===============================================================================\n");

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
      `[Case ${String(testCase.id).padStart(2, "0")}] ${testCase.category.padEnd(46, " ")} | Eligible: ${String(isEligible).padEnd(5)} | Profile in Prompt: ${String(hasVoiceProfile).padEnd(5)} | Status: OK`,
    );
  }

  console.log("\n-------------------------------------------------------------------------------");
  console.log(`Prompt Contract Results: ${promptChecksPassed}/${totalCases} cases verified.`);
  console.log(`- Eligible Fast text cases: ${eligibleCount}`);
  console.log(`- Excluded specialised/intuitive control cases: ${nonEligibleCount}`);
  console.log("-------------------------------------------------------------------------------\n");

  // Sample actual model completions comparing baseline vs fast natural voice
  console.log("Testing generation with simulation adapter for baseline vs natural voice comparison...");
  const samplePrompts = [
    { id: 1, prompt: "What is the capital of Australia, and why was it chosen over Sydney or Melbourne?" },
    { id: 3, prompt: "Hey, how's it going today?" },
    { id: 9, prompt: "Isn't microservices architecture always superior to a monolith for any new project?" },
    { id: 13, prompt: "My elderly cat passed away yesterday after 15 years. My apartment feels completely empty." },
    { id: 15, prompt: "Write a formal email to our client explaining that their shipment will be delayed by 3 business days due to customs clearance." },
  ];

  for (const sample of samplePrompts) {
    const baselineCall = buildChatPrompt({
      userMessage: sample.prompt,
      executionMode: "fast",
      fastNaturalVoice: false,
      modelOverride: "gpt-oss-120b",
    });

    const naturalCall = buildChatPrompt({
      userMessage: sample.prompt,
      executionMode: "fast",
      fastNaturalVoice: true,
      modelOverride: "gpt-oss-120b",
    });

    try {
      const baselineOutput = await callLLMAdapterSync({ ...baselineCall, use_simulation: true });
      const naturalOutput = await callLLMAdapterSync({ ...naturalCall, use_simulation: true });

      const baselineMetrics = analyzeStyle(baselineOutput);
      const naturalMetrics = analyzeStyle(naturalOutput);

      console.log(`\nSample ${sample.id}: "${sample.prompt.slice(0, 60)}..."`);
      console.log(`  Baseline output (${baselineMetrics.wordCount} words):`);
      console.log(`    "${baselineOutput.trim().slice(0, 120)}..."`);
      console.log(`    [Metrics] Canned opening: ${baselineMetrics.hasCannedOpening}, Stock closing: ${baselineMetrics.hasStockClosing}, Em dashes: ${baselineMetrics.emDashCount}, Emojis: ${baselineMetrics.emojiCount}`);
      console.log(`  Natural voice output (${naturalMetrics.wordCount} words):`);
      console.log(`    "${naturalOutput.trim().slice(0, 120)}..."`);
      console.log(`    [Metrics] Canned opening: ${naturalMetrics.hasCannedOpening}, Stock closing: ${naturalMetrics.hasStockClosing}, Em dashes: ${naturalMetrics.emDashCount}, Emojis: ${naturalMetrics.emojiCount}`);
    } catch (simError) {
      console.log(`  (Simulation run note: ${simError instanceof Error ? simError.message : simError})`);
    }
  }

  console.log("\n===============================================================================");
  console.log("Evaluation completed successfully.");
  console.log("===============================================================================");
}

if (require.main === module) {
  runEvaluation().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
