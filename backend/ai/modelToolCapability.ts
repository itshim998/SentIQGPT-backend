import type { SentIQToolName } from "../orchestrator/toolContract";
import { getNemotronRolloutSnapshot } from "../nemotronRolloutFlags";

export type LLMProviderKind = "groq" | "gemini" | "gemma" | "pollinations" | "nvidia" | "unknown";

export const DIRECT_MODEL_IMAGE_INPUT = "image_input" as const;
export const SENTIQ_IMAGE_INPUT_TOOL: SentIQToolName = "image_input";

export type RequiredModelCapability =
  | typeof DIRECT_MODEL_IMAGE_INPUT
  | "sentiq_tools_buffered"
  | "sentiq_tools_streaming";

export type ToolTransportMode = "none" | "buffered" | "streaming";

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

export interface ModelToolTransportDecision {
  readonly provider: LLMProviderKind;
  readonly model: string;
  readonly requestedMode: Exclude<ToolTransportMode, "none">;
  readonly mode: ToolTransportMode;
  readonly supported: boolean;
  readonly reason: string;
}

export const SENTIQ_MODEL_TOOL_ENV = Object.freeze({
  registry: "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED",
  groqTransport: "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED",
  geminiTransport: "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED",
  pollinationsTransport: "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED",
  webSurfSelection: "SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED",
  imageSelection: "SENTIQ_MODEL_IMAGE_SELECTION_ENABLED",
  chartSelection: "SENTIQ_MODEL_CHART_SELECTION_ENABLED",
  fileSelection: "SENTIQ_MODEL_FILE_SELECTION_ENABLED",
  memorySelection: "SENTIQ_MODEL_MEMORY_SELECTION_ENABLED",
  diagnostics: "SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED",
} as const);

export const CANONICAL_SENTIQ_MODEL_TOOL_ENV_NAMES = Object.freeze(
  Object.values(SENTIQ_MODEL_TOOL_ENV),
);

export const OBSOLETE_SENTIQ_MODEL_TOOL_ENV_NAMES = Object.freeze([
  "SENTIQ_MODEL_TOOLS_REGISTRY_ENABLED",
  "SENTIQ_GROQ_MODEL_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_GEMINI_MODEL_TOOL_TRANSPORT_ENABLED",
  "SENTIQ_MODEL_WEB_SURF_SELECTION_ENABLED",
  "SENTIQ_WEBSURF_MODEL_SELECTION_ENABLED",
  "SENTIQ_IMAGE_MODEL_SELECTION_ENABLED",
  "SENTIQ_CHART_MODEL_SELECTION_ENABLED",
  "SENTIQ_FILE_MODEL_SELECTION_ENABLED",
  "SENTIQ_MEMORY_MODEL_SELECTION_ENABLED",
] as const);

export interface ModelToolRuntimeSnapshot {
  readonly registryEnabled: boolean;
  readonly groqTransportEnabled: boolean;
  readonly geminiTransportEnabled: boolean;
  readonly pollinationsTransportEnabled: boolean;
  readonly nvidiaTransportEnabled: boolean;
  readonly webSurfSelectionEnabled: boolean;
  readonly imageSelectionEnabled: boolean;
  readonly chartSelectionEnabled: boolean;
  readonly fileSelectionEnabled: boolean;
  readonly memorySelectionEnabled: boolean;
  readonly diagnosticsEnabled: boolean;
}

