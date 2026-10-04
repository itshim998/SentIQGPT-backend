import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const ROOT_DIR = path.resolve(process.cwd());
const MIGRATION_PATH = path.join(
  ROOT_DIR,
  "supabase",
  "migrations",
  "20261003120000_production_live_voice_architecture.sql"
);
const MIGRATION_VERSION = "20261003120000";

const TARGETS = [
  {
    name: "DB1 (Control)",
    ref: "lzgohufdrqjdupfsvqlj",
    token: process.env.SUPABASE_ACCESS_TOKEN_1 || process.env.SUPABASE_ACCESS_TOKEN,
  },
  {
    name: "DB2 (Data Shard 1)",
    ref: "dyrwqeesibzzfifljklk",
    token: process.env.SUPABASE_ACCESS_TOKEN_2 || process.env.SUPABASE_ACCESS_TOKEN,
  },
  {
    name: "DB3 (Data Shard 2)",
    ref: "fpklxhhsvjbjetkxqajg",
    token: process.env.SUPABASE_ACCESS_TOKEN_3 || process.env.SUPABASE_ACCESS_TOKEN,
  },
];

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
  console.log(`== Applying Migration ${MIGRATION_VERSION} to DB1, DB2, and DB3 ==\n`);
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

  for (const target of TARGETS) {
    console.log(`Checking ${target.name} (${target.ref})...`);
    const existing = await executeSql(
      target.ref,
      target.token,
      `select version from supabase_migrations.schema_migrations where version = '${MIGRATION_VERSION}';`
    );

    if (existing.length > 0) {
      console.log(`  -> Already applied on ${target.name}. Skipping.\n`);
      continue;
    }

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
    console.log(`  -> Successfully applied on ${target.name}.\n`);
  }

  console.log("== Migration complete across all active shards ==");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
