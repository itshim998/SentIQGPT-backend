const LABEL_ONLY_PATTERNS = [
  /^(?:key insight|solution|final answer|answer|question|let|let:|so|after meeting|ratio)\s*:?\s*$/i,
];

const LEAKY_LINE_PATTERNS = [
  /\b(?:let me|i will|i should|i need to|wait|hold on|reconsider|rethink|verify|double-check|re-read|reread|different approach|try a different approach|get(?:ting)? unwieldy|something'?s off|not right|doesn'?t make sense|contradict|misinterpret|re-reading)\b/i,
  /\b(?:these aren'?t equal|they can'?t|they wouldn't|this suggests|the only way this works)\b/i,
];

const PROMPT_ECHO_PATTERNS = [
  /\bone direct line\b/i,
  /\bwe should output\b/i,
  /\binclude a bullet\b/i,
  /\bbullet for final answer\b/i,
  /\bensure we don'?t include\b/i,
  /\bthat matches the format\b/i,
  /\bthey said\b/i,
  /\bshow a bullet\b/i,
  /\bfinal answer is a bullet\b/i,
  /\bchain-of-th(?:ought)?\b/i,
  /\bformatting rules?\b/i,
  /\bdo not mention headings, bullets, or line counts\b/i,
  /\bnow,?\s+write\s+the\s+output\b/i,
  /\bthen,?\s+(?:the\s+)?list\s+of\s+steps\b/i,
  /\bthe\s+reasoning\s+summary\s+should\b/i,
  /\bshort\s+reasoning\s+summary\b/i,
  /\bwe'?ll\s+put\s+that\s+inside\b/i,
  /\boutput\s+contract\b/i,
  /\bfinal answer\s+on\s+its\s+own\s+line\b/i,
  /\bdo not include\b[^.]*<think>/i,
];

const NARRATIVE_SENTENCE_PATTERNS = [
  /^\s*(?:we need to|we want to|we have to|we must)\b/i,
  /^\s*we have\b/i,
  /^\s*(?:let'?s|let us)\b/i,
  /^\s*we can\b/i,
  /^\s*(?:consider|suppose|assume)\b/i,
  /^\s*(?:actually|now|next|first)\b/i,
  /^\s*(?:from here|from this)\b(?:\s+we can)?/i,
  /^\s*this is a\b/i,
  /^\s*the idea is\b/i,
  /^\s*to solve\b/i,
  /^\s*we (?:rewrite|express|equate|substitute|compare|check)\b/i,
];

const RESTATEMENT_LINE_PATTERNS = [
  /\btypical\s+\w+\s+problem\b/i,
  /\bstart(?:s|ing)?\s+simultaneously\b/i,
  /\bopposite ends?\b/i,
  /\bstanding in a line\b/i,
  /\bplaying a game\b/i,
];

const SCRATCHWORK_NOISE_PATTERNS = [
  /\bmeet simultaneously\b/i,
  /\btime to meet\b/i,
  /\bto meet\b/i,
  /\btime for\b/i,
  /\blet t be\b/i,
  /\bif they meet at the halfway point, the time to reach the meeting point must be the same\b/i,
  /\bD\/2\s*=\s*v[123456789xyztÃ¢â€šÂÃ¢â€šâ€š]t\b/i,
  /D\/\(2t\)/i,
];

const FINAL_ANSWER_PATTERNS = [
  /^(?:final answer|answer)\s*[:\-]/i,
  /^(?:therefore|thus|hence)\b/i,
  /\b(?:faster|slower|times as fast|times faster|ratio)\b/i,
  /\b(?:the answer is|the result is)\b/i,
];

const INSIGHT_PATTERNS = [
  /\b(?:equal|same|both|remaining|half|midpoint|halfway|ratio|compare|distance|time)\b/i,
  /\b(?:key insight|observation|because|since)\b/i,
];

const LEGITIMATE_EXPLANATION_PATTERNS = [
  /^(?:step\s*\d+[:.)-]?|\d+\.)/i,
  /\baugmented matrix\b/i,
  /\brow operations?\b/i,
  /\bback substitution\b/i,
  /\beliminat(?:e|ing)\b/i,
  /\bsubstitut(?:e|ing|ion)\b/i,
  /\brearrang(?:e|ing)\b/i,
  /\bsolve for\b/i,
  /\btherefore\b/i,
  /\bthus\b/i,
  /\bhence\b/i,
];

function hasMathPayload(text: string): boolean {
  return /[=Ã¢â€°Ë†<>]|\\frac|\\sqrt|\\begin\{|\\\(|\\\[|\$\$|\$[^$]+\$|(?:^|\s)(?:x|y|z|t|v_?\d?|D|n|R_?\d+)(?:\s|$)|\d+\s*[+\-*/=]|\b(?:from\s*\(\d+\)|therefore|thus|hence)\b|[Ã¢â€¡â€™Ã¢â€ â€™]/i.test(text);
}

function hasLegitimateExplanation(text: string): boolean {
  return LEGITIMATE_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text));
}

function stripStructuralPrefix(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*Ã¢â‚¬Â¢]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .trim();
}

function normalizeLine(line: string): string {
  return line
    .replace(/^#{1,3}\s*/, "")
    .replace(/^[-*Ã¢â‚¬Â¢]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanNarrativeFromLine(line: string): string {
  const sentences = line
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (sentences.length <= 1) {
    const trimmed = line.trim();
    const normalized = stripStructuralPrefix(trimmed);
    if (
      (NARRATIVE_SENTENCE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
        RESTATEMENT_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) &&
      !hasMathPayload(normalized) &&
      !hasLegitimateExplanation(normalized)
    ) {
      return "";
    }
    return trimmed;
  }

  const kept = sentences.filter((sentence) => {
    const normalized = stripStructuralPrefix(sentence);
    if (NARRATIVE_SENTENCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return hasMathPayload(normalized) || hasLegitimateExplanation(normalized) || /^\s*(?:from\s*\(\d+\)|therefore|thus|hence)\b/i.test(normalized);
    }
    if (hasMathPayload(normalized)) return true;
    if (hasLegitimateExplanation(normalized)) return true;
    if (RESTATEMENT_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
    return true;
  });

  return kept
    .join(" ")
    .trim()
    .replace(/^(?:we have\b[^.]*\.\s*)+/i, "")
    .replace(/^(?:we can\b[^.]*\.\s*)+/i, "")
    .replace(/^(?:let'?s\b[^.]*\.\s*)+/i, "")
    .trim();
}

function isLongNarrativeLine(line: string): boolean {
  return line.length > 120 && !hasMathPayload(line) && RESTATEMENT_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function isWorkedStepLine(line: string): boolean {
  return /^(?:step\s*\d+[:.)-]?|\d+\.)/i.test(line);
}

function isMethodOperationLine(line: string): boolean {
  return /(?:R\d+\s*->|row operations?|augmented matrix|back substitution|eliminat(?:e|ing)|substitut(?:e|ing|ion))/i.test(line);
}

export function hasMathLeakageSignals(text: string): boolean {
  if (!text) return false;
  return LEAKY_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasMathPromptEchoSignals(text: string): boolean {
  if (!text) return false;
  return PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasMathNarrativeSignals(text: string): boolean {
  if (!text) return false;
  return NARRATIVE_SENTENCE_PATTERNS.some((pattern) => pattern.test(text)) || RESTATEMENT_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function shouldRewriteMathResponse(text: string): boolean {
  if (!text) return false;
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  const narrativeLines = lines.filter((line) => hasMathNarrativeSignals(line));
  const longNarrativeLines = lines.filter((line) => isLongNarrativeLine(line));
  const overlyVerbose = text.length > 900 || lines.length > 14;

  return narrativeLines.length > 0 || longNarrativeLines.length > 0 || overlyVerbose;
}

export function shapeMathResponse(text: string): string {
  if (!text) return text;

  let cleaned = text;
  const mathBlocks: string[] = [];
  const dedupeSet = new Set<string>();
  const hadMarkdownStructure = /(^|\n)#{1,3}\s+|(^|\n)[-*Ã¢â‚¬Â¢]\s+/.test(cleaned);
  const hadNumberedSteps = /(^|\n)\s*(?:step\s*\d+[:.)-]?|\d+\.)/i.test(cleaned);
  const hasPromptEcho = hasMathPromptEchoSignals(text);
  const hasLeakage = hasMathLeakageSignals(text);
  const hasNarrative = hasMathNarrativeSignals(text);

  const inlineResetPatterns = [
    /\s+(?=\d+\.\s)/g,
  ];

  const preserveMath = (match: string) => {
    mathBlocks.push(match);
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  };

  cleaned = cleaned.replace(/\$\$[\s\S]+?\$\$/g, preserveMath);
  cleaned = cleaned.replace(/\\+\[[\s\S]+?\\+\]/g, preserveMath);
  cleaned = cleaned.replace(/\\+\(\s*\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}\s*\\+\)/g, preserveMath);
  cleaned = cleaned.replace(/\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}/g, preserveMath);
  cleaned = cleaned.replace(/\\+\([\s\S]+?\\+\)/g, preserveMath);
  cleaned = cleaned.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (match, tex) => {
    if (/^\d/.test(tex.trim())) return match;
    return preserveMath(match);
  });

  inlineResetPatterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "\n");
  });

  const rawLines = cleaned
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const contentLines = rawLines
    .map((line) => cleanNarrativeFromLine(line))
    .filter((line) => line.length > 0)
    .filter((line) => !LEAKY_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !PROMPT_ECHO_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !SCRATCHWORK_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !isLongNarrativeLine(line));

  const normalizedLines = contentLines
    .map((line) => normalizeLine(line))
    .filter((line) => line.length > 0)
    .filter((line) => !LABEL_ONLY_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => {
      const key = line.toLowerCase();
      if (dedupeSet.has(key)) return false;
      dedupeSet.add(key);
      return true;
    });

  const preservedWorkedLines = contentLines.filter((line, index) => {
    const normalized = normalizeLine(line);
    if (!normalized) return false;
    if (LABEL_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
    return normalizedLines.some((candidate) => candidate.toLowerCase() === normalized.toLowerCase()) ||
      isWorkedStepLine(line) ||
      isMethodOperationLine(line) ||
      index === contentLines.length - 1;
  });

  const hasExplicitWorkedStructure =
    preservedWorkedLines.some((line) => isWorkedStepLine(line)) ||
    preservedWorkedLines.some((line) => isMethodOperationLine(line)) ||
    /\b(?:gauss|elimination|matrix|row operation|back substitution|substitution method)\b/i.test(text);
  const hasNamedProcedure =
    /\b(?:gauss|elimination|matrix|row operation|back substitution|substitution method)\b/i.test(text);

  if (normalizedLines.length === 0) {
    cleaned = "";
  } else if ((hasNamedProcedure || (!hasPromptEcho && !hasLeakage)) && hasExplicitWorkedStructure) {
    cleaned = preservedWorkedLines.join("\n").trim();
  } else if (!hasPromptEcho && !hasLeakage && !hasNarrative && !hadNumberedSteps && normalizedLines.length <= 3) {
    cleaned = normalizedLines.join("\n");
  } else if (!hasPromptEcho && !hasLeakage && !hasNarrative && hadMarkdownStructure && normalizedLines.length <= 6) {
    cleaned = contentLines.join("\n").trim();
  } else if (normalizedLines.length === 1) {
    cleaned = normalizedLines[0];
  } else {
    const finalAnswerIndices = normalizedLines
      .map((line, index) => FINAL_ANSWER_PATTERNS.some((pattern) => pattern.test(line)) ? index : -1)
      .filter((index) => index >= 0);
    const finalAnswerIndex = finalAnswerIndices.length > 0
      ? finalAnswerIndices[finalAnswerIndices.length - 1]
      : normalizedLines.length - 1;

    const finalAnswerLines: string[] = [];
    if (finalAnswerIndex > 0) {
      const previousLine = normalizedLines[finalAnswerIndex - 1];
      if (/[=Ã¢â€°Ë†<>]/.test(previousLine) || /\b(?:ratio|therefore|thus|hence)\b/i.test(previousLine)) {
        finalAnswerLines.push(previousLine);
      }
    }
    finalAnswerLines.push(normalizedLines[finalAnswerIndex]);

    const remainingLines = normalizedLines.filter((_, index) => {
      if (index === finalAnswerIndex) return false;
      return !(finalAnswerIndex > 0 && index === finalAnswerIndex - 1 && finalAnswerLines.length > 1);
    });

    const insightIndex = remainingLines.findIndex((line) => {
      if (/[=Ã¢â€°Ë†<>]/.test(line)) return false;
      if (line.length > 110 && !hasMathPayload(line)) return false;
      return INSIGHT_PATTERNS.some((pattern) => pattern.test(line));
    });
    const insightLine = insightIndex >= 0 ? remainingLines[insightIndex] : undefined;
    const solutionLines = remainingLines.filter((_, index) => index !== insightIndex);
    const compactSolutionLines = solutionLines.length > 6
      ? solutionLines.slice(-6)
      : solutionLines;

    const sections: string[] = [];
    if (insightLine) {
      sections.push("### Key Insight", `- ${insightLine}`, "");
    }
    if (compactSolutionLines.length > 0) {
      sections.push("### Solution", ...compactSolutionLines.map((line) => `- ${line}`), "");
    }
    sections.push(
      "### Final Answer",
      finalAnswerLines
        .map((line) => line.replace(/^(?:final answer|answer)\s*[:\-]\s*/i, "").replace(/^(?:this gives me|so|therefore|thus|hence)\s+/i, "").trim())
        .join("\n"),
    );
    cleaned = sections.join("\n").trim();
  }

  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\x00MATH(\d+)\x00/g, (_, idx) => mathBlocks[parseInt(idx, 10)]);

  return cleaned;
}
