type ParsedMatrixRow = {
  left: string[];
  right: string[];
};

const WORD_MATH_TERMS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "log",
  "ln",
  "sqrt",
  "frac",
  "det",
  "lim",
  "sum",
  "prod",
  "max",
  "min",
]);

function toDisplayMath(tex: string): string {
  return `\\[\n${tex.trim()}\n\\]`;
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

function countProseWords(value: string): number {
  const withoutLatex = String(value || "").replace(/\\[A-Za-z]+/g, " ");
  const words = withoutLatex.match(/\b[A-Za-z]{3,}\b/g) || [];
  return words.filter((word) => !WORD_MATH_TERMS.has(word.toLowerCase())).length;
}

function normalizeMathToken(token: string): string {
  let normalized = token.trim();
  if (!normalized) return normalized;

  normalized = normalized.replace(/^sqrt\((.+)\)$/i, "\\sqrt{$1}");
  normalized = normalized.replace(/^\(([-+]?[A-Za-z0-9]+)\s*\/\s*([-+]?[A-Za-z0-9]+)\)$/g, "\\frac{$1}{$2}");
  normalized = normalized.replace(/^\bR(\d+)\b$/g, "R_{$1}");
  normalized = normalized.replace(/^\bv(\d+)\b$/g, "v_{$1}");
  normalized = normalized.replace(/^\b([A-Za-z])_(\d+)\b$/g, "$1_{$2}");
  normalized = normalized.replace(/^\b([A-Za-z])(\d+)\b$/g, "$1_{$2}");

  return normalized;
}

function normalizeMathExpression(expression: string): string {
  let normalized = String(expression || "").trim();
  if (!normalized) return normalized;

  normalized = normalized.replace(/\\\\(?=(?:begin|end|[A-Za-z()[\]]))/g, "\\");
  normalized = normalized.replace(/\s+\\\\\s+/g, " \\\\ ");
  normalized = normalized.replace(/<->/g, "\\leftrightarrow ");
  normalized = normalized.replace(/=>/g, "\\Rightarrow ");
  normalized = normalized.replace(/->/g, "\\to ");
  normalized = normalized.replace(/<-/g, "\\leftarrow ");
  normalized = normalized.replace(/>=/g, "\\ge ");
  normalized = normalized.replace(/<=/g, "\\le ");
  normalized = normalized.replace(/!=/g, "\\ne ");
  normalized = normalized.replace(/\b(?:gives|give|becomes|yields?)\b/gi, "\\Rightarrow ");
  normalized = normalized.replace(/\bR(\d+)\b/g, "R_{$1}");
  normalized = normalized.replace(/(\d)R(\d+)/g, "$1R_{$2}");
  normalized = normalized.replace(/\bv(\d+)\b/g, "v_{$1}");
  normalized = normalized.replace(/\b([A-Za-z])_(\d+)\b/g, "$1_{$2}");
  normalized = normalized.replace(/\bsqrt\(([^()]+)\)/g, "\\sqrt{$1}");
  normalized = normalized.replace(/(?<![A-Za-z\\])([A-Za-z0-9]+)\s*\/\s*([A-Za-z0-9]+)(?![A-Za-z])/g, "\\frac{$1}{$2}");
  normalized = normalized.replace(/\s{2,}/g, " ").trim();

  return normalized;
}

function protectExplicitMathText(text: string, blocks: string[]): string {
  const stash = (value: string) => {
    blocks.push(value);
    return `\x00EXPLICITMATH${blocks.length - 1}\x00`;
  };

  return String(text || "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (match) => stash(match))
    .replace(/\\+\[[\s\S]+?\\+\]/g, (match) => stash(match))
    .replace(/\\+\(\s*\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}\s*\\+\)/g, (match) => stash(match))
    .replace(/\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}/g, (match) => stash(match))
    .replace(/\\+\([\s\S]+?\\+\)/g, (match) => stash(match))
    .replace(/\\+left(?:\\[A-Za-z]+|[()[\]{}|.])[\s\S]+?\\+right(?:\\[A-Za-z]+|[()[\]{}|.])/g, (match) =>
      stash(`\\(${normalizeMathExpression(match)}\\)`),
    )
    .replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (match, tex) => {
      const trimmed = String(tex || "").trim();
      if (!trimmed || /^\d/.test(trimmed)) return match;
      return stash(match);
    });
}

function restoreExplicitMathText(text: string, blocks: string[]): string {
  return text.replace(/\x00EXPLICITMATH(\d+)\x00/g, (_, idx) => blocks[parseInt(idx, 10)] ?? "");
}

