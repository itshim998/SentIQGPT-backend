import { createRequire } from "module";
import { readFileSync } from "fs";
import { join } from "path";

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
const renderer = requireFromTest(join(process.cwd(), "frontend", "scripts", "renderer-utils.js")) as RendererUtils;
const frontendHtml = readFileSync(join(process.cwd(), "frontend", "index.html"), "utf8");
const rendererSource = readFileSync(join(process.cwd(), "frontend", "scripts", "renderer-utils.js"), "utf8");

function renderMath(text: string): string {
  return renderer.renderRichText(text, { mode: "math" }, { marked, katex });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function assertCleanMathHtml(html: string, label: string): void {
  assert(!/\b(?:SENTIQ|MATH\d+)\b|@@/.test(stripHtml(html)), `${label} has no visible math sentinels`);
}

assert(/marked@15\.0\.7/.test(frontendHtml), "frontend uses the expected marked CDN version");
assert(/katex@0\.16\.11/.test(frontendHtml), "frontend uses the expected KaTeX CDN version");
assert(/renderer-utils\.js\?v=math-render-v4/.test(frontendHtml), "frontend renderer script is cache-busted");
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
assert(/\.math-display-shell[\s\S]*overflow-x:\s*auto/.test(frontendHtml), "display math shell remains horizontally scrollable by CSS");
assert(/Now check/.test(stripHtml(falsePositionHtml)), "false-position prose remains readable");
assertCleanMathHtml(falsePositionHtml, "false-position formulas");

const leakedHtml = renderMath("SENTIQMATHBLOCKTOKEN2END @@SENTIQ_MATH_3@@ MATH4 readable text");
assert(!/SENTIQ|MATH4|@@/.test(stripHtml(leakedHtml)), "legacy leaked sentinel artifacts are stripped");
assert(/readable text/.test(stripHtml(leakedHtml)), "sentinel cleanup preserves recoverable prose");

const streamingBranchIndex = frontendHtml.indexOf('if (renderMode === "math")');
const chunkRenderIndex = frontendHtml.indexOf("renderRichText(chunk");
assert(streamingBranchIndex >= 0, "math streaming has a plain-preview branch");
assert(chunkRenderIndex >= 0, "non-math streaming still uses chunk rendering");
assert(streamingBranchIndex < chunkRenderIndex, "math streaming bypasses rich chunk rendering before chunk renderer");

console.log("\nFrontend math renderer regression validation passed.");
