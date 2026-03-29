const LABEL_ONLY_PATTERNS = [
  /^(?:key insight|solution|final answer|answer|question|let|let:|so|after meeting|ratio)\s*:?\s*$/i,
];

const LEAKY_LINE_PATTERNS = [
  /\b(?:let me|i will|i should|i need to|wait|hold on|reconsider|rethink|verify|double-check|re-read|reread|different approach|try a different approach|get(?:ting)? unwieldy|something'?s off|not right|doesn'?t make sense|contradict|misinterpret|re-reading)\b/i,
  /\b(?:these aren'?t equal|they can'?t|they wouldn't|this suggests|the only way this works)\b/i,
];

const SCRATCHWORK_NOISE_PATTERNS = [
  /\bmeet simultaneously\b/i,
  /\btime to meet\b/i,
  /\bto meet\b/i,
  /\btime for\b/i,
  /\blet t be\b/i,
  /\bif they meet at the halfway point, the time to reach the meeting point must be the same\b/i,
  /\bD\/2\s*=\s*v[₁1₂2]t\b/i,
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

export function hasMathLeakageSignals(text: string): boolean {
  if (!text) return false;
  return LEAKY_LINE_PATTERNS.some((pattern) => pattern.test(text));
}

export function shapeMathResponse(text: string): string {
  if (!text) return text;

  let cleaned = text;
  const mathBlocks: string[] = [];
  const dedupeSet = new Set<string>();

  const inlineResetPatterns = [
    /\s+(?=\d+\.\s)/g,
  ];

  const preserveMath = (match: string) => {
    mathBlocks.push(match);
    return `\x00MATH${mathBlocks.length - 1}\x00`;
  };

  // Preserve LaTeX blocks so cleanup/numbering does not break matrices or equations.
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

  const normalizedLines = rawLines
    .map((line) => line.replace(/^\d+\.\s*/, "").replace(/^[-*•]\s*/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !LABEL_ONLY_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !LEAKY_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => !SCRATCHWORK_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .filter((line) => {
      const key = line.toLowerCase();
      if (dedupeSet.has(key)) return false;
      dedupeSet.add(key);
      return true;
    });

  if (normalizedLines.length === 0) {
    cleaned = "";
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
      if (
        /[=≈<>]/.test(previousLine) ||
        /\b(?:ratio|therefore|thus|hence)\b/i.test(previousLine)
      ) {
        finalAnswerLines.push(previousLine);
      }
    }
    finalAnswerLines.push(normalizedLines[finalAnswerIndex]);

    const remainingLines = normalizedLines.filter((_, index) => {
      if (index === finalAnswerIndex) return false;
      return !(finalAnswerIndex > 0 && index === finalAnswerIndex - 1 && finalAnswerLines.length > 1);
    });

    const insightIndex = remainingLines.findIndex((line) => {
      if (/[=≈<>]/.test(line)) return false;
      return INSIGHT_PATTERNS.some((pattern) => pattern.test(line));
    });
    const insightLine = insightIndex >= 0 ? remainingLines[insightIndex] : undefined;
    const solutionLines = remainingLines.filter((_, index) => index !== insightIndex);
    const compactSolutionLines = solutionLines.length > 5
      ? solutionLines.slice(-5)
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