function parseMatrixRow(line: string): ParsedMatrixRow | null {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed === "[" || trimmed === "]") return null;
  if (trimmed.includes(":")) return null;

  let inner = trimmed;
  if (inner.startsWith("[") && inner.endsWith("]")) {
    inner = inner.slice(1, -1).trim();
  }
  inner = inner.replace(/,/g, " ");

  if (!inner || !/[0-9A-Za-z]/.test(inner)) return null;
  if (/;/.test(inner)) return null;

  const segments = inner.split("|").map((segment) => segment.trim());
  if (segments.some((segment) => !segment)) return null;

  const parsed = segments.map((segment) =>
    segment
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );

  if (parsed[0].length < 2) return null;
  if (parsed.some((section) => section.length === 0)) return null;
  if (parsed.flat().some((token) => /^(?:=|\+|->|<-|=>)$/.test(token))) return null;

  return {
    left: parsed[0],
    right: parsed.slice(1).flat(),
  };
}

function buildArraySpec(leftCount: number, rightCount: number): string {
  return rightCount > 0 ? `${"c".repeat(leftCount)}|${"c".repeat(rightCount)}` : "c".repeat(leftCount);
}

function buildMatrixLatex(rows: ParsedMatrixRow[]): string | null {
  if (rows.length === 0) return null;

  const leftCount = rows[0].left.length;
  const rightCount = rows[0].right.length;

  if (leftCount === 0) return null;
  if (rows.some((row) => row.left.length !== leftCount || row.right.length !== rightCount)) return null;

  const rowLatex = rows
    .map((row) => {
      const left = row.left.map(normalizeMathToken).join(" & ");
      if (rightCount === 0) return left;
      const right = row.right.map(normalizeMathToken).join(" & ");
      return `${left} & ${right}`;
    })
    .join(" \\\\ ");

  if (rightCount > 0) {
    return `\\left[\\begin{array}{${buildArraySpec(leftCount, rightCount)}}${rowLatex}\\end{array}\\right]`;
  }

  if (rows.length === 1) {
    return `\\left[\\begin{array}{${buildArraySpec(leftCount, rightCount)}}${rowLatex}\\end{array}\\right]`;
  }

  return `\\begin{bmatrix}${rowLatex}\\end{bmatrix}`;
}

function convertInlineMatrixRows(line: string): string {
  return line.replace(/\[([^\]\n]+)\]/g, (match, inner) => {
    const parsed = parseMatrixRow(inner);
    if (!parsed) return match;
    const latex = buildMatrixLatex([parsed]);
    return latex ?? match;
  });
}

function isExistingMathLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("$$") || trimmed.startsWith("\\[") || trimmed.startsWith("\\(");
}

function isLikelyAssignmentLine(line: string): boolean {
  const trimmed = stripBullet(line);
  return /^(?:[A-Za-z]\s*=\s*[^,\n]+,\s*)+[A-Za-z]\s*=\s*[^,\n]+$/.test(trimmed);
}

