import { randomUUID } from "crypto";
import {
  callLLMAdapterDetailed,
  strictParseJsonObject,
} from "../ai/PromptBuilders";
import { isChartRequest } from "../tools/chartGeneration/chartDetector";
import { detectCodeQuery, isBufferedReasoningQuery, isMathQuery, selectModelForPrompt } from "./modelRouter";
import { classifyQueryType } from "./queryClassifier";

export interface ClarificationOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ClarificationPayload {
  readonly id: string;
  readonly original_message: string;
  readonly question: string;
  readonly options: readonly ClarificationOption[];
  readonly allow_custom_answer: true;
  readonly custom_answer_prompt: string;
  readonly turn: number;
  readonly max_turns: number;
  readonly model_used?: string;
}

export interface ClarificationResponsePayload {
  readonly clarification_id?: string;
  readonly original_message?: string;
  readonly answers?: readonly string[];
  readonly source?: "option" | "custom";
  readonly selected_option_id?: string;
}

interface ClarificationDecision {
  readonly needsClarification: boolean;
  readonly question?: string;
  readonly options?: readonly ClarificationOption[];
  readonly customAnswerPrompt?: string;
  readonly reason?: string;
}

export interface ClarificationContext {
  readonly userMessage: string;
  readonly userId?: string;
  readonly isGuest?: boolean;
  readonly hasFile?: boolean;
  readonly hasImage?: boolean;
  readonly fileNames?: readonly string[];
  readonly fileContent?: string;
  readonly webSearch?: boolean;
  readonly maxTurns?: number;
  readonly currentTurn?: number;
  readonly forceModelOverride?: string;
}

export interface ResolvedClarificationInput {
  readonly effectiveMessage: string;
  readonly originalMessage: string;
  readonly answers: readonly string[];
  readonly turn: number;
}

const MAX_OPTIONS = 4;
export const DEFAULT_MAX_CLARIFICATION_TURNS = 2;
const CUSTOM_ANSWER_PROMPT = "Or enter a custom answer in the message bar.";

const DIRECT_ANSWER_PATTERNS: readonly RegExp[] = [
  /\bstep\s*by\s*step\b/i,
  /\bexam\s+(?:ready|style)\b/i,
  /\bconcise(?:ly)?\b/i,
  /\bin\s+\d+\s+(?:sentences?|points?|bullets?)\b/i,
  /\bexplain\s+(?:why|how|the|this)\b/i,
  /\bsummarize\s+(?:this|the|my)\b/i,
  /\btranslate\s+(?:this|the|to|into)\b/i,
];

const VAGUE_ACTION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:code|make|create|build|design|write|develop)\b/i,
  /\b(?:code|make|create|build|design|write|develop)\s+(?:in|with|using)\s+[A-Za-z0-9+#.\-]+\s*\.?\s*$/i,
  /^\s*(?:analy[sz]e|review|check)\s+(?:this|it|the\s+(?:file|document|image|screenshot))\s*\.?\s*$/i,
  /^\s*(?:help|help\s+me)\s*\.?\s*$/i,
  /^\s*(?:do|fix|solve)\s+(?:this|it)\s*\.?\s*$/i,
];

const CLEAR_WEB_SCOPE_PATTERNS: readonly RegExp[] = [
  /\b(?:worldwide|global|around\s+the\s+world|international)\b/i,
  /\b(?:india|usa|united\s+states|uk|australia|europe|asia)\b/i,
  /\b(?:ipl|bcci|icc|premier\s+league|nba|nfl|stock\s+price|weather\s+in)\b/i,
];

