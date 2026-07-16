const UNBACKED_COMPLETION_PATTERNS: readonly RegExp[] = [
  /\b(?:i|i've|i have)\s+(?:successfully\s+)?searched\s+(?:the\s+)?web\b/i,
  /\b(?:i|i've|i have)\s+(?:successfully\s+)?generated\s+(?:the|your|an?)\s+image\b/i,
  /\b(?:i|i've|i have)\s+(?:successfully\s+)?created\s+(?:the|your|an?)\s+(?:chart|file|pdf|document|spreadsheet|presentation)\b/i,
  /\b(?:i|i've|i have)\s+(?:successfully\s+)?(?:saved|stored)\s+(?:that|this|it|your\s+preference)\s+(?:in|to)\s+(?:my\s+)?memory\b/i,
  /\b(?:that|this|it|your\s+preference)\s+(?:has\s+been|is\s+now)\s+(?:saved|stored)\s+(?:in|to)\s+(?:my\s+)?memory\b/i,
];

export class UnbackedToolCompletionClaimError extends Error {
  readonly code = "model_tool_capability_unavailable";

  constructor() {
    super("The model claimed a tool side effect without a corresponding tool result.");
    this.name = "UnbackedToolCompletionClaimError";
  }
}

export function assertNoUnbackedToolCompletionClaim(text: string): string {
  const normalized = text.trim();
  if (UNBACKED_COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw new UnbackedToolCompletionClaimError();
  }
  return text;
}
