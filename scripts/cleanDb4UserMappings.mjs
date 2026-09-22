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
  console.log("== SentIQ Chat: DB4 User Mapping Cleanup ==");
  console.log(`Target: DB1 Control (${db1Url})`);

  const { data: db4Users, error: queryError } = await client
    .from("user_db_map")
    .select("user_id, assigned_db, created_at")
    .eq("assigned_db", 4);

  if (queryError) {
    console.error("Failed to query user_db_map:", queryError.message);
    process.exit(1);
  }

  console.log(`Found ${db4Users.length} user(s) currently mapped to retired DB4:`);
  for (const row of db4Users) {
    console.log(`  - user_id: ${row.user_id} (assigned_db: 4, mapped: ${row.created_at})`);
  }

  if (db4Users.length === 0) {
    console.log("No users mapped to DB4. Nothing to clean up.");
    return;
  }

  console.log("\nDeleting DB4 mappings from public.user_db_map (auth.users is NOT modified)...");
  const { error: deleteError } = await client
    .from("user_db_map")
    .delete()
    .eq("assigned_db", 4);

  if (deleteError) {
    console.error("Failed to delete DB4 mappings:", deleteError.message);
    process.exit(1);
  }

  const { count, error: verifyError } = await client
    .from("user_db_map")
    .select("user_id", { count: "exact", head: true })
    .eq("assigned_db", 4);

  if (verifyError) {
    console.error("Verification query failed:", verifyError.message);
    process.exit(1);
  }

  console.log(`Verification complete: ${count} users remaining mapped to DB4.`);
  console.log("All retired DB4 users will now be dynamically reassigned to active data shards (DB2 or DB3) upon their next session initialization.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
