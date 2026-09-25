import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const db1Url = process.env.SUPABASE_URL_1?.trim();
const db1Key = process.env.SUPABASE_SERVICE_ROLE_KEY_1?.trim();

if (!db1Url || !db1Key) {
  console.error("Error: SUPABASE_URL_1 and SUPABASE_SERVICE_ROLE_KEY_1 are required.");
  process.exit(1);
}

const client = createClient(db1Url, db1Key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log("== SentIQ Chat: Control-Plane Cutover Mapping Remediation ==");
  console.log(`Target: DB1 Control (${db1Url})`);

  // 1. Audit current mappings
  const { data: mappings, error: mapErr } = await client
    .from("user_db_map")
    .select("assigned_db");

  if (mapErr) {
    throw new Error(`Failed to query user_db_map: ${mapErr.message}`);
  }

  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const row of mappings || []) {
    counts[row.assigned_db] = (counts[row.assigned_db] || 0) + 1;
  }

  console.log(`Current user_db_map distribution:`);
  console.log(`  Total mapped users: ${mappings?.length || 0}`);
  console.log(`  Logical DB2 (Data Shard 1): ${counts[2]}`);
  console.log(`  Logical DB3 (Data Shard 2): ${counts[3]}`);
  console.log(`  Retired DB4: ${counts[4]}`);

  if (counts[4] !== 0) {
    throw new Error(`Pre-condition failed: retired DB4 mappings must be zero, found ${counts[4]}`);
  }

  // 2. Audit live sessions / leases
  const { data: activeSessions, error: sessErr } = await client
    .from("live_sessions")
    .select("session_id")
    .eq("status", "active");

  if (sessErr) {
    throw new Error(`Failed to query live_sessions: ${sessErr.message}`);
  }

  const { data: activeLeases, error: leaseErr } = await client
    .from("live_capacity_leases")
    .select("session_id,expires_at")
    .gt("expires_at", new Date().toISOString());

  if (leaseErr) {
    throw new Error(`Failed to query live_capacity_leases: ${leaseErr.message}`);
  }

  console.log(`Active live sessions: ${activeSessions?.length || 0}`);
  console.log(`Active live capacity leases: ${activeLeases?.length || 0}`);

  if ((activeSessions?.length || 0) > 0 || (activeLeases?.length || 0) > 0) {
    throw new Error(`Active live sessions or leases exist. Wait for release before remediating.`);
  }

  // 3. Clear stale mappings for shards 2 and 3
  const staleCount = (counts[2] || 0) + (counts[3] || 0);
  console.log(`\nRemoving ${staleCount} stale shard assignments from public.user_db_map...`);
  console.log(`Note: auth.users is completely UNTOUCHED. Existing users remain present.`);

  const { error: delErr } = await client
    .from("user_db_map")
    .delete()
    .in("assigned_db", [2, 3]);

  if (delErr) {
    throw new Error(`Failed to delete stale mappings: ${delErr.message}`);
  }

  // 4. Verify post-deletion state
  const { count: remainingCount, error: verifyErr } = await client
    .from("user_db_map")
    .select("*", { count: "exact", head: true });

  if (verifyErr) {
    throw new Error(`Failed to verify user_db_map: ${verifyErr.message}`);
  }

  console.log(`\nVerification successful:`);
  console.log(`  user_db_map remaining records: ${remainingCount}`);
  console.log(`  Existing Auth users are now free to be assigned to healthy NEW DB2/DB3 on their next request.`);
}

main().catch((err) => {
  console.error("Remediation error:", err.message);
  process.exit(1);
});