function normalizeAnswer(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function resolveClarificationInput(
  userMessage: string,
  clarification?: ClarificationResponsePayload,
): ResolvedClarificationInput {
  const visibleAnswer = normalizeAnswer(userMessage);
  const originalMessage = normalizeAnswer(clarification?.original_message) || visibleAnswer;
  const priorAnswers = Array.isArray(clarification?.answers)
    ? clarification.answers.map(normalizeAnswer).filter(Boolean)
    : [];
  const answers = clarification ? [...priorAnswers, visibleAnswer].filter(Boolean) : [];
  if (!clarification || answers.length === 0) {
    return {
      effectiveMessage: visibleAnswer,
      originalMessage: visibleAnswer,
      answers: [],
      turn: 0,
    };
  }

  const clarificationLines = answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
  return {
    originalMessage,
    answers,
    turn: answers.length,
    effectiveMessage: [
      originalMessage,
      "",
      "User clarification(s):",
      clarificationLines,
      "",
      "Answer the original request using these clarification(s).",
    ].join("\n"),
  };
}

function option(id: string, label: string, description: string): ClarificationOption {
  return { id, label, description };
}

function makeDecision(
  question: string,
  options: readonly ClarificationOption[],
  reason: string,
): ClarificationDecision {
  return {
    needsClarification: true,
    question,
    options: options.slice(0, MAX_OPTIONS),
    customAnswerPrompt: CUSTOM_ANSWER_PROMPT,
    reason,
  };
}

function hasLikelyPortfolioName(message: string): boolean {
  return /\b(?:for|name(?:d)?|called)\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\b/.test(message)
    || /\bmy\s+name\s+is\s+[A-Za-z]/i.test(message)
    || /\bportfolio\s+(?:for|of)\s+(?:me|myself)\b/i.test(message);
}

function isLatestNewsWithoutScope(message: string): boolean {
  if (!/\b(?:latest|recent|current)\b[\s\S]{0,40}\b(?:news|updates?)\b/i.test(message)) return false;
  if (CLEAR_WEB_SCOPE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return true;
}

function isClearMathRequest(message: string): boolean {
  if (!isMathQuery(message)) return false;
  if (/\b(?:step\s*by\s*step|solve|calculate|compute|evaluate|simplify|prove)\b/i.test(message)) {
    if (/\d|[=+\-*/^]|step\s*by\s*step/i.test(message)) return true;
  }
  return /\bsolve\s+(?:this\s+)?math\s+step\s*by\s*step\b/i.test(message);
}

export function getRuleBasedClarification(args: ClarificationContext): ClarificationDecision | null {
  const message = args.userMessage.trim();
  if (!message) return null;

  const queryClassification = classifyQueryType(message);
  if (queryClassification.category === "image_generation") return null;

  if (isChartRequest(message) && !/\b(?:chart|graph|plot)\b\s*$/i.test(message)) {
    return null;
  }

  if (isClearMathRequest(message)) {
    return null;
  }

  if (detectCodeQuery(message) && /\bportfolio\b/i.test(message) && !hasLikelyPortfolioName(message)) {
    return makeDecision(
      "Whose name should be in the portfolio?",
      [],
      "portfolio_name_missing",
    );
  }

  if (/\bhtml\b/i.test(message) && /\b(?:code|write|create|make|build)\b/i.test(message) && message.split(/\s+/).length <= 6) {
    return makeDecision(
      "Which type of HTML code serves you best?",
      [
        option("hello_world", "Simple Hello World program", "Good for beginner-level understanding."),
        option("portfolio", "Simple portfolio page", "Good when you want a usable starter website."),
      ],
      "short_html_request",
    );
  }

  if (isLatestNewsWithoutScope(message)) {
    const topicMatch = message.match(/\b(?:news|updates?)\s+(?:about|on|for)\s+(.+?)\.?$/i);
    const topic = topicMatch?.[1]?.trim();
    const question = topic && topic.length <= 40
      ? `Which area should I cover for ${topic}?`
      : "Which area should I cover?";
    return makeDecision(
      question,
      [option("around_world", "Around the world", "Covers the biggest global updates.")],
      "latest_news_scope_missing",
    );
  }

  if ((args.hasFile || args.hasImage) && /^\s*(?:analy[sz]e|review|check|explain)\s+(?:this(?:\s+(?:file|document|image|screenshot))?|it|the\s+(?:file|document|image|screenshot))\s*\.?\s*$/i.test(message)) {
    return makeDecision(
      args.hasImage ? "What should I focus on in the image?" : "What should I focus on in the file?",
      [
        option("summary", "Summary", "Best for a quick understanding."),
        option("details", "Detailed analysis", "Best for deeper insight."),
        option("issues", "Problems or key points", "Best for finding what needs attention."),
      ],
      args.hasImage ? "vague_image_analysis" : "vague_file_analysis",
    );
  }

  if (detectCodeQuery(message) && /\b(?:code|build|create|make|write)\b/i.test(message) && message.split(/\s+/).length <= 5) {
    return makeDecision(
      "What kind of code should I create?",
      [
        option("example", "Small example", "Good for learning the basics."),
        option("usable", "Usable mini project", "Good when you want something you can run."),
        option("explain", "Explain the concept first", "Good if you are still learning."),
      ],
      "short_coding_request",
    );
  }

  if (!DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(message)) && VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(message))) {
    return makeDecision(
      "What outcome would help you most?",
      [
        option("concise", "Concise answer", "Best when you want the result quickly."),
        option("detailed", "Detailed explanation", "Best when you want to understand the reasoning."),
      ],
      "vague_action",
    );
  }

  if (/\bmissionar(?:y|ies)\b/i.test(message) && /\bcannibals?\b/i.test(message) && !/\bstep\s*by\s*step\b/i.test(message)) {
    return makeDecision(
      "What approach do you find better?",
      [
        option("detailed", "Detailed", "Good for understanding the puzzle."),
        option("exam_ready", "Concise step by step", "Good for an exam-ready solution."),
      ],
      "missionary_cannibal_approach",
    );
  }

  return null;
}

