import type { SentIQToolName } from "../orchestrator/toolContract";

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

export function isModelWebSurfSelectionEnabled(
  value = process.env.SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelImageSelectionEnabled(
  value = process.env.SENTIQ_MODEL_IMAGE_SELECTION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelChartSelectionEnabled(
  value = process.env.SENTIQ_MODEL_CHART_SELECTION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelFileSelectionEnabled(
  value = process.env.SENTIQ_MODEL_FILE_SELECTION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelMemorySelectionEnabled(
  value = process.env.SENTIQ_MODEL_MEMORY_SELECTION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelConversationalClarificationEnabled(
  value = process.env.SENTIQ_MODEL_CONVERSATIONAL_CLARIFICATION_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isAutomaticConversationalClarificationEnabled(): boolean {
  return isModelToolRegistryEnabled()
    && (isGroqSentIQToolTransportEnabled() || isGeminiSentIQToolTransportEnabled())
    && isModelConversationalClarificationEnabled();
}

export function getEnabledAutomaticSentIQTools(): readonly SentIQToolName[] {
  if (!isModelToolRegistryEnabled()) return [];
  if (!isGroqSentIQToolTransportEnabled() && !isGeminiSentIQToolTransportEnabled()) return [];
  return [
    ...(isModelWebSurfSelectionEnabled() ? ["web_surf" as const] : []),
    ...(isModelImageSelectionEnabled() ? ["image_gen" as const] : []),
    ...(isModelChartSelectionEnabled() ? ["chart_gen" as const] : []),
    ...(isModelFileSelectionEnabled() ? ["file_gen" as const] : []),
    ...(isModelMemorySelectionEnabled() ? ["memory_update" as const] : []),
  ];
}
