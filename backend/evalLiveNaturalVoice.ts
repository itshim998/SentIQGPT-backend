import { spawn } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { buildChatPrompt } from "./ai/PromptBuilders";
import { analyzeStyle, type StyleMetrics } from "./evalNaturalVoiceQuality";

const PROJECT_ROOT = pathResolve(__dirname, "..");

// Gate: Refuse to make live model calls unless explicitly opted in
if (process.env.SENTIQ_NATURAL_VOICE_LIVE_EVAL !== "1") {
  console.error("\n===============================================================================");
  console.error("SENTIQ CHAT — OPTIONAL LIVE NATURAL VOICE EVALUATION");
  console.error("===============================================================================");
  console.error("[REFUSAL: LIVE EVALUATION DISABLED BY DEFAULT]");
  console.error("This command invokes external LLM providers and is strictly opt-in.");
  console.error("To run live model evaluation, explicitly set the environment flag:");
  console.error("  SENTIQ_NATURAL_VOICE_LIVE_EVAL=1");
  console.error("\nExample:");
  console.error("  SENTIQ_NATURAL_VOICE_LIVE_EVAL=1 npm run eval:natural-voice:live");
  console.error("===============================================================================\n");
  process.exit(1);
}

export interface LiveEvalSample {
  category: string;
  prompt: string;
  focus: string;
}

export const LIVE_EVAL_SAMPLES: readonly LiveEvalSample[] = [
  {
    category: "Simple Factual Question",
    prompt: "What is the capital of Australia, and why was it chosen over Sydney or Melbourne?",
    focus: "Direct factual opening without 'Certainly! That's a great question.'",
  },
  {
    category: "Casual Greeting",
    prompt: "Hey, how is it going today?",
    focus: "Relaxed, quietly warm greeting without artificial cheerleading or canned customer-service closing.",
  },
  {
    category: "Constructive Disagreement",
    prompt: "Isn't microservices architecture always superior to a monolith for any new project?",
    focus: "Direct, reasoned trade-offs leading with the point, avoiding fawning praise or excessive formatting.",
  },
  {
    category: "Difficult Personal Topic",
    prompt: "My elderly cat passed away yesterday after 15 years. My apartment feels completely empty.",
    focus: "Authentic, respectful empathy without canned therapeutic formulas, checklists, or unsolicited emojis.",
  },
  {
    category: "Formal Professional Deliverable",
    prompt: "Write a formal email to our client explaining that their shipment will be delayed by 3 business days due to customs clearance.",
    focus: "Strict adherence to formal business correspondence standards; personality must NOT make deliverables casual.",
  },
];

function callLiveModel(promptText: string, modelOverride = "gpt-oss-120b"): Promise<string> {
  return new Promise((resolve, reject) => {
    const bridgePath = pathResolve(__dirname, "evalLiveModelBridge.py");
    const child = spawn("python", [bridgePath], {
      cwd: PROJECT_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SENTIQ_NATURAL_VOICE_LIVE_EVAL: "1" },
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        try {
          const parsed = JSON.parse(stdout) as { text?: string };
          resolve(parsed.text ?? "");
        } catch (err) {
          reject(new Error(`Failed to parse bridge output: ${err} (stdout: ${stdout})`));
        }
      } else {
        reject(new Error(`evalLiveModelBridge.py exited with code ${code}: ${stderr}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.stdin.write(JSON.stringify({ prompt: promptText, model_override: modelOverride }));
    child.stdin.end();
  });
}

function formatMetrics(metrics: StyleMetrics): string {
  const parts: string[] = [
    `Words: ${metrics.wordCount}`,
    `Canned Opening: ${metrics.hasCannedOpening ? `YES ("${metrics.cannedOpeningMatch}")` : "No"}`,
    `Stock Closing: ${metrics.hasStockClosing ? `YES ("${metrics.stockClosingMatch}")` : "No"}`,
    `AI Clichés: ${metrics.hasAiClichés ? `YES ("${metrics.aiClichéMatch}")` : "No"}`,
    `Em dashes: ${metrics.emDashCount}`,
    `Emojis: ${metrics.emojiCount}`,
  ];
  return parts.join(" | ");
}

export async function runLiveEvaluation(): Promise<void> {
  console.log("===============================================================================");
  console.log("SentIQ Chat — Opt-In Live Natural Voice A/B Model Evaluation");
  console.log("===============================================================================");
  console.log("[EVALUATION PROTOCOL]");
  console.log("Comparing live provider responses with and without the Fast Natural Voice profile.");
  console.log("Model: Groq (openai/gpt-oss-120b) under Fast execution mode settings.\n");

  let sampleIndex = 0;
  for (const sample of LIVE_EVAL_SAMPLES) {
    sampleIndex += 1;
    console.log(`\n===============================================================================`);
    console.log(`[Sample ${sampleIndex}/${LIVE_EVAL_SAMPLES.length}] Category: ${sample.category}`);
    console.log(`User Prompt: "${sample.prompt}"`);
    console.log(`Evaluation Focus: ${sample.focus}`);
    console.log(`-------------------------------------------------------------------------------`);

    // 1. Build baseline prompt (Fast mode, natural voice disabled)
    const baselineCall = buildChatPrompt({
      userMessage: sample.prompt,
      executionMode: "fast",
      fastNaturalVoice: false,
      modelOverride: "gpt-oss-120b",
    });

    // 2. Build voice-enabled prompt (Fast mode, natural voice enabled)
    const naturalCall = buildChatPrompt({
      userMessage: sample.prompt,
      executionMode: "fast",
      fastNaturalVoice: true,
      modelOverride: "gpt-oss-120b",
    });

    try {
      console.log("Fetching live completions...");
      const baselineText = await callLiveModel(baselineCall.prompt);
      const naturalText = await callLiveModel(naturalCall.prompt);

      const baselineMetrics = analyzeStyle(baselineText);
      const naturalMetrics = analyzeStyle(naturalText);

      console.log("\n--- [A: Baseline Response (Voice Profile Disabled)] ---");
      console.log(baselineText);
      console.log(`\nMetrics (Baseline): ${formatMetrics(baselineMetrics)}`);

      console.log("\n--- [B: Fast Natural Voice Response (Voice Profile Enabled)] ---");
      console.log(naturalText);
      console.log(`\nMetrics (Natural Voice): ${formatMetrics(naturalMetrics)}`);

      console.log("\n--- [Human-Review Rubric] ---");
      console.log("1. Directness: Did response B answer directly without generic formulaic openings?");
      console.log("2. Tone & Rhythm: Is the sentence rhythm varied and proportionate to question depth?");
      console.log("3. Appropriate Warmth: Is the tone grounded and sensitive without scripted cheer or therapy clichés?");
      console.log("4. Deliverable Fidelity: If a specific format was requested, was it strictly honored?");
    } catch (error) {
      console.error(`Live evaluation failed for sample ${sampleIndex}:`, error instanceof Error ? error.message : error);
    }
  }

  console.log("\n===============================================================================");
  console.log("EVALUATION NOTICE & DISCLAIMER:");
  console.log("- Heuristic metrics (canned openings, stock closings, clichés, dashes, emojis)");
  console.log("  are diagnostic indicators; they do NOT prove human-level writing or undetectability.");
  console.log("- True naturalness requires human review against the rubric above.");
  console.log("- Zero secrets or credentials were logged during this evaluation.");
  console.log("===============================================================================\n");
}

if (require.main === module) {
  runLiveEvaluation().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