function shouldAskModel(args: ClarificationContext): boolean {
  const message = args.userMessage.trim();
  if (!message) return false;
  if (args.currentTurn && args.currentTurn >= (args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS)) return false;
  if (classifyQueryType(message).category === "image_generation") return false;
  if (isClearMathRequest(message)) return false;
  if (DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(message)) && message.length <= 220) return false;

  const wordCount = message.split(/\s+/).filter(Boolean).length;
  const vagueShortRequest = wordCount <= 6 && (
    VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(message))
    || isLatestNewsWithoutScope(message)
    || (detectCodeQuery(message) && /\b(?:code|html|css|javascript|typescript|python|app|website|page|component|api|program)\b/i.test(message))
    || (/\b(?:puzzle|riddle|missionar(?:y|ies)|cannibals?)\b/i.test(message) && !/\bstep\s*by\s*step\b/i.test(message))
  );
  if (vagueShortRequest) return true;
  if (args.hasFile || args.hasImage) return VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(message));
  if (args.webSearch && isLatestNewsWithoutScope(message)) return true;
  if (/\b(?:complex|not sure|anything|something|best|better|recommend)\b/i.test(message) && wordCount <= 18) return true;
  if (detectCodeQuery(message) && /\b(?:app|website|page|component|api|program)\b/i.test(message) && wordCount <= 14) return true;
  if (isBufferedReasoningQuery(message) && !/\b(?:step\s*by\s*step|prove|solve|calculate|compute)\b/i.test(message)) return true;
  return false;
}

export function selectClarificationModel(args: ClarificationContext): string {
  if (args.forceModelOverride) return args.forceModelOverride;
  if (args.isGuest) return "gemini-search";
  if (args.webSearch) return "gemini-search";
  if (!detectCodeQuery(args.userMessage) && isBufferedReasoningQuery(args.userMessage)) {
    return "openai-large";
  }
  return selectModelForPrompt(args.userMessage, undefined, {
    hasFile: args.hasFile,
    hasImage: args.hasImage,
    fileNames: args.fileNames ? [...args.fileNames] : undefined,
    fileContent: args.fileContent,
  });
}

function buildIntentClarifyPrompt(args: ClarificationContext): string {
  const hasFiles = args.hasFile ? "yes" : "no";
  const hasImages = args.hasImage ? "yes" : "no";
  const webSearch = args.webSearch ? "yes" : "no";
  const currentTurn = args.currentTurn ?? 0;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  return [
    "TASK: Intent Clarification",
    "ROLE: Decide whether SentIQGPT should ask a follow-up question before answering.",
    "",
    "BALANCED POLICY:",
    "- Ask only when ambiguity would materially change the final answer.",
    "- Do not ask if the user already specified format, scope, target, or approach clearly.",
    "- Do not ask for image generation requests.",
    "- If an exact fact cannot be guessed, ask a direct question with zero options.",
    "- If one useful default exists, one option is allowed.",
    "- Otherwise provide 2 to 4 meaningful options.",
    "- Always allow the user to enter a custom answer in the message bar.",
    `- Current clarification turn: ${currentTurn}. Maximum turns: ${maxTurns}. If current turn is at the max, do not ask.`,
    "",
    "CONTEXT FLAGS:",
    `- file_context: ${hasFiles}`,
    `- image_context: ${hasImages}`,
    `- web_search_request: ${webSearch}`,
    "",
    "GOOD DIRECT ANSWER EXAMPLES:",
    '- "Solve this math step by step." -> no clarification',
    '- "Summarize this PDF." -> no clarification',
    '- "Fix this Python error." -> no clarification',
    "",
    "GOOD CLARIFICATION EXAMPLES:",
    '- "Code in HTML." -> ask which HTML code type; options can include Hello World and Portfolio.',
    '- "Latest news about cricket." -> ask area; one option can be Around the world.',
    '- "Make a portfolio." without a name -> ask whose name; zero options.',
    "",
    "USER MESSAGE:",
    args.userMessage,
    "",
    "RETURN JSON:",
    "{",
    '  "needs_clarification": true|false,',
    '  "question": "short user-facing question or null",',
    '  "options": [{"id":"short_id","label":"short option","description":"simple one-line explanation"}],',
    `  "custom_answer_prompt": "${CUSTOM_ANSWER_PROMPT}",`,
    '  "reason": "brief internal reason"',
    "}",
  ].join("\n");
}

