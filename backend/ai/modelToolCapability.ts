import type { SentIQToolName } from "../orchestrator/toolContract";

export type LLMProviderKind = "groq" | "gemini" | "gemma" | "pollinations" | "unknown";

export type RequiredModelCapability =
  | "image_input"
  | "sentiq_tools_buffered"
  | "sentiq_tools_streaming";

export interface ModelCapabilityRoute {
  readonly provider: string;
  readonly model: string;
}

export interface SentIQToolCapability {
  readonly provider: LLMProviderKind;
  readonly buffered: boolean;
  readonly streaming: boolean;
  readonly reason: string;
}

export const SENTIQ_MODEL_TOOL_ENV = Object.freeze({
  registry: "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  groqTransport: "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  geminiTransport: "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  webSurfSelection: "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  imageSelection: "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  chartSelection: "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  fileSelection: "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  memorySelection: "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  diagnostics: "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
} as const);

export interface ModelToolRuntimeSnapshot {
  readonly registryEnabled: boolean;
  readonly groqTransportEnabled: boolean;
  readonly geminiTransportEnabled: boolean;
  readonly webSurfSelectionEnabled: boolean;
  readonly imageSelectionEnabled: boolean;
  readonly chartSelectionEnabled: boolean;
  readonly fileSelectionEnabled: boolean;
  readonly memorySelectionEnabled: boolean;
  readonly diagnosticsEnabled: boolean;
}

const CAPABILITIES: Readonly<Record<LLMProviderKind, SentIQToolCapability>> = {
  groq: { provider: "groq", buffered: true, streaming: true, reason: "openai_function_transport" },
  gemini: { provider: "gemini", buffered: true, streaming: true, reason: "google_function_transport" },
  gemma: { provider: "gemma", buffered: false, streaming: false, reason: "text_only_model" },
  pollinations: { provider: "pollinations", buffered: false, streaming: false, reason: "text_only_transport" },
  unknown: { provider: "unknown", buffered: false, streaming: false, reason: "capability_not_declared" },
};

const GROQ_SENTIQ_TOOL_MODELS = new Set([
  "gpt-oss-120b",
  "openai/gpt-oss-120b",
]);

export function isGroqSentIQToolModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  const withoutProvider = normalized.startsWith("groq:") ? normalized.slice("groq:".length) : normalized;
  return GROQ_SENTIQ_TOOL_MODELS.has(withoutProvider);
}

export function getSentIQToolCapability(provider: LLMProviderKind): SentIQToolCapability {
  return CAPABILITIES[provider];
}

export function canUseSentIQTools(provider: LLMProviderKind, streaming: boolean): boolean {
  const capability = getSentIQToolCapability(provider);
  return streaming ? capability.streaming : capability.buffered;
}

export function normalizeRouteProvider(route: ModelCapabilityRoute): LLMProviderKind {
  const provider = route.provider.trim().toLowerCase();
  const model = route.model.trim().toLowerCase();
  if (provider === "gemini" && model.includes("gemma")) return "gemma";
  if (provider === "groq") return isGroqSentIQToolModel(model) ? "groq" : "unknown";
  if (provider === "gemini" || provider === "gemma" || provider === "pollinations") {
    return provider;
  }
  return "unknown";
}

export function routeSupportsCapability(
  route: ModelCapabilityRoute,
  capability: RequiredModelCapability,
): boolean {
  const provider = normalizeRouteProvider(route);
  if (capability === "image_input") return provider === "gemini";
  if (capability === "sentiq_tools_buffered") return canUseSentIQTools(provider, false);
  return canUseSentIQTools(provider, true);
}

export function routeSupportsCapabilities(
  route: ModelCapabilityRoute,
  requiredCapabilities: readonly RequiredModelCapability[],
): boolean {
  return requiredCapabilities.every((capability) => routeSupportsCapability(route, capability));
}

export function routeCanServeRequiredCapabilities(
  route: ModelCapabilityRoute,
  requiredCapabilities: readonly RequiredModelCapability[],
): boolean {
  if (!routeSupportsCapabilities(route, requiredCapabilities)) return false;
  const requiresTools = requiredCapabilities.some((capability) => capability.startsWith("sentiq_tools_"));
  if (!requiresTools) return true;
  if (!isModelToolRegistryEnabled()) return false;
  const provider = normalizeRouteProvider(route);
  if (provider === "groq") return isGroqSentIQToolTransportEnabled();
  if (provider === "gemini") return isGeminiSentIQToolTransportEnabled();
  return false;
}

export function deriveRequiredModelCapabilities(args: {
  readonly hasImageInput?: boolean;
  readonly automaticToolsRequested?: boolean;
  readonly streaming?: boolean;
}): readonly RequiredModelCapability[] {
  const requirements: RequiredModelCapability[] = [];
  if (args.hasImageInput) requirements.push("image_input");
  if (args.automaticToolsRequested) {
    requirements.push(args.streaming ? "sentiq_tools_streaming" : "sentiq_tools_buffered");
  }
  return requirements;
}

export function isModelToolRegistryEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.registry],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isGroqSentIQToolTransportEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.groqTransport],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isGeminiSentIQToolTransportEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.geminiTransport],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelWebSurfSelectionEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.webSurfSelection],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelImageSelectionEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.imageSelection],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelChartSelectionEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.chartSelection],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelFileSelectionEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.fileSelection],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelMemorySelectionEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.memorySelection],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isModelToolDiagnosticsEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.diagnostics],
): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function getModelToolRuntimeSnapshot(): ModelToolRuntimeSnapshot {
  return {
    registryEnabled: isModelToolRegistryEnabled(),
    groqTransportEnabled: isGroqSentIQToolTransportEnabled(),
    geminiTransportEnabled: isGeminiSentIQToolTransportEnabled(),
    webSurfSelectionEnabled: isModelWebSurfSelectionEnabled(),
    imageSelectionEnabled: isModelImageSelectionEnabled(),
    chartSelectionEnabled: isModelChartSelectionEnabled(),
    fileSelectionEnabled: isModelFileSelectionEnabled(),
    memorySelectionEnabled: isModelMemorySelectionEnabled(),
    diagnosticsEnabled: isModelToolDiagnosticsEnabled(),
  };
}

export function getEnabledAutomaticSentIQTools(): readonly SentIQToolName[] {
  const flags = getModelToolRuntimeSnapshot();
  if (!flags.registryEnabled) return [];
  if (!flags.groqTransportEnabled && !flags.geminiTransportEnabled) return [];
  return [
    ...(flags.webSurfSelectionEnabled ? ["web_surf" as const] : []),
    ...(flags.imageSelectionEnabled ? ["image_gen" as const] : []),
    ...(flags.chartSelectionEnabled ? ["chart_gen" as const] : []),
    ...(flags.fileSelectionEnabled ? ["file_gen" as const] : []),
    ...(flags.memorySelectionEnabled ? ["memory_update" as const] : []),
  ];
}

export function getAutomaticSentIQToolsForRoute(
  route: ModelCapabilityRoute,
  streaming: boolean,
): readonly SentIQToolName[] {
  const tools = getEnabledAutomaticSentIQTools();
  if (tools.length === 0) return [];
  const provider = normalizeRouteProvider(route);
  if (!canUseSentIQTools(provider, streaming)) return [];
  if (provider === "groq" && !isGroqSentIQToolTransportEnabled()) return [];
  if (provider === "gemini" && !isGeminiSentIQToolTransportEnabled()) return [];
  return tools;
}
