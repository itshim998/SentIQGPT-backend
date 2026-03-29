export function finalizeMathReply(
  reply?: string,
  emptyFallback = "Sorry, something went wrong. Please try again.",
): string {
  const cleanedReply = reply
    ? reply
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
    : emptyFallback;

  if (!cleanedReply || cleanedReply.trim().length < 5) {
    return "Sorry, something went wrong. Please try again.";
  }

  return cleanedReply;
}
