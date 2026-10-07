import dotenv from "dotenv";
dotenv.config();

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const db1Url = process.env.SUPABASE_URL_1?.trim();
const db1Key = process.env.SUPABASE_SERVICE_ROLE_KEY_1?.trim();

if (!db1Url || !db1Key) {
  console.error("Missing SUPABASE_URL_1 or SUPABASE_SERVICE_ROLE_KEY_1 for Database 1 integration test.");
  process.exit(1);
}

const db: SupabaseClient = createClient(db1Url, db1Key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function runDatabase1IntegrationTests(): Promise<void> {
  console.log("=== Running Database 1 Weighted Image Credits Integration Test ===\n");

  // Track created request IDs and user IDs for guaranteed cleanup
  const cleanupRequestIds: string[] = [];
  const cleanupUserIds: string[] = [];

  try {
    // 1. Verify billing plans on DB1 have authoritative quotas and 'credits' unit
    console.log("1. Verifying Database 1 billing_plans schema and quotas...");
    const { data: plans, error: plansError } = await db
      .from("billing_plans")
      .select("code, price_paise, entitlements")
      .order("sort_order", { ascending: true });

    assert.ifError(plansError);
    assert(Array.isArray(plans) && plans.length >= 4, "Must have at least 4 plans");

    const planMap = new Map(plans.map((p) => [p.code, p]));
    assert.equal(planMap.get("free")?.price_paise, 0);
    assert.equal(planMap.get("student_core")?.price_paise, 12_900);
    assert.equal(planMap.get("premium")?.price_paise, 29_900);
    assert.equal(planMap.get("pro")?.price_paise, 69_900);

    for (const [code, expectedLimit] of [
      ["free", 2],
      ["student_core", 12],
      ["premium", 20],
      ["pro", 32],
    ] as const) {
      const quota = planMap.get(code)?.entitlements?.quotas?.image_generation;
      assert(quota, `Plan ${code} must have image_generation quota`);
      assert.equal(quota.limit, expectedLimit, `Plan ${code} limit must be ${expectedLimit}`);
      assert.equal(quota.unit, "credits", `Plan ${code} unit must be credits`);
      assert.equal(quota.label, "Image credits", `Plan ${code} label must be Image credits`);
    }
    console.log("   ✓ Database 1 plans and credit quotas verified.\n");

    // 2. Scenario A: Reserve 2 credits -> Schnell succeeds (1 credit) -> Settle 1, Release 1
    console.log("2. Testing Reservation & Partial Settlement (Reserve 2 -> Settle 1 -> Release 1)...");
    const testUserId1 = randomUUID();
    cleanupUserIds.push(testUserId1);
    const reqId1 = `test:img:integration:${randomUUID()}`;
    cleanupRequestIds.push(reqId1);

    const { data: reserve1, error: resErr1 } = await db.rpc("reserve_usage", {
      p_user_id: testUserId1,
      p_anonymous_key_hash: null,
      p_feature: "image_generation",
      p_units: 2,
      p_request_id: reqId1,
      p_metadata: { execution_mode: "fast", test: true },
    });
    assert.ifError(resErr1);
    assert.equal(reserve1.reserved, true, "Reservation 1 must succeed");
    assert.equal(reserve1.reserved_units, 2, "Must reserve 2 units");

    const { data: commit1, error: comErr1 } = await db.rpc("commit_usage_reservation", {
      p_request_id: reqId1,
      p_provider: "@cf/black-forest-labs/flux-1-schnell",
      p_model: "@cf/black-forest-labs/flux-1-schnell",
      p_route: "image_generation",
      p_metadata: { actual_image_credits: 1 },
    });
    assert.ifError(comErr1);
    assert.equal(commit1.committed, true, "Commit 1 must succeed");
    assert.equal(commit1.idempotent, false, "First commit is not idempotent replay");
    assert.equal(commit1.settled_units, 1, "Must settle exactly 1 credit for Schnell");
    assert.equal(commit1.released_units, 1, "Must release exactly 1 unused credit");
    console.log("   ✓ Reserve 2 -> Settle 1 -> Release 1 verified.\n");

    // 3. Scenario B: Idempotency (Replay commit on reqId1)
    console.log("3. Testing Idempotent Commit Replay...");
    const { data: replay1, error: repErr1 } = await db.rpc("commit_usage_reservation", {
      p_request_id: reqId1,
      p_provider: "@cf/black-forest-labs/flux-1-schnell",
      p_model: "@cf/black-forest-labs/flux-1-schnell",
      p_route: "image_generation",
      p_metadata: { actual_image_credits: 1 },
    });
    assert.ifError(repErr1);
    assert.equal(replay1.committed, true, "Replay commit must succeed");
    assert.equal(replay1.idempotent, true, "Replay commit must be flagged idempotent");
    assert.equal(replay1.settled_units, 1, "Settled units remains 1");
    console.log("   ✓ Idempotent replay safely returned without double-charge.\n");

    // 4. Scenario C: Reserve 2 credits -> Klein 4B succeeds (2 credits) -> Settle 2, Release 0
    console.log("4. Testing Reservation & Full Settlement (Reserve 2 -> Settle 2 -> Release 0)...");
    const testUserId2 = randomUUID();
    cleanupUserIds.push(testUserId2);
    const reqId2 = `test:img:integration:${randomUUID()}`;
    cleanupRequestIds.push(reqId2);

    const { data: reserve2, error: resErr2 } = await db.rpc("reserve_usage", {
      p_user_id: testUserId2,
      p_anonymous_key_hash: null,
      p_feature: "image_generation",
      p_units: 2,
      p_request_id: reqId2,
      p_metadata: { execution_mode: "intuitive", test: true },
    });
    assert.ifError(resErr2);
    assert.equal(reserve2.reserved, true);
    assert.equal(reserve2.reserved_units, 2);

    const { data: commit2, error: comErr2 } = await db.rpc("commit_usage_reservation", {
      p_request_id: reqId2,
      p_provider: "@cf/black-forest-labs/flux-2-klein-4b",
      p_model: "@cf/black-forest-labs/flux-2-klein-4b",
      p_route: "image_generation",
      p_metadata: { actual_image_credits: 2 },
    });
    assert.ifError(comErr2);
    assert.equal(commit2.committed, true);
    assert.equal(commit2.settled_units, 2, "Must settle 2 credits for Klein 4B");
    assert.equal(commit2.released_units, 0, "0 credits released when full reservation consumed");
    console.log("   ✓ Reserve 2 -> Settle 2 -> Release 0 verified.\n");

    // 5. Scenario D: Failure / Release (Reserve 2 -> Release -> 0 charged)
    console.log("5. Testing Provider Failure & Complete Release (Reserve 2 -> Release -> 0 charged)...");
    const testUserId3 = randomUUID();
    cleanupUserIds.push(testUserId3);
    const reqId3 = `test:img:integration:${randomUUID()}`;
    cleanupRequestIds.push(reqId3);

    const { data: reserve3, error: resErr3 } = await db.rpc("reserve_usage", {
      p_user_id: testUserId3,
      p_anonymous_key_hash: null,
      p_feature: "image_generation",
      p_units: 2,
      p_request_id: reqId3,
      p_metadata: { execution_mode: "fast", test: true },
    });
    assert.ifError(resErr3);
    assert.equal(reserve3.reserved, true);
    assert.equal(reserve3.reserved_units, 2);

    const { data: release3, error: relErr3 } = await db.rpc("release_usage_reservation", {
      p_request_id: reqId3,
    });
    assert.ifError(relErr3);
    assert.equal(release3.released, true, "Reservation 3 must be successfully released");

    // Verify no usage_events row was recorded for reqId3
    const { data: events3, error: evErr3 } = await db
      .from("usage_events")
      .select("id")
      .eq("request_id", reqId3);
    assert.ifError(evErr3);
    assert.equal(events3.length, 0, "No usage events must be charged on failure release");
    console.log("   ✓ Failure release recorded zero usage events (0 credits charged).\n");

    // 6. Scenario E: Pro Tier Reservation (Reserve 8 on Pro -> Settle 8)
    console.log("6. Testing Pro Tier Reservation & Settlement (Reserve 8 -> Settle 8 on Pro)...");
    const testProUserId = randomUUID();
    cleanupUserIds.push(testProUserId);

    // Setup manual pro profile
    await db.from("user_billing_profiles").insert({
      user_id: testProUserId,
      current_plan_code: "pro",
      effective_status: "manual",
    });

    const reqId4 = `test:img:integration:${randomUUID()}`;
    cleanupRequestIds.push(reqId4);

    const { data: reserve4, error: resErr4 } = await db.rpc("reserve_usage", {
      p_user_id: testProUserId,
      p_anonymous_key_hash: null,
      p_feature: "image_generation",
      p_units: 8,
      p_request_id: reqId4,
      p_metadata: { execution_mode: "intuitive", test: true },
    });
    assert.ifError(resErr4);
    assert.equal(reserve4.reserved, true, "Pro reservation of 8 credits must succeed");
    assert.equal(reserve4.plan_code, "pro");
    assert.equal(reserve4.reserved_units, 8);

    const { data: commit4, error: comErr4 } = await db.rpc("commit_usage_reservation", {
      p_request_id: reqId4,
      p_provider: "openai/gpt-image-2",
      p_model: "openai/gpt-image-2",
      p_route: "image_generation",
      p_metadata: { actual_image_credits: 8 },
    });
    assert.ifError(comErr4);
    assert.equal(commit4.committed, true);
    assert.equal(commit4.settled_units, 8, "Must settle 8 credits for Pollinations Pro");
    assert.equal(commit4.released_units, 0);
    console.log("   ✓ Pro tier Reserve 8 -> Settle 8 verified.\n");

    // 7. Verify get_effective_plan RPC
    console.log("7. Testing Authoritative get_effective_plan RPC on DB1...");
    const { data: effectivePlan, error: effErr } = await db.rpc("get_effective_plan", {
      p_user_id: testUserId1,
    });
    assert.ifError(effErr);
    const planRow = Array.isArray(effectivePlan) ? effectivePlan[0] : effectivePlan;
    assert.equal(planRow?.plan_code, "free", "New synthetic user has effective plan 'free'");

    const { data: proEffectivePlan, error: proEffErr } = await db.rpc("get_effective_plan", {
      p_user_id: testProUserId,
    });
    assert.ifError(proEffErr);
    const proPlanRow = Array.isArray(proEffectivePlan) ? proEffectivePlan[0] : proEffectivePlan;
    assert.equal(proPlanRow?.plan_code, "pro", "Pro synthetic user has effective plan 'pro'");
    console.log("   ✓ get_effective_plan RPC verified for both Free and Pro.\n");

  } finally {
    // 8. Cleanup
    console.log("8. Cleaning up test data from Database 1...");
    if (cleanupRequestIds.length > 0) {
      await db.from("usage_events").delete().in("request_id", cleanupRequestIds);
      await db.from("quota_reservations").delete().in("request_id", cleanupRequestIds);
    }
    if (cleanupUserIds.length > 0) {
      await db.from("user_billing_profiles").delete().in("user_id", cleanupUserIds);
    }
    console.log(`   ✓ Cleaned up test reservation, usage, and billing profile records.\n`);
  }

  console.log("=========================================================================");
  console.log("ALL REAL DATABASE 1 INTEGRATION TESTS PASSED SUCCESSFULLY!");
  console.log("=========================================================================\n");
}

runDatabase1IntegrationTests().catch((err) => {
  console.error("Database 1 integration test failed:", err);
  process.exit(1);
});