function parseModelDecision(raw: string): ClarificationDecision | null {
  const parsed = strictParseJsonObject(raw);
  const needsClarification = parsed.needs_clarification === true || parsed.needsClarification === true;
  if (!needsClarification) {
    return { needsClarification: false };
  }

  const question = normalizeAnswer(parsed.question);
  if (!question) return null;

  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  const options = rawOptions
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const label = normalizeAnswer(record.label);
      if (!label) return null;
      const id = normalizeAnswer(record.id) || `option_${index + 1}`;
      const description = normalizeAnswer(record.description);
      return {
        id: id.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || `option_${index + 1}`,
        label: label.slice(0, 80),
        ...(description ? { description: description.slice(0, 140) } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_OPTIONS) as ClarificationOption[];

  return {
    needsClarification: true,
    question: question.slice(0, 180),
    options,
    customAnswerPrompt: normalizeAnswer(parsed.custom_answer_prompt) || CUSTOM_ANSWER_PROMPT,
    reason: normalizeAnswer(parsed.reason),
  };
}

export function formatClarificationText(payload: ClarificationPayload): string {
  const lines = [payload.question.trim()];
  if (payload.options.length > 0) {
    lines.push("", "Options:");
    payload.options.forEach((opt, index) => {
      const suffix = opt.description ? ` - ${opt.description}` : "";
      lines.push(`${index + 1}. ${opt.label}${suffix}`);
    });
  }
  lines.push("", payload.custom_answer_prompt);
  return lines.join("\n");
}

function createPayload(
  args: ClarificationContext,
  decision: ClarificationDecision,
  modelUsed?: string,
): ClarificationPayload | null {
  if (!decision.needsClarification || !decision.question) return null;
  const currentTurn = args.currentTurn ?? 0;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  if (currentTurn >= maxTurns) return null;
  return {
    id: randomUUID(),
    original_message: args.userMessage,
    question: decision.question,
    options: decision.options ?? [],
    allow_custom_answer: true,
    custom_answer_prompt: decision.customAnswerPrompt || CUSTOM_ANSWER_PROMPT,
    turn: currentTurn + 1,
    max_turns: maxTurns,
    model_used: modelUsed,
  };
}

export async function maybeCreateClarification(
  args: ClarificationContext,
): Promise<ClarificationPayload | null> {
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  const currentTurn = args.currentTurn ?? 0;
  if (currentTurn >= maxTurns) return null;

  const ruleDecision = getRuleBasedClarification(args);
  if (ruleDecision?.needsClarification) {
    return createPayload(args, ruleDecision, "deterministic");
  }

  if (!shouldAskModel(args)) {
    return null;
  }

  const modelOverride = selectClarificationModel(args);
  try {
    const result = await callLLMAdapterDetailed({
      task: "intent_clarify",
      prompt: buildIntentClarifyPrompt(args),
      model_override: modelOverride,
      user_id: args.userId,
      max_output_tokens: 600,
    });
    const modelDecision = parseModelDecision(result.text);
    if (!modelDecision?.needsClarification) return null;
    return createPayload(args, modelDecision, result.model_used ?? modelOverride);
  } catch (error) {
    console.warn(`[IntentClarifier] model check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
