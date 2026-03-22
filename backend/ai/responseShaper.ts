export function shapeMathResponse(text: string): string {
  if (!text) return text;

  let cleaned = text;
  const mathBlocks: string[] = [];

  const removePatterns = [
    /let'?s\s+solve.*?:?/gi,
    /i\s+will\s+solve.*?:?/gi,
    /we\s+are\s+given.*?:?/gi,
    /first,?\s*/gi,
    /now,?\s*/gi,
    /then,?\s*/gi,
    /next,?\s*/gi,
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

  removePatterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, "");
  });

  cleaned = cleaned.replace(/\n{2,}/g, "\n");

  if (!/^\d+\./m.test(cleaned)) {
    const lines = cleaned
      .split(/[.\n]/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    cleaned = lines
      .map((line, idx) => `${idx + 1}. ${line}`)
      .join("\n");
  }

  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\x00MATH(\d+)\x00/g, (_, idx) => mathBlocks[parseInt(idx, 10)]);

  return cleaned;
}
