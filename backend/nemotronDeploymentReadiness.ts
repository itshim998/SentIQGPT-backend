import {
  getNemotronRolloutSnapshot,
  type NemotronRolloutEnvironment,
} from "./nemotronRolloutFlags";

export const NEMOTRON_DEPLOYMENT_ENV = Object.freeze({
  rolloutStage: "SENTIQ_NEMOTRON_ROLLOUT_STAGE",
  canaryDeploymentId: "SENTIQ_NEMOTRON_CANARY_DEPLOYMENT_ID",
  fullRolloutAck: "SENTIQ_NEMOTRON_FULL_ROLLOUT_ACK",
} as const);

export const NEMOTRON_FULL_ROLLOUT_ACK = "ENABLE_FULL_NEMOTRON_ROLLOUT";
export const EXPECTED_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const EXPECTED_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const EXPECTED_POLLINATIONS_ENDPOINT = "https://gen.pollinations.ai/v1/chat/completions";
export const EXPECTED_POLLINATIONS_MODEL = "vendouple/nemotron-3-ultra:free";
export const REQUIRED_FULL_ROLLOUT_NVIDIA_SLOTS = 6;

export type NemotronRolloutStage = "off" | "canary" | "full";

export interface NemotronReadinessIssue {
  readonly code: string;
  readonly message: string;
}

export interface NemotronDeploymentReadinessReport {
  readonly ready: boolean;
  readonly status: "ready" | "blocked";
  readonly stage: NemotronRolloutStage;
  readonly activeFlagCount: number;
  readonly flags: Readonly<{
    nvidiaProvider: boolean;
    nemotronIntuitive: boolean;
    unifiedTextTokensV2: boolean;
    intuitiveQuotaUi: boolean;
  }>;
  readonly checks: Readonly<{
    flagBundleComplete: boolean;
    providerKeySlots: number;
    pollinationsCredentialConfigured: boolean;
    nvidiaBaseUrlPinned: boolean;
    primaryModelPinned: boolean;
    pollinationsEndpointPinned: boolean;
    freeFallbackPinned: boolean;
    anonymousIdentitySecretConfigured: boolean;
    controlDatabaseConfigured: boolean;
    timeoutMs: number;
    maximumGeneratedTokens: number;
    pythonQuotaEnforcementDisabled: boolean;
  }>;
  readonly issues: readonly NemotronReadinessIssue[];
  readonly warnings: readonly NemotronReadinessIssue[];
}

interface ReadinessOptions {
  readonly requireEnabled?: boolean;
  readonly requireCompleteBundle?: boolean;
  readonly expectedStage?: NemotronRolloutStage;
}

function readString(environment: NemotronRolloutEnvironment, name: string): string {
  return String(environment[name] ?? "").trim();
}

