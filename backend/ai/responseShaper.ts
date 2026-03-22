export function shapeMathResponse(text: string): string {
  if (!text) return text;

  let cleaned = text;

  const removePatterns = [
    /let'?s\s+solve.*?:?/gi,
    /i\s+will\s+solve.*?:?/gi,
    /we\s+are\s+given.*?:?/gi,
    /first,?\s*/gi,
    /now,?\s*/gi,
    /then,?\s*/gi,
    /next,?\s*/gi,
  ];

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

  return cleaned;
}
