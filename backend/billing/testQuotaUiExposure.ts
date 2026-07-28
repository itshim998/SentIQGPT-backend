import assert from "node:assert/strict";

async function main(): Promise<void> {
  for (const id of [1, 2, 3, 4]) {
    process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
    process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-service-role-key";
  }

  const originalUnified = process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED;
  const originalUi = process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED;
  const { isIntuitiveQuotaUiPubliclyEnabled } = await import("./billingRoutes");

  try {
    process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "false";
    process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED = "false";
    assert.equal(isIntuitiveQuotaUiPubliclyEnabled(), false);

    process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
    process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED = "false";
    assert.equal(isIntuitiveQuotaUiPubliclyEnabled(), false);

    process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "false";
    process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED = "true";
    assert.equal(isIntuitiveQuotaUiPubliclyEnabled(), false);

    process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = "true";
    process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED = "true";
    assert.equal(isIntuitiveQuotaUiPubliclyEnabled(), true);
  } finally {
    if (originalUnified === undefined) delete process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED;
    else process.env.SENTIQ_UNIFIED_TEXT_TOKENS_V2_ENABLED = originalUnified;
    if (originalUi === undefined) delete process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED;
    else process.env.SENTIQ_INTUITIVE_QUOTA_UI_ENABLED = originalUi;
  }

  console.log("Quota UI exposure contract checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
