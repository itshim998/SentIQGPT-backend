// Offline adapter-to-ledger tests. SQL behavior is executed by testImageEditSql.mjs.
for (const id of [1, 2, 3]) {
  process.env[`SUPABASE_URL_${id}`] ||= "https://example.supabase.co";
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${id}`] ||= "test-key";
}
import assert from "node:assert/strict";
import { BillingRepository } from "./billingRepository";
import { BillingQuotaService } from "./quotaService";
import { getImageModelForPlan } from "./modelEntitlementRouter";

async function main() {
  const calls: { name: string; args: any }[] = [];
  let commitAllowed = true;
  const db: any = {
    rpc: async (name: string, args: any) => {
      calls.push({ name, args });
      if (name === "reserve_image_edit_usage") return { data: { reserved: true, plan_code: "pro", reservation_units: 8, status: "reserved" } };
      if (name === "commit_image_edit_usage") return { data: { committed: commitAllowed } };
      if (name === "release_usage_reservation") return { data: { released: true } };
      throw new Error(`Unexpected ledger RPC ${name}`);
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { metadata: { image_edit: true }, user_id: "user" } }) }) }) }),
  };
  const repository = new BillingRepository(db);
  const billing = new BillingQuotaService(repository);
  const requestId = `image-edit:${"a".repeat(64)}`;
  const reservation = await billing.reserveFeature({
    identity: { userId: "user", isGuest: false, anonymousKeyHash: null }, feature: "image_generation", requestId,
    route: getImageModelForPlan("pro", false), units: 8,
    metadata: { image_edit: true, execution_mode: "intuitive", fingerprint: "b".repeat(64) },
  });
  assert.equal(reservation.status, "reserved"); assert.equal(reservation.reservedUnits, 8);
  assert.equal(calls[0].name, "reserve_image_edit_usage"); assert.equal(calls[0].args.p_units, 8);
  await billing.commit({ ...reservation, model: "microsoft/mai-image-2.6" }, { image_edit: true, actual_image_credits: 8 });
  assert.equal(calls[1].name, "commit_image_edit_usage");
  assert.equal(calls[1].args.p_model, "microsoft/mai-image-2.6"); assert.equal(calls[1].args.p_metadata.actual_image_credits, 8);
  commitAllowed = false;
  await assert.rejects(billing.commit(reservation, { image_edit: true, actual_image_credits: 8 }), /settlement/);
  await billing.releaseImageEditRequest(requestId);
  assert.equal(calls.at(-1)?.name, "release_usage_reservation");
  await assert.rejects(billing.releaseImageEditRequest("generation-request"));
  console.log("PASS: image-edit reservation, actual-model settlement, false-commit rejection and failure-release ledger adapters.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