const CAPABILITIES: Readonly<Record<LLMProviderKind, SentIQToolCapability>> = {
  groq: { provider: "groq", buffered: true, streaming: true, reason: "openai_function_transport" },
  gemini: { provider: "gemini", buffered: true, streaming: false, reason: "google_genai_buffered_function_transport" },
  gemma: { provider: "gemma", buffered: false, streaming: false, reason: "text_only_model" },
  pollinations: { provider: "pollinations", buffered: true, streaming: true, reason: "openai_function_transport" },
  nvidia: { provider: "nvidia", buffered: true, streaming: true, reason: "openai_function_transport" },
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

export function resolveModelToolTransport(
  route: ModelCapabilityRoute,
  requestedMode: Exclude<ToolTransportMode, "none">,
): ModelToolTransportDecision {
  const provider = normalizeRouteProvider(route);
  const capability = getSentIQToolCapability(provider);
  const transportEnabled = provider === "groq"
    ? isGroqSentIQToolTransportEnabled()
    : provider === "gemini"
      ? isGeminiSentIQToolTransportEnabled()
      : provider === "pollinations"
        ? isPollinationsSentIQToolTransportEnabled()
        : provider === "nvidia"
          ? isNvidiaSentIQToolTransportEnabled()
          : false;
  if (!isModelToolRegistryEnabled()) {
    return { provider, model: route.model, requestedMode, mode: "none", supported: false, reason: "registry_disabled" };
  }
  if (!transportEnabled) {
    return { provider, model: route.model, requestedMode, mode: "none", supported: false, reason: "transport_disabled" };
  }
  if (requestedMode === "streaming" && capability.streaming) {
    return { provider, model: route.model, requestedMode, mode: "streaming", supported: true, reason: capability.reason };
  }
  if (capability.buffered) {
    return {
      provider,
      model: route.model,
      requestedMode,
      mode: "buffered",
      supported: true,
      reason: requestedMode === "streaming" ? "buffered_tool_bridge" : capability.reason,
    };
  }
  return { provider, model: route.model, requestedMode, mode: "none", supported: false, reason: capability.reason };
}

export function normalizeRouteProvider(route: ModelCapabilityRoute): LLMProviderKind {
  const provider = route.provider.trim().toLowerCase();
  const model = route.model.trim().toLowerCase();
  if (provider === "gemini" && model.includes("gemma")) return "gemma";
  if (provider === "groq") return isGroqSentIQToolModel(model) ? "groq" : "unknown";
  if (provider === "gemini" || provider === "gemma" || provider === "pollinations" || provider === "nvidia") {
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
  if (provider === "pollinations") return isPollinationsSentIQToolTransportEnabled();
  if (provider === "nvidia") return isNvidiaSentIQToolTransportEnabled();
  return false;
}

export function deriveRequiredModelCapabilities(args: {
  readonly hasImageInput?: boolean;
  readonly automaticToolsRequested?: boolean;
  readonly streaming?: boolean;
  readonly toolTransportMode?: Exclude<ToolTransportMode, "none">;
}): readonly RequiredModelCapability[] {
  const requirements: RequiredModelCapability[] = [];
  if (args.hasImageInput) requirements.push("image_input");
  if (args.automaticToolsRequested) {
    const mode = args.toolTransportMode ?? (args.streaming ? "streaming" : "buffered");
    requirements.push(mode === "streaming" ? "sentiq_tools_streaming" : "sentiq_tools_buffered");
  }
  return requirements;
}

export function findObsoleteModelToolEnvironmentNames(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const canonical = new Set<string>(CANONICAL_SENTIQ_MODEL_TOOL_ENV_NAMES);
  const obsolete = new Set<string>(OBSOLETE_SENTIQ_MODEL_TOOL_ENV_NAMES);
  const editDistance = (left: string, right: string): number => {
    const row = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      let diagonal = row[0];
      row[0] = leftIndex;
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const previous = row[rightIndex];
        row[rightIndex] = Math.min(
          row[rightIndex] + 1,
          row[rightIndex - 1] + 1,
          diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
        );
        diagonal = previous;
      }
    }
    return row[right.length];
  };
  return Object.keys(env)
    .filter((name) => {
      if (canonical.has(name) || typeof env[name] !== "string") return false;
      if (obsolete.has(name)) return true;
      if (!name.startsWith("SENTIQ_") || !name.includes("MODEL")) return false;
      return CANONICAL_SENTIQ_MODEL_TOOL_ENV_NAMES.some((expected) => editDistance(name, expected) <= 3);
    })
    .sort();
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

export function isPollinationsSentIQToolTransportEnabled(
  value = process.env[SENTIQ_MODEL_TOOL_ENV.pollinationsTransport],
): boolean {
  return value === undefined ? true : value.trim().toLowerCase() === "true";
}

export function isNvidiaSentIQToolTransportEnabled(): boolean {
  const flags = getNemotronRolloutSnapshot();
  return flags.nvidiaProvider && flags.nemotronIntuitive;
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
    pollinationsTransportEnabled: isPollinationsSentIQToolTransportEnabled(),
    nvidiaTransportEnabled: isNvidiaSentIQToolTransportEnabled(),
    webSurfSelectionEnabled: isModelWebSurfSelectionEnabled(),
    imageSelectionEnabled: isModelImageSelectionEnabled(),
    chartSelectionEnabled: isModelChartSelectionEnabled(),
    fileSelectionEnabled: isModelFileSelectionEnabled(),
    memorySelectionEnabled: isModelMemorySelectionEnabled(),
    diagnosticsEnabled: isModelToolDiagnosticsEnabled(),
  };
}