function readInteger(
  environment: NemotronRolloutEnvironment,
  name: string,
  fallback: number,
): number {
  const raw = readString(environment, name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function readStage(environment: NemotronRolloutEnvironment): {
  readonly stage: NemotronRolloutStage;
  readonly valid: boolean;
} {
  const raw = readString(environment, NEMOTRON_DEPLOYMENT_ENV.rolloutStage).toLowerCase();
  if (!raw || raw === "off") return { stage: "off", valid: true };
  if (raw === "canary" || raw === "full") return { stage: raw, valid: true };
  return { stage: "off", valid: false };
}

function countNvidiaKeySlots(environment: NemotronRolloutEnvironment): number {
  const slots = new Set<string>();
  if (readString(environment, "NVIDIA_API_KEY")) slots.add("legacy");
  for (const [name, value] of Object.entries(environment)) {
    const match = /^NVIDIA_API_KEY_(\d+)$/.exec(name);
    if (match && String(value ?? "").trim()) slots.add(match[1]);
  }
  return slots.size;
}

function normalizeCredentialFreeHttpsEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function endpointMatches(value: string, expected: string): boolean {
  return normalizeCredentialFreeHttpsEndpoint(value) === normalizeCredentialFreeHttpsEndpoint(expected);
}

function hasControlDatabase(environment: NemotronRolloutEnvironment): boolean {
  return Boolean(
    readString(environment, "SUPABASE_URL_1")
    && readString(environment, "SUPABASE_SERVICE_ROLE_KEY_1"),
  );
}

function addIssue(
  target: NemotronReadinessIssue[],
  code: string,
  message: string,
): void {
  if (target.some((issue) => issue.code === code)) return;
  target.push(Object.freeze({ code, message }));
}

export function evaluateNemotronDeploymentReadiness(
  environment: NemotronRolloutEnvironment = process.env,
  options: ReadinessOptions = {},
): NemotronDeploymentReadinessReport {
  const flags = getNemotronRolloutSnapshot(environment);
  const stageResult = readStage(environment);
  const stage = stageResult.stage;
  const activeFlagCount = Object.values(flags).filter(Boolean).length;
  const flagBundleComplete = activeFlagCount === 4;
  const providerKeySlots = countNvidiaKeySlots(environment);
  const pollinationsCredentialConfigured = Boolean(readString(environment, "POLLINATIONS_API_KEY"));
  const timeoutMs = readInteger(environment, "SENTIQ_INTUITIVE_TOTAL_TIMEOUT_MS", 120_000);
  const maximumGeneratedTokens = readInteger(environment, "SENTIQ_NVIDIA_MAX_GENERATED_TOKENS", 8_000);
  const nvidiaBaseUrlPinned = endpointMatches(
    readString(environment, "NVIDIA_BASE_URL") || EXPECTED_NVIDIA_BASE_URL,
    EXPECTED_NVIDIA_BASE_URL,
  );
  const primaryModelPinned = (
    readString(environment, "NVIDIA_NEMOTRON_MODEL") || EXPECTED_NVIDIA_MODEL
  ) === EXPECTED_NVIDIA_MODEL;
  const pollinationsEndpointPinned = endpointMatches(
    readString(environment, "POLLINATIONS_OPENAI_ENDPOINT") || EXPECTED_POLLINATIONS_ENDPOINT,
    EXPECTED_POLLINATIONS_ENDPOINT,
  );
  const freeFallbackPinned = (
    readString(environment, "POLLINATIONS_INTUITIVE_MODEL") || EXPECTED_POLLINATIONS_MODEL
  ) === EXPECTED_POLLINATIONS_MODEL;
  const anonymousIdentitySecretConfigured = Boolean(
    readString(environment, "SENTIQ_ANON_USAGE_HASH_SECRET"),
  );
  const controlDatabaseConfigured = hasControlDatabase(environment);
  const pythonQuotaEnforcementDisabled = !["1", "true", "yes", "on"].includes(
    readString(environment, "SENTIQ_PYTHON_LLM_QUOTA_ENFORCEMENT").toLowerCase(),
  );
  const issues: NemotronReadinessIssue[] = [];
  const warnings: NemotronReadinessIssue[] = [];

  if (!stageResult.valid) {
    addIssue(
      issues,
      "invalid_rollout_stage",
      "SENTIQ_NEMOTRON_ROLLOUT_STAGE must be off, canary, or full.",
    );
  }

  if (flags.nemotronIntuitive && !flags.nvidiaProvider) {
    addIssue(
      issues,
      "intuitive_requires_provider",
      "The Intuitive lane cannot be enabled while its primary provider is disabled.",
    );
  }
  if (flags.intuitiveQuotaUi && !flags.unifiedTextTokensV2) {
    addIssue(
      issues,
      "quota_ui_requires_unified_tokens",
      "The Intuitive quota UI requires unified text-token V2.",
    );
  }
  if (flags.nemotronIntuitive && !flags.unifiedTextTokensV2) {
    addIssue(
      issues,
      "intuitive_requires_unified_tokens",
      "The Intuitive rollout must use the unified text-token ledger.",
    );
  }

  if (activeFlagCount === 0) {
    if (stage !== "off") {
      addIssue(
        warnings,
        "stage_selected_with_flags_dormant",
        "The deployment stage is selected, but every rollout capability remains dormant.",
      );
    }
    if (options.requireEnabled) {
      addIssue(
        issues,
        "rollout_not_enabled",
        "This verification requires at least one rollout capability to be enabled.",
      );
    }
  } else if (stage === "off") {
    addIssue(
      issues,
      "flags_enabled_while_stage_off",
      "Rollout flags cannot be enabled while the deployment stage is off.",
    );
  }

  if (activeFlagCount > 0 && !flagBundleComplete) {
    addIssue(
      warnings,
      "partial_flag_bundle",
      "A dependency-safe partial bundle is active; this is valid for staged canarying or a kill-switch rollback, but not a complete end-to-end rollout.",
    );
  }
  if (options.requireCompleteBundle && !flagBundleComplete) {
    addIssue(
      issues,
      "complete_flag_bundle_required",
      "The complete full rollout requires all four rollout capabilities to be enabled.",
    );
  }

  if (options.expectedStage && stage !== options.expectedStage) {
    addIssue(
      issues,
      "unexpected_rollout_stage",
      `Expected rollout stage ${options.expectedStage}, but the resolved stage is ${stage}.`,
    );
  }

  if (stage === "canary") {
    const canaryId = readString(environment, NEMOTRON_DEPLOYMENT_ENV.canaryDeploymentId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(canaryId)) {
      addIssue(
        issues,
        "invalid_canary_deployment_id",
        "Canary deployments require a non-secret 3–80 character deployment identifier.",
      );
    }
  }

  if (stage === "full") {
    const acknowledgement = readString(environment, NEMOTRON_DEPLOYMENT_ENV.fullRolloutAck);
    if (acknowledgement !== NEMOTRON_FULL_ROLLOUT_ACK) {
      addIssue(
        issues,
        "full_rollout_not_acknowledged",
        "Full rollout requires the explicit full-rollout acknowledgement value.",
      );
    }
    if (providerKeySlots < REQUIRED_FULL_ROLLOUT_NVIDIA_SLOTS) {
      addIssue(
        issues,
        "full_rollout_provider_pool_incomplete",
        `Full rollout requires all ${REQUIRED_FULL_ROLLOUT_NVIDIA_SLOTS} NVIDIA key slots.`,
      );
    }
    if (!pollinationsCredentialConfigured) {
      addIssue(
        issues,
        "full_rollout_fallback_credential_missing",
        "Full rollout requires the server-side Pollinations fallback credential.",
      );
    }
  }

  if (flags.nvidiaProvider) {
    if (providerKeySlots < 1) {
      addIssue(
        issues,
        "provider_key_pool_empty",
        "At least one server-side NVIDIA key slot is required while the provider is enabled.",
      );
    }
    if (!nvidiaBaseUrlPinned) {
      addIssue(
        issues,
        "provider_base_url_not_pinned",
        "The NVIDIA provider must use the approved credential-free HTTPS endpoint.",
      );
    }
    if (!primaryModelPinned) {
      addIssue(
        issues,
        "primary_model_not_pinned",
        "The primary Intuitive model must match the approved free rollout model.",
      );
    }
    if (!pollinationsEndpointPinned) {
      addIssue(
        issues,
        "fallback_endpoint_not_pinned",
        "The last-resort fallback must use the approved Pollinations HTTPS endpoint.",
      );
    }
    if (!freeFallbackPinned) {
      addIssue(
        issues,
        "fallback_model_not_pinned",
        "The last-resort Intuitive fallback must match the approved free model route.",
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 120_000) {
      addIssue(
        issues,
        "invalid_intuitive_timeout",
        "The Intuitive total timeout must be between 30,000 and 120,000 milliseconds.",
      );
    }
    if (
      !Number.isFinite(maximumGeneratedTokens)
      || maximumGeneratedTokens < 1_500
      || maximumGeneratedTokens > 8_000
    ) {
      addIssue(
        issues,
        "invalid_generated_token_ceiling",
        "The NVIDIA generated-token ceiling must remain between 1,500 and 8,000 tokens.",
      );
    }
  }

  if (flags.unifiedTextTokensV2) {
    if (!anonymousIdentitySecretConfigured) {
      addIssue(
        issues,
        "anonymous_identity_secret_missing",
        "Unified guest quotas require a stable anonymous-identity hash secret.",
      );
    }
    if (!controlDatabaseConfigured) {
      addIssue(
        issues,
        "control_database_missing",
        "Unified text-token V2 requires the control database URL and service-role key.",
      );
    }
    if (!pythonQuotaEnforcementDisabled) {
      addIssue(
        issues,
        "legacy_python_quota_enabled",
        "Legacy Python LLM quota enforcement must remain disabled to prevent double accounting.",
      );
    }
  }

  const checks = Object.freeze({
    flagBundleComplete,
    providerKeySlots,
    pollinationsCredentialConfigured,
    nvidiaBaseUrlPinned,
    primaryModelPinned,
    pollinationsEndpointPinned,
    freeFallbackPinned,
    anonymousIdentitySecretConfigured,
    controlDatabaseConfigured,
    timeoutMs,
    maximumGeneratedTokens,
    pythonQuotaEnforcementDisabled,
  });
  const ready = issues.length === 0;
  return Object.freeze({
    ready,
    status: ready ? "ready" : "blocked",
    stage,
    activeFlagCount,
    flags,
    checks,
    issues: Object.freeze(issues),
    warnings: Object.freeze(warnings),
  });
}
