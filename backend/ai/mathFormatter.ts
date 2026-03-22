export function formatMathResponse(text: string): string {
  if (!text) return text;

  let formatted = text;
  const displayBlocks: string[] = [];
  const envBlocks: string[] = [];
  const toDisplayMath = (tex: string) => `$$\n${tex.trim()}\n$$`;

  // Normalize doubled LaTeX command delimiters without touching row breaks.
  formatted = formatted.replace(/\\\\(?=(?:begin|end|[A-Za-z()[\]]))/g, "\\");

  // Normalize matrix row breaks.
  formatted = formatted.replace(/\s+\\\\\s+/g, " \\\\ ");

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
    (_, tex) => toDisplayMath(tex),
  );
  formatted = formatted.replace(
    /\\+\(\s*([\s\S]+?)\s*\\+\)/g,
    (_, tex) => `$${tex.trim()}$`,
  );

  // Restore pre-existing display blocks.
  formatted = formatted.replace(
    /\x00DISPLAY(\d+)\x00/g,
    (_, idx) => displayBlocks[parseInt(idx, 10)],
  );

  // Collapse excessive blank lines.
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted;
}
