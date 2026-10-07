import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const ROOT_DIR = path.resolve(process.cwd());
const MIGRATION_PATH = path.join(
  ROOT_DIR,
  "supabase",
  "migrations",
  "20261007180000_weighted_image_credits_and_revised_tiers.sql"
);
const MIGRATION_VERSION = "20261007180000";

const target = {
  name: "DB1 (Control)",
  ref: "lzgohufdrqjdupfsvqlj",
  token: process.env.SUPABASE_ACCESS_TOKEN_1 || process.env.SUPABASE_ACCESS_TOKEN,
};

async function executeSql(ref, token, query) {
  const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase API query failed (${response.status}): ${errorText}`);
  }
  return response.json();
}

async function main() {
  console.log(`== Applying Migration ${MIGRATION_VERSION} to DB1 (Control) ==\n`);
  if (!target.token) {
    throw new Error("SUPABASE_ACCESS_TOKEN_1 is not defined in environment.");
  }
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

  console.log(`Checking ${target.name} (${target.ref})...`);
  const existing = await executeSql(
    target.ref,
    target.token,
    `select version from supabase_migrations.schema_migrations where version = '${MIGRATION_VERSION}';`
  );

  if (existing.length > 0) {
    console.log(`  -> Already recorded in schema_migrations on ${target.name}.`);
  } else {
    console.log(`  -> Executing migration on ${target.name}...`);
    await executeSql(target.ref, target.token, sql);

    console.log(`  -> Recording version in schema_migrations...`);
    const cols = await executeSql(
      target.ref,
      target.token,
      `select column_name from information_schema.columns where table_schema = 'supabase_migrations' and table_name = 'schema_migrations';`
    );
    const hasInsertedAt = cols.some((c) => c.column_name === "inserted_at");
    const insertQuery = hasInsertedAt
      ? `insert into supabase_migrations.schema_migrations (version, inserted_at) values ('${MIGRATION_VERSION}', timezone('utc'::text, now())) on conflict (version) do nothing;`
      : `insert into supabase_migrations.schema_migrations (version) values ('${MIGRATION_VERSION}') on conflict (version) do nothing;`;
    await executeSql(target.ref, target.token, insertQuery);
    console.log(`  -> Successfully recorded on ${target.name}.\n`);
  }

  // Verify the updated billing plans on DB1
  console.log("Verifying public.billing_plans on DB1:");
  const plans = await executeSql(
    target.ref,
    target.token,
    `select code, price_paise, entitlements->'quotas'->'image_generation' as image_quota from public.billing_plans order by sort_order;`
  );
  console.log(JSON.stringify(plans, null, 2));
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
