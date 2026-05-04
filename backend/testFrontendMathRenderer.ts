import { readFileSync } from "fs";
import { join } from "path";

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`FAIL | ${label}`);
    process.exit(1);
  }
  console.log(`PASS | ${label}`);
}

const frontendHtml = readFileSync(join(process.cwd(), "frontend", "index.html"), "utf8");
const stashTokenMatch = frontendHtml.match(/return '([^']*SENTIQ[^']*)' \+ \(mathBlocks\.length - 1\) \+ '([^']*)'/);
const tokenPrefix = stashTokenMatch?.[1] ?? "";
const tokenSuffix = stashTokenMatch?.[2] ?? "";
const tokenEnvelope = `${tokenPrefix}0${tokenSuffix}`;

assert(/marked@15\.0\.7/.test(frontendHtml), "frontend uses the expected marked CDN version");
assert(/katex@0\.16\.11/.test(frontendHtml), "frontend uses the expected KaTeX CDN version");
assert(Boolean(stashTokenMatch), "frontend renderer defines a math placeholder token");
assert(/^[A-Za-z0-9]+$/.test(tokenEnvelope), "math placeholder token is markdown-inert alphanumeric text");
assert(!/_|@/.test(tokenEnvelope), "math placeholder token has no markdown emphasis or punctuation delimiters");
assert(/SENTIQMATHBLOCKTOKEN/.test(frontendHtml), "renderer restores the new alphanumeric math token");
assert(/@@SENTIQ_MATH_/.test(frontendHtml), "renderer keeps compatibility for the prior token shape");
assert(frontendHtml.includes("@@\\s*SENTIQ") && frontendHtml.includes("ATH(?:\\s|<[^>]+>|[A-Za-z0-9])*?@@"), "renderer cleans up already-corrupted visible sentinel variants");
assert(/\\\+left/.test(frontendHtml) && /\\\+right/.test(frontendHtml), "renderer explicitly protects raw left/right LaTeX spans");
assert(
  frontendHtml.indexOf("protectExplicitMath(segment.value)") >= 0 &&
    frontendHtml.indexOf("protectExplicitMath(segment.value)") < frontendHtml.indexOf("marked.parse(text)"),
  "explicit math is protected before markdown parsing",
);
assert(
  frontendHtml.includes("enhancePlainMath(protectExplicitMath(segment.value))"),
  "plain math enhancement runs only after explicit math protection",
);

const sampleTokenized = `Interval SENTIQMATHBLOCKTOKEN2END and legacy @@SENTIQ_MATH_3@@`;
assert(!/\bMATH\d+\b/.test(sampleTokenized), "new token shape cannot degrade to bare MATH placeholders");

console.log("\nFrontend math renderer guard validation passed.");
