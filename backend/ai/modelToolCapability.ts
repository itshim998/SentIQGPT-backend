export type LLMProviderKind = "groq" | "gemini" | "gemma" | "pollinations" | "unknown";

export interface SentIQToolCapability {
  readonly provider: LLMProviderKind;
  readonly buffered: boolean;
  readonly streaming: boolean;
  readonly reason: string;
}

const CAPABILITIES: Readonly<Record<LLMProviderKind, SentIQToolCapability>> = {
  groq: { provider: "groq", buffered: true, streaming: true, reason: "openai_function_transport" },
  gemini: { provider: "gemini", buffered: true, streaming: true, reason: "google_function_transport" },
  gemma: { provider: "gemma", buffered: false, streaming: false, reason: "text_only_model" },
  pollinations: { provider: "pollinations", buffered: false, streaming: false, reason: "text_only_transport" },
  unknown: { provider: "unknown", buffered: false, streaming: false, reason: "capability_not_declared" },
};

export function getSentIQToolCapability(provider: LLMProviderKind): SentIQToolCapability {
  return CAPABILITIES[provider];
}

export function canUseSentIQTools(provider: LLMProviderKind, streaming: boolean): boolean {
  const capability = getSentIQToolCapability(provider);
  return streaming ? capability.streaming : capability.buffered;
}

export function isModelToolRegistryEnabled(
  value = process.env.SENTIQ_MODEL_TOOL_REGISTRY_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isGroqSentIQToolTransportEnabled(
  value = process.env.SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isGeminiSentIQToolTransportEnabled(
  value = process.env.SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}
