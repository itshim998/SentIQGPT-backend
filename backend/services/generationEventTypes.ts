export const GENERATION_EVENT_TYPES = Object.freeze([
  "generation_started",
  "route",
  "thinking",
  "tool_started",
  "tool_result",
  "token",
  "structured_response",
  "generation_checkpoint",
  "generation_completed",
  "generation_failed",
  "generation_cancelled",
] as const);

export type GenerationEventType = typeof GENERATION_EVENT_TYPES[number];

const CANONICAL_ALIASES: Record<string, GenerationEventType> = {
  generation_started: "generation_started",
  route: "route",
  thinking: "thinking",
  tool_selected: "tool_started",
  tool_started: "tool_started",
  tool_result: "tool_result",
  tool_error: "tool_result",
  token: "token",
  file_token: "token",
  structured_response: "structured_response",
  generation_checkpoint: "generation_checkpoint",
  generation_completed: "generation_completed",
  generation_failed: "generation_failed",
  generation_cancelled: "generation_cancelled",
};

export function normalizeGenerationEventType(value: unknown): GenerationEventType | null {
  if (typeof value !== "string") return null;
  return CANONICAL_ALIASES[value] ?? null;
}

export type CanonicalGenerationEvent = {
  generation_id: string;
  conversation_id: string | null;
  sequence: number;
  type: GenerationEventType;
  original_type?: string;
  [key: string]: unknown;
};
