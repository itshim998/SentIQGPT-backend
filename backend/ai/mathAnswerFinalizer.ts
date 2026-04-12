import { finalizeUserFacingReply } from "./replyGuard";

export function finalizeMathReply(
  reply?: string,
  emptyFallback = "Sorry, something went wrong. Please try again.",
): string {
  return finalizeUserFacingReply(reply, {
    preserveFormatting: true,
    emptyFallback,
  });
}
