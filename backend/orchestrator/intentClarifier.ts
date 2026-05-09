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
  readonly previous_answers: readonly string[];
  readonly question: string;
  readonly options: readonly ClarificationOption[];
  readonly allow_custom_answer: true;
  readonly custom_answer_prompt: string;
  readonly turn: number;
  readonly max_turns: number;
  readonly source: "model" | "fallback";
  readonly model_used?: string;
}

export interface ClarificationResponsePayload {
  readonly clarification_id?: string;
  readonly original_message?: string;
  readonly question?: string;
  readonly options?: readonly ClarificationOption[];
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
  readonly originalMessage?: string;
  readonly previousAnswers?: readonly string[];
  readonly userId?: string;
  readonly isGuest?: boolean;
  readonly hasFile?: boolean;
  readonly hasImage?: boolean;
  readonly fileNames?: readonly string[];
  readonly fileContent?: string;
  readonly trustedProfileName?: string;
  readonly webSearch?: boolean;
  readonly maxTurns?: number;
  readonly currentTurn?: number;
  readonly forceModelOverride?: string;
  readonly answeredQuestion?: string;
  readonly answeredOptions?: readonly ClarificationOption[];
  readonly selectedOptionId?: string;
}

export interface ResolvedClarificationInput {
  readonly effectiveMessage: string;
  readonly originalMessage: string;
  readonly answers: readonly string[];
  readonly turn: number;
  readonly answeredQuestion?: string;
  readonly answeredOptions: readonly ClarificationOption[];
  readonly selectedOptionId?: string;
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
  /\bfix\s+(?:this|the|my)\b[\s\S]{0,80}\b(?:error|bug|issue|code|python|javascript|typescript|html|css)\b/i,
  /\bdebug\s+(?:this|the|my)\b[\s\S]{0,80}\b(?:error|bug|issue|code|python|javascript|typescript|html|css)\b/i,
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

function comparableText(value: unknown): string {
  return normalizeAnswer(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeAnswerList(values: readonly unknown[], maxCount = DEFAULT_MAX_CLARIFICATION_TURNS): string[] {
  const seen = new Set<string>();
  const answers: string[] = [];
  for (const value of values) {
    const answer = normalizeAnswer(value);
    if (!answer) continue;
    const key = answer.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    answers.push(answer.slice(0, 1000));
    if (answers.length >= maxCount) break;
  }
  return answers;
}

function normalizeClarificationOptions(values: readonly unknown[] | undefined): ClarificationOption[] {
  if (!Array.isArray(values)) return [];
  const seenLabels = new Set<string>();
  const options: ClarificationOption[] = [];
  values.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const label = normalizeAnswer(record.label);
    if (!label) return;
    const labelKey = comparableText(label);
    if (!labelKey || seenLabels.has(labelKey)) return;
    seenLabels.add(labelKey);
    const id = sanitizeOptionId(record.id, label, index);
    const description = normalizeAnswer(record.description);
    options.push({
      id,
      label: label.slice(0, 80),
      ...(description && comparableText(description) !== labelKey ? { description: description.slice(0, 140) } : {}),
    });
  });
  return options.slice(0, MAX_OPTIONS);
}

export function resolveClarificationInput(
  userMessage: string,
  clarification?: ClarificationResponsePayload,
): ResolvedClarificationInput {
  const visibleAnswer = normalizeAnswer(userMessage);
  const originalMessage = normalizeAnswer(clarification?.original_message) || visibleAnswer;
  const answeredQuestion = normalizeAnswer(clarification?.question);
  const answeredOptions = normalizeClarificationOptions(clarification?.options);
  const selectedOptionId = normalizeAnswer(clarification?.selected_option_id);
  const priorAnswers = Array.isArray(clarification?.answers)
    ? normalizeAnswerList(clarification.answers, Math.max(0, DEFAULT_MAX_CLARIFICATION_TURNS - 1))
    : [];
  const answers = clarification
    ? normalizeAnswerList([...priorAnswers, visibleAnswer], DEFAULT_MAX_CLARIFICATION_TURNS)
    : [];
  if (!clarification || answers.length === 0) {
    return {
      effectiveMessage: visibleAnswer,
      originalMessage: visibleAnswer,
      answers: [],
      turn: 0,
      answeredOptions: [],
    };
  }

  const clarificationLines = answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
  const latestClarificationLines = answeredQuestion
    ? [
      "",
      "Latest clarification question:",
      answeredQuestion,
      "Latest clarification answer:",
      visibleAnswer,
      ...(selectedOptionId ? ["Selected option id:", selectedOptionId] : []),
      ...(answeredOptions.length > 0
        ? ["Available options:", answeredOptions.map((opt) => `${opt.id}: ${opt.label}`).join("; ")]
        : []),
    ]
    : [];
  return {
    originalMessage,
    answers,
    turn: answers.length,
    answeredQuestion: answeredQuestion || undefined,
    answeredOptions,
    selectedOptionId: selectedOptionId || undefined,
    effectiveMessage: [
      originalMessage,
      "",
      "User clarification(s):",
      clarificationLines,
      ...latestClarificationLines,
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

function getEvaluationMessage(args: ClarificationContext): string {
  return [
    normalizeAnswer(args.originalMessage) || normalizeAnswer(args.userMessage),
    ...normalizeAnswerList(args.previousAnswers ?? [], DEFAULT_MAX_CLARIFICATION_TURNS),
  ].filter(Boolean).join(" ");
}

function hasLikelyPortfolioName(message: string, trustedProfileName?: string): boolean {
  const hasTrustedProfile = Boolean(normalizeAnswer(trustedProfileName));
  return /\b(?:for|name(?:d)?|called)\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?\b/.test(message)
    || /\bmy\s+name\s+is\s+[A-Za-z]/i.test(message)
    || (hasTrustedProfile && /\bportfolio\s+(?:for|of)\s+(?:me|myself)\b/i.test(message));
}

function looksLikeHumanName(answer: string): boolean {
  const normalized = normalizeAnswer(answer);
  if (!normalized || normalized.length > 80) return false;
  if (!/^[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}$/.test(normalized)) return false;
  if (/\b(?:portfolio|website|page|blog|business|store|e-?commerce|app|tool|script|code|html|css|javascript|typescript|python)\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function hasPreviousPortfolioName(args: ClarificationContext): boolean {
  return normalizeAnswerList(args.previousAnswers ?? [], DEFAULT_MAX_CLARIFICATION_TURNS)
    .some((answer) => looksLikeHumanName(answer));
}

function hasPortfolioIntent(message: string, args: ClarificationContext): boolean {
  if (/\bportfolio\b/i.test(message)) return true;
  return normalizeAnswerList(args.previousAnswers ?? [], DEFAULT_MAX_CLARIFICATION_TURNS)
    .some((answer) => /\bportfolio\b/i.test(answer));
}

function hasWebsiteIntent(message: string): boolean {
  return /\b(?:website|web\s*site|webpage|web\s+page|landing\s+page|html\s+page)\b/i.test(message);
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

function isCodingClarificationRequest(message: string): boolean {
  if (/^\s*(?:code|coding)\s*\.?\s*$/i.test(message)) return true;
  if (detectCodeQuery(message)) return true;
  return /\b(?:code|build|create|make|design|write|develop|debug|fix)\b[\s\S]{0,80}\b(?:html|css|javascript|typescript|python|java|c\+\+|react|api|component|program|app|website|page)\b/i.test(message)
    || /\b(?:html|css|javascript|typescript|python|java|c\+\+|react)\b[\s\S]{0,80}\b(?:code|app|website|page|component|program)\b/i.test(message);
}

export function getRuleBasedClarification(args: ClarificationContext): ClarificationDecision | null {
  const message = getEvaluationMessage(args).trim();
  if (!message) return null;
  const previousAnswers = normalizeAnswerList(args.previousAnswers ?? [], DEFAULT_MAX_CLARIFICATION_TURNS);
  const wordCount = message.split(/\s+/).filter(Boolean).length;

  const queryClassification = classifyQueryType(message);
  if (queryClassification.category === "image_generation") return null;

  if (isChartRequest(message) && !/\b(?:chart|graph|plot)\b\s*$/i.test(message)) {
    return null;
  }

  if (isClearMathRequest(message)) {
    return null;
  }

  if (hasPortfolioIntent(message, args)
    && !hasLikelyPortfolioName(message, args.trustedProfileName)
    && !hasPreviousPortfolioName(args)) {
    return makeDecision(
      "Whose name should be in the portfolio?",
      [],
      "portfolio_name_missing",
    );
  }

  if (/^\s*(?:code|coding)\s*\.?\s*$/i.test(args.userMessage)) {
    return makeDecision(
      "What kind of code do you want to create?",
      [
        option("website_page", "Website or page", "Best for HTML/CSS, landing pages, or portfolio-style work."),
        option("app_tool", "App or tool", "Best for something interactive or useful."),
        option("script_automation", "Script or automation", "Best for a small program that performs a task."),
        option("fix_debug", "Fix or improve code", "Best when you already have code or an error."),
      ],
      "bare_coding_request",
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

  if (hasWebsiteIntent(message)
    && previousAnswers.length === 0
    && /\b(?:make|create|build|design|write|develop|code)\b/i.test(message)
    && wordCount <= 8) {
    return makeDecision(
      "What kind of website would you like to design?",
      [
        option("personal_portfolio", "Personal portfolio", "Showcase work, skills, and contact details."),
        option("business_website", "Business website", "Promote a company, service, or brand."),
        option("blog", "Blog", "Publish articles, updates, or ideas."),
        option("ecommerce_store", "E-commerce store", "Present products and shopping sections."),
      ],
      "website_type_missing",
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

  if (previousAnswers.length === 0
    && !hasPortfolioIntent(message, args)
    && detectCodeQuery(message)
    && /\b(?:code|build|create|make|write)\b/i.test(message)
    && wordCount <= 5) {
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

  const isCodingOrWebsiteFlow = isCodingClarificationRequest(message)
    || hasWebsiteIntent(message)
    || hasPortfolioIntent(message, args)
    || previousAnswers.some((answer) => /\b(?:portfolio|website|page|app|tool|script|automation|debug|fix)\b/i.test(answer));
  if (!isCodingOrWebsiteFlow
    && !DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(message))
    && VAGUE_ACTION_PATTERNS.some((pattern) => pattern.test(message))) {
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

function isGenericOutcomeDecision(decision: ClarificationDecision | null): boolean {
  if (!decision?.needsClarification) return false;
  const question = normalizeAnswer(decision.question).toLowerCase();
  const labels = (decision.options ?? []).map((item) => normalizeAnswer(item.label).toLowerCase()).join(" ");
  return /what outcome would help you most/.test(question)
    || /\bconcise answer\b/.test(labels)
    || /\bdetailed explanation\b/.test(labels);
}

function shouldPreferFallbackDecision(
  args: ClarificationContext,
  fallbackDecision: ClarificationDecision | null,
  modelDecision: ClarificationDecision | null,
): boolean {
  if (!fallbackDecision?.needsClarification) return false;
  if (fallbackDecision.reason === "portfolio_name_missing" && hasPreviousPortfolioName(args)) return false;
  const highConfidenceReasons = new Set([
    "portfolio_name_missing",
    "bare_coding_request",
    "short_html_request",
    "website_type_missing",
  ]);
  if (highConfidenceReasons.has(fallbackDecision.reason || "") && isGenericOutcomeDecision(modelDecision)) {
    return true;
  }
  return fallbackDecision.reason === "portfolio_name_missing" && modelDecision?.options?.length !== 0;
}

function collectOptionKeys(options: readonly ClarificationOption[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const option of options ?? []) {
    const idKey = comparableText(option.id);
    const labelKey = comparableText(option.label);
    if (idKey) keys.add(idKey);
    if (labelKey) keys.add(labelKey);
  }
  return keys;
}

function collectOptionLabelKeys(options: readonly ClarificationOption[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const option of options ?? []) {
    const labelKey = comparableText(option.label);
    if (labelKey) keys.add(labelKey);
  }
  return keys;
}

function countSetOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let overlap = 0;
  for (const key of left) {
    if (right.has(key)) overlap += 1;
  }
  return overlap;
}

function shouldSuppressAnsweredClarificationRepeat(
  args: ClarificationContext,
  decision: ClarificationDecision,
): boolean {
  if (!decision.needsClarification || !decision.question) return false;
  const answers = normalizeAnswerList(args.previousAnswers ?? [], args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS);
  if (answers.length === 0) return false;

  const decisionOptionKeys = collectOptionKeys(decision.options);
  const latestAnswerKey = comparableText(answers[answers.length - 1]);
  if (latestAnswerKey && decisionOptionKeys.has(latestAnswerKey)) {
    return true;
  }

  const selectedOptionKey = comparableText(args.selectedOptionId);
  if (selectedOptionKey && decisionOptionKeys.has(selectedOptionKey)) {
    return true;
  }

  const answeredQuestionKey = comparableText(args.answeredQuestion);
  const decisionQuestionKey = comparableText(decision.question);
  if (answeredQuestionKey && decisionQuestionKey && answeredQuestionKey === decisionQuestionKey) {
    return true;
  }

  const answeredOptionLabels = collectOptionLabelKeys(args.answeredOptions);
  const decisionOptionLabels = collectOptionLabelKeys(decision.options);
  if (answeredOptionLabels.size > 0 && decisionOptionLabels.size > 0) {
    const overlap = countSetOverlap(answeredOptionLabels, decisionOptionLabels);
    const smallerSetSize = Math.min(answeredOptionLabels.size, decisionOptionLabels.size);
    if (overlap >= 2 && overlap >= smallerSetSize) {
      return true;
    }
  }

  return false;
}

function shouldAskModel(args: ClarificationContext): boolean {
  const message = getEvaluationMessage(args).trim();
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
  const message = getEvaluationMessage(args) || args.userMessage;
  if (isCodingClarificationRequest(message)) {
    return "qwen-coder";
  }
  if (!detectCodeQuery(message) && isBufferedReasoningQuery(message)) {
    return "openai-large";
  }
  return selectModelForPrompt(message, undefined, {
    hasFile: args.hasFile,
    hasImage: args.hasImage,
    fileNames: args.fileNames ? [...args.fileNames] : undefined,
    fileContent: args.fileContent,
  });
}

function buildIntentClarifyPrompt(
  args: ClarificationContext,
  fallbackDecision: ClarificationDecision | null,
): string {
  const hasFiles = args.hasFile ? "yes" : "no";
  const hasImages = args.hasImage ? "yes" : "no";
  const webSearch = args.webSearch ? "yes" : "no";
  const currentTurn = args.currentTurn ?? 0;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  const previousAnswers = normalizeAnswerList(args.previousAnswers ?? [], DEFAULT_MAX_CLARIFICATION_TURNS);
  const originalMessage = normalizeAnswer(args.originalMessage) || normalizeAnswer(args.userMessage);
  const answeredQuestion = normalizeAnswer(args.answeredQuestion);
  const answeredOptions = normalizeClarificationOptions(args.answeredOptions);
  const latestAnswer = previousAnswers[previousAnswers.length - 1] || "";
  const selectedOptionId = normalizeAnswer(args.selectedOptionId);
  const triggerHint = fallbackDecision?.needsClarification
    ? [
      `- deterministic_gate: ask`,
      `- reason: ${fallbackDecision.reason || "ambiguous_intent"}`,
      `- suggested_question: ${fallbackDecision.question || ""}`,
      `- suggested_options: ${JSON.stringify(fallbackDecision.options ?? [])}`,
    ].join("\n")
    : "- deterministic_gate: uncertain; decide from the policy.";
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
    "- If a deterministic gate says ask, write a better user-facing version of that clarification.",
    "- Return zero options only when SentIQGPT cannot safely guess the answer, such as a missing name.",
    "- Never ask generic answer-style questions such as concise vs detailed unless the user's request is specifically about response style.",
    "- For coding, website, and portfolio flows, ask about the project/task details instead of answer length or explanation depth.",
    "- If the user selected a portfolio and the name is missing, ask only whose name should be in the portfolio with zero options.",
    "- If the user already answered a clarification, do not ask the same question again or reuse the same option set.",
    "- Ask a second clarification only when a different required detail is still missing.",
    `- Current clarification turn: ${currentTurn}. Maximum turns: ${maxTurns}. If current turn is at the max, do not ask.`,
    "",
    "CONTEXT FLAGS:",
    `- file_context: ${hasFiles}`,
    `- image_context: ${hasImages}`,
    `- web_search_request: ${webSearch}`,
    "",
    "DETERMINISTIC TRIGGER HINT:",
    triggerHint,
    "",
    "GOOD DIRECT ANSWER EXAMPLES:",
    '- "Solve this math step by step." -> no clarification',
    '- "Summarize this PDF." -> no clarification',
    '- "Fix this Python error." -> no clarification',
    "",
    "GOOD CLARIFICATION EXAMPLES:",
    '- "Code." -> ask what kind of code/project; options should be coding-specific.',
    '- "Code in HTML." -> ask which HTML code type; options can include Hello World and Portfolio.',
    '- Original "design a website", previous answer "Personal Portfolio" -> ask whose name should be in the portfolio; zero options.',
    '- "Latest news about cricket." -> ask area; one option can be Around the world.',
    '- "Make a portfolio." without a name -> ask whose name; zero options.',
    "",
    "ORIGINAL USER MESSAGE:",
    originalMessage,
    "",
    "PREVIOUS CLARIFICATION ANSWERS:",
    previousAnswers.length ? JSON.stringify(previousAnswers) : "[]",
    "",
    "ANSWERED CLARIFICATION:",
    answeredQuestion
      ? [
        `question: ${answeredQuestion}`,
        `latest_answer: ${latestAnswer}`,
        selectedOptionId ? `selected_option_id: ${selectedOptionId}` : "",
        answeredOptions.length ? `options: ${JSON.stringify(answeredOptions)}` : "",
      ].filter(Boolean).join("\n")
      : "none",
    "",
    "EVALUATION MESSAGE:",
    getEvaluationMessage(args) || args.userMessage,
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
  if (!isUsefulQuestion(question)) return null;

  const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
  const seenLabels = new Set<string>();
  const seenIds = new Set<string>();
  const options = rawOptions
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const label = normalizeAnswer(record.label);
      if (!label) return null;
      const labelKey = label.toLowerCase();
      if (seenLabels.has(labelKey)) return null;
      seenLabels.add(labelKey);
      const id = sanitizeOptionId(record.id, label, index);
      if (seenIds.has(id)) return null;
      seenIds.add(id);
      const description = normalizeAnswer(record.description);
      return {
        id,
        label: label.slice(0, 80),
        ...(description && description.toLowerCase() !== labelKey ? { description: description.slice(0, 140) } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, MAX_OPTIONS) as ClarificationOption[];

  return {
    needsClarification: true,
    question: question.slice(0, 180),
    options,
    customAnswerPrompt: CUSTOM_ANSWER_PROMPT,
    reason: normalizeAnswer(parsed.reason),
  };
}

function isUsefulQuestion(question: string): boolean {
  if (question.length < 8 || question.length > 180) return false;
  if (/^(?:question|clarification|options?|yes|no|ok)[?.!]?$/i.test(question)) return false;
  if (/[{}[\]]/.test(question)) return false;
  return true;
}

function sanitizeOptionId(rawId: unknown, label: string, index: number): string {
  const source = normalizeAnswer(rawId) || label || `option_${index + 1}`;
  const sanitized = source
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!sanitized || !/^[a-z][a-z0-9_]*$/.test(sanitized)) {
    return `option_${index + 1}`;
  }
  return sanitized;
}

export function formatClarificationText(payload: ClarificationPayload): string {
  const lines = [payload.question.trim()];
  if (payload.options.length > 0) {
    lines.push("", "Options:");
    payload.options.forEach((opt, index) => {
      const suffix = opt.description ? ` - ${opt.description}` : "";
      lines.push(`${index + 1}. ${opt.label}${suffix}`);
    });
    lines.push("", payload.custom_answer_prompt);
  }
  return lines.join("\n");
}

function createPayload(
  args: ClarificationContext,
  decision: ClarificationDecision,
  modelUsed?: string,
  source: "model" | "fallback" = "model",
): ClarificationPayload | null {
  if (!decision.needsClarification || !decision.question) return null;
  if (decision.reason === "portfolio_name_missing" && hasPreviousPortfolioName(args)) return null;
  if (shouldSuppressAnsweredClarificationRepeat(args, decision)) return null;
  const currentTurn = args.currentTurn ?? 0;
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  if (currentTurn >= maxTurns) return null;
  const previousAnswers = normalizeAnswerList(args.previousAnswers ?? [], maxTurns);
  return {
    id: randomUUID(),
    original_message: normalizeAnswer(args.originalMessage) || normalizeAnswer(args.userMessage),
    previous_answers: previousAnswers,
    question: decision.question,
    options: decision.options ?? [],
    allow_custom_answer: true,
    custom_answer_prompt: CUSTOM_ANSWER_PROMPT,
    turn: currentTurn + 1,
    max_turns: maxTurns,
    source,
    model_used: modelUsed,
  };
}

export async function maybeCreateClarification(
  args: ClarificationContext,
): Promise<ClarificationPayload | null> {
  const maxTurns = args.maxTurns ?? DEFAULT_MAX_CLARIFICATION_TURNS;
  const currentTurn = args.currentTurn ?? 0;
  if (currentTurn >= maxTurns) return null;

  const fallbackDecision = getRuleBasedClarification(args);
  const shouldAsk = fallbackDecision?.needsClarification || shouldAskModel(args);
  if (!shouldAsk) {
    return null;
  }

  const modelOverride = selectClarificationModel(args);
  try {
    const result = await callLLMAdapterDetailed({
      task: "intent_clarify",
      prompt: buildIntentClarifyPrompt(args, fallbackDecision),
      model_override: modelOverride,
      user_id: args.userId,
      max_output_tokens: 600,
    });
    const modelDecision = parseModelDecision(result.text);
    if (modelDecision?.needsClarification) {
      if (shouldPreferFallbackDecision(args, fallbackDecision, modelDecision)) {
        return createPayload(args, fallbackDecision as ClarificationDecision, result.model_used ?? modelOverride, "fallback");
      }
      return createPayload(args, modelDecision, result.model_used ?? modelOverride, "model");
    }
    if (fallbackDecision?.needsClarification) {
      return createPayload(args, fallbackDecision, result.model_used ?? modelOverride, "fallback");
    }
    return null;
  } catch (error) {
    console.warn(`[IntentClarifier] model check failed: ${error instanceof Error ? error.message : String(error)}`);
    return fallbackDecision?.needsClarification
      ? createPayload(args, fallbackDecision, modelOverride, "fallback")
      : null;
  }
}