export function isModelImageInputSelectionEnabled(
  value = process.env.SENTIQ_MODEL_IMAGE_INPUT_SELECTION_ENABLED,
): boolean {
  return value === undefined ? true : value.trim().toLowerCase() === "true";
}

export function hasVisualAssetsRequiringAnalysis(
  fileReferences?: readonly Record<string, unknown>[] | readonly any[],
  visualAssets?: readonly Record<string, unknown>[] | readonly any[],
  imageAttachments?: readonly Record<string, unknown>[] | readonly any[],
): boolean {
  const checkItem = (ref: any): boolean => {
    if (!ref || typeof ref !== "object") return false;
    if (ref.visual_required === true || ref.visualRequired === true) return true;
    if (ref.visual_analysis_status === "required" || ref.visualAnalysisStatus === "required") return true;
    const type = String(ref.type || ref.asset_type || "").toLowerCase();
    const mime = String(ref.mime_type || ref.mimeType || ref.original_mime_type || "").toLowerCase();
    if (type === "image" || mime.startsWith("image/")) return true;
    const hasAsset = Boolean(ref.asset_id || ref.assetId || ref.visual_asset_id || ref.visualAssetId || ref.id);
    const notReady = ref.visual_analysis_status !== "ready" && ref.visualAnalysisStatus !== "ready";
    return hasAsset && notReady;
  };
  if (Array.isArray(fileReferences) && fileReferences.some(checkItem)) return true;
  if (Array.isArray(visualAssets) && visualAssets.some(checkItem)) return true;
  if (Array.isArray(imageAttachments) && imageAttachments.length > 0) return true;
  return false;
}

export function getEnabledAutomaticSentIQTools(options?: {
  readonly hasVisualAssetsNeedingAnalysis?: boolean;
  readonly fileReferences?: readonly unknown[];
  readonly visualAssets?: readonly unknown[];
  readonly imageAttachments?: readonly unknown[];
}): readonly SentIQToolName[] {
  const flags = getModelToolRuntimeSnapshot();
  if (!flags.registryEnabled) return [];
  if (
    !flags.groqTransportEnabled
    && !flags.geminiTransportEnabled
    && !flags.pollinationsTransportEnabled
    && !flags.nvidiaTransportEnabled
  ) return [];
  const visualNeeded = options?.hasVisualAssetsNeedingAnalysis
    ?? (
      Boolean(options?.imageAttachments?.length) ||
      Boolean(options?.visualAssets?.length) ||
      hasVisualAssetsRequiringAnalysis(options?.fileReferences, options?.visualAssets, options?.imageAttachments)
    );
  return [
    ...(flags.webSurfSelectionEnabled ? ["web_surf" as const] : []),
    ...(flags.imageSelectionEnabled ? ["image_gen" as const] : []),
    ...(flags.chartSelectionEnabled ? ["chart_gen" as const] : []),
    ...(flags.fileSelectionEnabled ? ["file_gen" as const] : []),
    ...(flags.memorySelectionEnabled ? ["memory_update" as const] : []),
    ...(visualNeeded && isModelImageInputSelectionEnabled() ? ["image_input" as const] : []),
  ];
}

export function getAutomaticSentIQToolsForRoute(
  route: ModelCapabilityRoute,
  streaming: boolean,
  options?: {
    readonly hasVisualAssetsNeedingAnalysis?: boolean;
    readonly fileReferences?: readonly unknown[];
    readonly visualAssets?: readonly unknown[];
    readonly imageAttachments?: readonly unknown[];
  },
): readonly SentIQToolName[] {
  const tools = getEnabledAutomaticSentIQTools(options);
  if (tools.length === 0) return [];
  const decision = resolveModelToolTransport(route, streaming ? "streaming" : "buffered");
  return decision.supported ? tools : [];
}
