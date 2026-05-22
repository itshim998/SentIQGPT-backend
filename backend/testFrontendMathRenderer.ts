import { createRequire } from "module";
import { createContext, runInContext } from "vm";
import { readFrontendSources } from "./frontendSource";

type RendererUtils = {
  renderRichText: (text: string, options?: Record<string, unknown>, deps?: Record<string, unknown>) => string;
  segmentText: (text: string) => Array<{ type: string; value: string; display?: boolean }>;
};

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

const requireFromTest = createRequire(__filename);
const markedModule = requireFromTest("marked");
const katex = requireFromTest("katex");
const marked = markedModule.marked || markedModule;
const frontend = readFrontendSources();
const frontendSource = frontend.combined;
const rendererSource = frontend.scripts["scripts/rendering/rich-text-renderer.js"] || "";
const mainSource = frontend.scripts["scripts/main.js"] || "";
assert(Boolean(rendererSource), "frontend exposes modular renderer source");

const rendererSandbox = {
  module: { exports: {} as Partial<RendererUtils> },
  exports: {},
  window: {} as { SentIQRenderer?: Partial<RendererUtils> },
  globalThis: {},
  console: { warn: () => undefined },
};
createContext(rendererSandbox);
runInContext(rendererSource, rendererSandbox);
const renderer = (
  rendererSandbox.module.exports.renderRichText
    ? rendererSandbox.module.exports
    : rendererSandbox.window.SentIQRenderer
) as RendererUtils;

function renderMath(text: string): string {
  return renderer.renderRichText(text, { mode: "math" }, { marked, katex });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert(start >= 0, `frontend source defines ${name}`);
  const openBrace = source.indexOf("{", start);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert(false, `frontend source has a complete ${name} body`);
  return "";
}

function assertCleanMathHtml(html: string, label: string): void {
  assert(!/\b(?:SENTIQ|MATH\d+)\b|@@/.test(stripHtml(html)), `${label} has no visible math sentinels`);
}

