import assert from "node:assert/strict";
import {
  NEMOTRON_ROLLOUT_ENV,
  getNemotronRolloutSnapshot,
  isNemotronRolloutEnabled,
  type NemotronRolloutFlag,
} from "./nemotronRolloutFlags";

const originalValues = Object.fromEntries(
  Object.values(NEMOTRON_ROLLOUT_ENV).map((name) => [name, process.env[name]]),
) as Record<string, string | undefined>;

function clearFlags(): void {
  for (const name of Object.values(NEMOTRON_ROLLOUT_ENV)) delete process.env[name];
}

function restoreFlags(): void {
  for (const [name, value] of Object.entries(originalValues)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

try {
  clearFlags();
  assert.deepEqual(getNemotronRolloutSnapshot(), {
    nvidiaProvider: false,
    nemotronIntuitive: false,
    unifiedTextTokensV2: false,
    intuitiveQuotaUi: false,
  });

  const flags = Object.keys(NEMOTRON_ROLLOUT_ENV) as NemotronRolloutFlag[];
  for (const enabledFlag of flags) {
    clearFlags();
    process.env[NEMOTRON_ROLLOUT_ENV[enabledFlag]] = "true";

    for (const observedFlag of flags) {
      assert.equal(
        isNemotronRolloutEnabled(observedFlag),
        observedFlag === enabledFlag,
        `${enabledFlag} must not implicitly enable ${observedFlag}`,
      );
    }
  }

  clearFlags();
  process.env[NEMOTRON_ROLLOUT_ENV.nvidiaProvider] = "1";
  process.env[NEMOTRON_ROLLOUT_ENV.nemotronIntuitive] = "yes";
  process.env[NEMOTRON_ROLLOUT_ENV.unifiedTextTokensV2] = "on";
  process.env[NEMOTRON_ROLLOUT_ENV.intuitiveQuotaUi] = "TRUE";
  assert.deepEqual(getNemotronRolloutSnapshot(), {
    nvidiaProvider: true,
    nemotronIntuitive: true,
    unifiedTextTokensV2: true,
    intuitiveQuotaUi: true,
  });

  console.log("Nemotron rollout flag tests passed.");
} finally {
  restoreFlags();
}
