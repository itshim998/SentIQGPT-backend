export type MemoryScope = "global" | "chat";

const CHAT_SCOPED_MEMORY_PATTERNS: readonly RegExp[] = [
  /\b(?:only|just)\s+(?:for|in)\s+(?:this|current)\s+(?:chat|conversation|thread|session)\b/i,
  /\b(?:this|current)\s+(?:chat|conversation|thread|session)\s+only\b/i,
  /\b(?:for|in)\s+(?:this|current)\s+(?:chat|conversation|thread|session)\s+only\b/i,
  /\b(?:don't|do not)\s+(?:remember|use|carry)\s+(?:this|it)\s+(?:outside|beyond)\s+(?:this|current)\s+(?:chat|conversation|thread|session)\b/i,
  /\b(?:keep|save|store|remember)\s+(?:this|it)\s+(?:only|just)\s+(?:here|for now)\b/i,
];

export function isChatScopedMemoryRequest(message: string): boolean {
  return CHAT_SCOPED_MEMORY_PATTERNS.some((pattern) => pattern.test(message));
}

export function resolveMemoryScopeForRequest(
  memory: { scope?: MemoryScope | string | null } | undefined,
  userMessage: string,
): MemoryScope {
  if (memory?.scope === "chat") return "chat";
  if (isChatScopedMemoryRequest(userMessage)) return "chat";
  return "global";
}

export function getMemoryConfirmationText(scope: MemoryScope): string {
  return scope === "chat"
    ? "Got it. I've remembered that for this chat."
    : "Got it. I've remembered that across chats.";
}

export const MEMORY_PERSISTENCE_FAILURE_TEXT =
  "I couldn't save that memory durably. Please try again in a moment.";