assert(/marked@15\.0\.7/.test(frontend.indexHtml), "frontend uses the expected marked CDN version");
assert(/katex@0\.16\.11/.test(frontend.indexHtml), "frontend uses the expected KaTeX CDN version");
assert(!/<script\s+src=["']scripts\/renderer-utils\.js/i.test(frontendSource), "frontend no longer depends on external renderer-utils.js");
const rendererImportIndex = mainSource.indexOf("./rendering/rich-text-renderer.js");
const chatControllerImportIndex = mainSource.indexOf("./features/chat-controller.js");
assert(rendererImportIndex >= 0, "main module imports SentIQRenderer");
assert(chatControllerImportIndex > rendererImportIndex, "renderer module loads before the chat controller");
assert(typeof renderer.renderRichText === "function", "renderer utility exports renderRichText");
assert(typeof renderer.segmentText === "function", "renderer utility exports segmentText");
assert(!/mathBlocks|restoreMath|protectExplicitMath/.test(rendererSource), "renderer no longer stashes math placeholders through Markdown");

const fractionHtml = renderMath(String.raw`\[\frac{a+b}{c}\]`);
assert(/math-display-shell/.test(fractionHtml), "display fraction renders inside a math shell");
assert(/katex/.test(fractionHtml), "display fraction renders with KaTeX");
assertCleanMathHtml(fractionHtml, "display fraction");

const intervalHtml = renderMath(String.raw`The interval is \(\left[2,3\right]\).`);
assert(/The interval is/.test(stripHtml(intervalHtml)), "inline interval keeps surrounding prose");
assert(/katex/.test(intervalHtml), "inline interval renders with KaTeX");
assertCleanMathHtml(intervalHtml, "inline interval");

const markdownProseHtml = renderMath("there is a root between **2 and 3**.");
assert(/<strong>2 and 3<\/strong>/.test(markdownProseHtml), "Markdown emphasis in prose remains Markdown");
assert(!/math-display-shell|katex/.test(markdownProseHtml), "Markdown prose is not promoted to math");

const rawEquationHtml = renderMath("x = 4 and y = 7");
assert(/x = 4 and y = 7/.test(stripHtml(rawEquationHtml)), "raw undelimited equation text remains readable text");
assert(!/math-display-shell|katex/.test(rawEquationHtml), "raw undelimited equations are not auto-rendered as math");

const dollarMathHtml = renderMath("$x + 1$ stays literal unless the model uses renderer-safe delimiters.");
assert(/x \+ 1/.test(stripHtml(dollarMathHtml)), "single-dollar math remains readable text");
assert(/katex/.test(dollarMathHtml), "single-dollar math keeps the current KaTeX renderer behavior");

const falsePositionHtml = renderMath(String.raw`
Using the False Position formula:

\[
x = \frac{a f(b) - b f(a)}{f(b)-f(a)}
\]

\[
x = \frac{2(6)-3(-9)}{6-(-9)} = 2.600
\]

Now check \(f(2.6)\) and keep the interval \(\left[2.6,3\right]\).
`);
assert(/math-display-shell/.test(falsePositionHtml), "false-position display formulas render as display math");
assert(/\.math-display-shell[\s\S]*overflow-x:\s*auto/.test(frontendSource), "display math shell remains horizontally scrollable by CSS");
assert(/\.math-display-shell[\s\S]*overflow-y:\s*visible/.test(frontendSource), "display math shell does not vertically clip fractions");
assert(/Now check/.test(stripHtml(falsePositionHtml)), "false-position prose remains readable");
assertCleanMathHtml(falsePositionHtml, "false-position formulas");

const leakedHtml = renderMath("SENTIQMATHBLOCKTOKEN2END @@SENTIQ_MATH_3@@ MATH4 readable text");
assert(!/SENTIQ|MATH4|@@/.test(stripHtml(leakedHtml)), "legacy leaked sentinel artifacts are stripped");
assert(/readable text/.test(stripHtml(leakedHtml)), "sentinel cleanup preserves recoverable prose");

const fallbackFunction = extractFunction(frontendSource, "renderMarkdownOnlyFallback");
const fallbackSandbox = {
  window: { marked },
  MAX_RENDER_CHARS: 100000,
  console: { warn: () => undefined },
  debugWarn: () => undefined,
  escapeHtml: (value: unknown) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;"),
  sanitizeRenderedHtml: (html: string) => html,
  fallbackResult: "",
};
createContext(fallbackSandbox);
runInContext(
  `${fallbackFunction}; fallbackResult = renderMarkdownOnlyFallback("**bold** text SENTIQMATHBLOCKTOKEN2END");`,
  fallbackSandbox,
);
assert(/<strong>bold<\/strong>/.test(fallbackSandbox.fallbackResult), "Markdown fallback renders bold text");
assert(!/SENTIQ|MATH\d+|@@/.test(stripHtml(fallbackSandbox.fallbackResult)), "Markdown fallback strips leaked sentinels");

const payloadFunctionSource = [
  "splitThinkBlocks",
  "splitFinalAnswerSection",
  "looksLikeReasoningOnly",
  "extractStructuredAnswerText",
  "beautifyAnswerText",
  "normalizeAssistantPayload",
].map((name) => extractFunction(frontendSource, name)).join("\n");
const payloadSandbox = {
  mathPayload: null as null | { answer: string; thinking: string },
  legacyPayload: null as null | { answer: string; thinking: string },
};
createContext(payloadSandbox);
const mathWithFinalSection = [
  "## Solution",
  "",
  "First integrate term by term.",
  "",
  "## Final Answer",
  "",
  "\\[\\boxed{x^3 + C}\\]",
].join("\n");
const legacyThinkPayload = [
  "<think>",
  "Try a few graph-search strategies.",
  "</think>",
  "Final Answer:",
  "Use BFS for the shortest path.",
].join("\n");
runInContext(
  `${payloadFunctionSource}
mathPayload = normalizeAssistantPayload(${JSON.stringify(mathWithFinalSection)}, "");
legacyPayload = normalizeAssistantPayload(${JSON.stringify(legacyThinkPayload)}, "");`,
  payloadSandbox,
);
assert(payloadSandbox.mathPayload?.answer.includes("## Solution") ?? false, "math final render preserves solution section before Final Answer");
assert(payloadSandbox.mathPayload?.answer.includes("## Final Answer") ?? false, "math final render preserves Final Answer heading");
assert(payloadSandbox.mathPayload?.answer.includes("\\boxed{x^3 + C}") ?? false, "math final render preserves boxed final answer");
assert(payloadSandbox.legacyPayload?.answer === "Use BFS for the shortest path.", "legacy think payload still extracts final answer");
assert(payloadSandbox.legacyPayload?.thinking.includes("graph-search") ?? false, "legacy think payload still captures thinking");

const mathStreamModeIndex = frontendSource.indexOf('streamBubble.setRenderMode("math")');
const progressiveRenderIndex = frontendSource.indexOf("renderRichText(safeText, { mode: getRenderMode() })");
assert(mathStreamModeIndex >= 0, "math streaming switches the active bubble into math render mode");
assert(progressiveRenderIndex >= 0, "streaming renderer uses render-mode aware progressive rich rendering");

console.log("\nFrontend math renderer regression validation passed.");