function isLikelyDisplayEquation(line: string): boolean {
  const trimmed = stripBullet(convertInlineMatrixRows(line));
  if (!trimmed || isExistingMathLine(trimmed)) return false;
  if (/^#{1,6}\s/.test(trimmed) || /^>\s/.test(trimmed) || /^Final Answer:?$/i.test(trimmed)) return false;
  if (/https?:\/\//i.test(trimmed) || /[`]/.test(trimmed)) return false;
  if (/^[\[(].*[\])]\s*$/.test(trimmed) && parseMatrixRow(trimmed)) return true;
  if (isLikelyAssignmentLine(trimmed)) return true;

  const mathSignals = (trimmed.match(/=>|->|<-|=|\||\+|-|\*|\/|\bR\d+\b|\bx\b|\by\b|\bz\b|\bv\d+\b/g) || []).length;
  const hasVariable = /\b(?:[A-Za-z](?:_\{?\d+\}?|\d+)?|R\d+)\b/.test(trimmed);
  const proseWords = countProseWords(trimmed);

  return hasVariable && mathSignals >= 2 && proseWords <= 4;
}

function splitTrailingMath(line: string): { prefix: string; math: string } | null {
  const source = convertInlineMatrixRows(line);
  const colonMatches = [...source.matchAll(/:\s+/g)];
  for (let index = colonMatches.length - 1; index >= 0; index -= 1) {
    const match = colonMatches[index];
    const cut = (match.index ?? 0) + 1;
    const prefix = source.slice(0, cut).trim();
    const math = source.slice(cut + 1).trim();
    if (prefix && math && isLikelyDisplayEquation(math)) {
      return { prefix, math };
    }
  }
  return null;
}

function enhancePlainMathText(text: string): string {
  const lines = String(text || "").split("\n");
  const output: string[] = [];
  let activeMathFence: "$$" | "\\]" | "\\)" | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (activeMathFence) {
      output.push(line);
      if (
        (activeMathFence === "$$" && trimmed.endsWith("$$")) ||
        (activeMathFence !== "$$" && trimmed.endsWith(activeMathFence))
      ) {
        activeMathFence = null;
      }
      continue;
    }

    if (!trimmed) {
      output.push(line);
      continue;
    }

    if (trimmed.startsWith("$$")) {
      output.push(line);
      if (!(trimmed.length > 2 && trimmed.endsWith("$$"))) {
        activeMathFence = "$$";
      }
      continue;
    }

    if (trimmed.startsWith("\\[")) {
      output.push(line);
      if (!trimmed.endsWith("\\]")) {
        activeMathFence = "\\]";
      }
      continue;
    }

    if (trimmed.startsWith("\\(")) {
      output.push(line);
      if (!trimmed.endsWith("\\)")) {
        activeMathFence = "\\)";
      }
      continue;
    }

    if (trimmed === "[") {
      const rows: ParsedMatrixRow[] = [];
      let endIndex = i + 1;
      while (endIndex < lines.length && lines[endIndex].trim() !== "]") {
        const parsed = parseMatrixRow(lines[endIndex]);
        if (!parsed) break;
        rows.push(parsed);
        endIndex += 1;
      }
      if (rows.length > 0 && endIndex < lines.length && lines[endIndex].trim() === "]") {
        const latex = buildMatrixLatex(rows);
        if (latex) {
          output.push(toDisplayMath(latex));
          i = endIndex;
          continue;
        }
      }
    }

    const parsedRow = parseMatrixRow(trimmed);
    if (parsedRow) {
      const rowGroup: ParsedMatrixRow[] = [parsedRow];
      let endIndex = i + 1;
      while (endIndex < lines.length) {
        const nextParsed = parseMatrixRow(lines[endIndex]);
        if (!nextParsed) break;
        rowGroup.push(nextParsed);
        endIndex += 1;
      }
      if (rowGroup.length > 1) {
        const latex = buildMatrixLatex(rowGroup);
        if (latex) {
          output.push(toDisplayMath(latex));
          i = endIndex - 1;
          continue;
        }
      }
    }

    const split = splitTrailingMath(line);
    if (split) {
      output.push(split.prefix);
      output.push(toDisplayMath(normalizeMathExpression(split.math)));
      continue;
    }

    const inlineMatrices = convertInlineMatrixRows(line);
    if (isLikelyDisplayEquation(inlineMatrices)) {
      output.push(toDisplayMath(normalizeMathExpression(stripBullet(inlineMatrices))));
      continue;
    }

    output.push(inlineMatrices);
  }

  return output.join("\n");
}

export function formatMathResponse(text: string): string {
  if (!text) return text;

  let formatted = text;
  const displayBlocks: string[] = [];
  const envBlocks: string[] = [];

  const explicitBlocks: string[] = [];
  formatted = protectExplicitMathText(formatted, explicitBlocks);
  formatted = enhancePlainMathText(formatted);
  formatted = restoreExplicitMathText(formatted, explicitBlocks);

  // Preserve existing display-math blocks so environments inside them are not rewrapped.
  formatted = formatted.replace(
    /\$\$([\s\S]+?)\$\$/g,
    (match) => {
      displayBlocks.push(match);
      return `\x00DISPLAY${displayBlocks.length - 1}\x00`;
    },
  );

  // Extract LaTeX environments before normalizing wrappers around them.
  formatted = formatted.replace(
    /\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}/g,
    (match) => {
      envBlocks.push(match.trim());
      return `\x00ENV${envBlocks.length - 1}\x00`;
    },
  );

  // If an environment is wrapped with inline/display delimiters, prefer display math.
  formatted = formatted.replace(
    /\\+\(\s*\x00ENV(\d+)\x00\s*\\+\)/g,
    (_, idx) => toDisplayMath(envBlocks[parseInt(idx, 10)]),
  );
  formatted = formatted.replace(
    /\\+\[\s*\x00ENV(\d+)\x00\s*\\+\]/g,
    (_, idx) => toDisplayMath(envBlocks[parseInt(idx, 10)]),
  );

  // Standalone environments should render as display math.
  formatted = formatted.replace(
    /\x00ENV(\d+)\x00/g,
    (_, idx) => toDisplayMath(envBlocks[parseInt(idx, 10)]),
  );

  // Normalize display and inline delimiters for non-environment math.
  formatted = formatted.replace(
    /\\+\[\s*([\s\S]+?)\s*\\+\]/g,
    (_, tex) => toDisplayMath(normalizeMathExpression(tex)),
  );
  formatted = formatted.replace(
    /\\+\(\s*([\s\S]+?)\s*\\+\)/g,
    (_, tex) => `\\(${normalizeMathExpression(tex)}\\)`,
  );

  formatted = formatted.replace(
    /\$\$([\s\S]+?)\$\$/g,
    (_, tex) => toDisplayMath(normalizeMathExpression(tex)),
  );
  formatted = formatted.replace(
    /(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g,
    (_, tex) => {
      const trimmed = String(tex || "").trim();
      if (!trimmed || /^\d/.test(trimmed)) return `$${tex}$`;
      return `\\(${normalizeMathExpression(trimmed)}\\)`;
    },
  );

  // Restore pre-existing display blocks.
  formatted = formatted.replace(
    /\x00DISPLAY(\d+)\x00/g,
    (_, idx) => {
      const block = displayBlocks[parseInt(idx, 10)];
      const match = block.match(/^\$\$([\s\S]+?)\$\$$/);
      if (!match) return block;
      return toDisplayMath(normalizeMathExpression(match[1]));
    },
  );

  // Collapse excessive blank lines.
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted;
}
