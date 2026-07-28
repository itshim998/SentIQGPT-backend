export const NEMOTRON_ROLLOUT_ENV = Object.freeze({
  nvidiaProvider: "SENTIQ_NVIDIA_PROVIDER_ENABLED",
  nemotronIntuitive: "SENTIQ_NEMOTRON_INTUITIVE_ENABLED",
  unifiedTextTokensV2: "SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED",
  intuitiveQuotaUi: "SENTIQ_INTUITIVE_QUOTA_UI_ENABLED",
} as const);

export type NemotronRolloutFlag = keyof typeof NEMOTRON_ROLLOUT_ENV;
export type NemotronRolloutEnvironment = Readonly<Record<string, string | undefined>>;

function readBooleanEnv(name: string, environment: NemotronRolloutEnvironment): boolean {
  const raw = environment[name];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function isNemotronRolloutEnabled(
  flag: NemotronRolloutFlag,
  environment: NemotronRolloutEnvironment = process.env,
): boolean {
  return readBooleanEnv(NEMOTRON_ROLLOUT_ENV[flag], environment);
}

export function getNemotronRolloutSnapshot(
  environment: NemotronRolloutEnvironment = process.env,
): Readonly<Record<NemotronRolloutFlag, boolean>> {
  return Object.freeze({
    nvidiaProvider: isNemotronRolloutEnabled("nvidiaProvider", environment),
    nemotronIntuitive: isNemotronRolloutEnabled("nemotronIntuitive", environment),
    unifiedTextTokensV2: isNemotronRolloutEnabled("unifiedTextTokensV2", environment),
    intuitiveQuotaUi: isNemotronRolloutEnabled("intuitiveQuotaUi", environment),
  });
}
