export function formatMathResponse(text: string): string {
  if (!text) return text;

  let formatted = text;

  // Fix single backslashes so LaTeX commands survive rendering.
  formatted = formatted.replace(/(^|[^\\])\\(?!\\)/g, "$1\\\\");

  // Normalize matrix row breaks.
  formatted = formatted.replace(/\s+\\\\\s+/g, " \\\\ ");

  // Wrap LaTeX environments for block rendering.
  formatted = formatted.replace(
    /\\+begin\{.*?\}[\s\S]*?\\+end\{.*?\}/g,
    (match) => `$$\n${match}\n$$`,
  );

  // Collapse excessive blank lines.
  formatted = formatted.replace(/\n{3,}/g, "\n\n");

  return formatted;
}
