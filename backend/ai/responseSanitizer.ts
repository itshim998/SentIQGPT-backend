export function sanitizeResponse(response: string): string {
  const leakagePatterns = [
    /i will solve/i,
    /step[- ]by[- ]step/i,
    /as an ai/i,
    /i am an ai/i,
    /i am designed/i,
    /you asked me/i,
    /following the rules/i,
  ];
  const internalPatterns = [
    /invalid json/gi,
    /unexpected token/gi,
    /internal server error/gi,
    /modeloutputsanitizationerror/gi,
  ];

  let cleaned = response ?? "";

  for (const pattern of leakagePatterns) {
    cleaned = cleaned.replace(pattern, " ");
  }

  for (const pattern of internalPatterns) {
    cleaned = cleaned.replace(pattern, " ");
  }

  cleaned = cleaned
    .replace(/\s+/g, " ")
    .replace(/\s([.,!?])/g, "$1")
    .replace(/^[,.;:!?]+\s*/g, "")
    .replace(/^\s*(?:this|that)\.\s*/i, "")
    .replace(/^(?:to\s+(?:provide|help|assist|answer)\b[^,.!?]*,\s*)+/i, "")
    .replace(/^(?:to\s+(?:provide|help|assist|answer)\b[^.!?]*[.!?]\s*)+/i, "")
    .replace(/\s+[,.;:!?]+$/g, "")
    .replace(/([.!?]\s+)to\s+/g, "$1To ")
    .replace(/^to\s+[a-z]/i, (match) => match.charAt(0).toUpperCase() + match.slice(1))
    .trim();

  const isBroken =
    !cleaned ||
    cleaned.length < 5 ||
    /(?:=|:)\s*$/.test(cleaned);

  if (isBroken) {
    console.log("[SANITIZER] cleaned response");
    return "Sorry, I couldn't generate a proper response. Please try again.";
  }

  if (cleaned !== response) {
    console.log("[SANITIZER] cleaned response");
  }

  return cleaned;
}
