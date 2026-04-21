import { finalizeStructuredReply } from "./replyGuard";

export function finalizeMathReply(
  reply?: string,
  emptyFallback = "Sorry, something went wrong. Please try again.",
): string {
  return finalizeStructuredReply(reply, {
    preserveFormatting: true,
    preferExplanation: false,
    emptyFallback,
    sanitizeMode: "minimal",
  }).answer;
}
