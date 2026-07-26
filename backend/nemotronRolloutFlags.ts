export const NEMOTRON_ROLLOUT_ENV = Object.freeze({
  nvidiaProvider: "SENTIQ_NVIDIA_PROVIDER_ENABLED",
  nemotronIntuitive: "SENTIQ_NEMOTRON_INTUITIVE_ENABLED",
  unifiedTextTokensV2: "SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED",
  intuitiveQuotaUi: "SENTIQ_INTUITIVE_QUOTA_UI_ENABLED",
} as const);

export type NemotronRolloutFlag = keyof typeof NEMOTRON_ROLLOUT_ENV;

function readBooleanEnv(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export function isNemotronRolloutEnabled(flag: NemotronRolloutFlag): boolean {
  return readBooleanEnv(NEMOTRON_ROLLOUT_ENV[flag]);
}

export function getNemotronRolloutSnapshot(): Readonly<Record<NemotronRolloutFlag, boolean>> {
  return Object.freeze({
    nvidiaProvider: isNemotronRolloutEnabled("nvidiaProvider"),
    nemotronIntuitive: isNemotronRolloutEnabled("nemotronIntuitive"),
    unifiedTextTokensV2: isNemotronRolloutEnabled("unifiedTextTokensV2"),
    intuitiveQuotaUi: isNemotronRolloutEnabled("intuitiveQuotaUi"),
  });
}
