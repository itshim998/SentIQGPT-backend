import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const ROOT_DIR = path.resolve(process.cwd());
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");

async function bootstrapShard() {
  const targetDbNumber = process.argv[2] ? parseInt(process.argv[2], 10) : 3;
  console.log(`== SentIQ Chat: Data Shard Bootstrap (Target: DB${targetDbNumber}) ==`);

  if (targetDbNumber !== 2 && targetDbNumber !== 3) {
    console.error(`Error: target must be an active data shard (2 or 3). DB${targetDbNumber} is invalid.`);
    process.exit(1);
  }

  const dbUrl = process.env[`SUPABASE_DB_URL_${targetDbNumber}`] || process.env[`DATABASE_URL_${targetDbNumber}`];
  if (!dbUrl) {
    console.log(`Note: Direct PostgreSQL connection string SUPABASE_DB_URL_${targetDbNumber} / DATABASE_URL_${targetDbNumber} not set in environment.`);
    console.log(`When the recreated DB3 is provisioned in Supabase, obtain its direct connection URI from Dashboard -> Project Settings -> Database -> Connection string (URI) and set SUPABASE_DB_URL_3 in your local .env or run with:`);
    console.log(`  node scripts/bootstrapShard.mjs 3`);
    console.log("\nListing 64 Data Track migrations ready for bootstrap:");
    const files = fs.readdirSync(DATA_TRACK_DIR).filter((f) => f.endsWith(".sql")).sort();
    console.log(`Found ${files.length} migrations in ${DATA_TRACK_DIR}.`);
    files.forEach((f, idx) => console.log(`  [${String(idx + 1).padStart(2, " ")}/64] ${f}`));
    return;
  }

  let pg;
  try {
    pg = await import("pg");
  } catch {
    console.error("Error: 'pg' package is required for direct connection. Run 'npm install pg' or apply migrations using Supabase CLI (supabase db push) or Supabase SQL Editor.");
    process.exit(1);
  }
  const { Client } = pg.default || pg;
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log(`Connected to target PostgreSQL instance for DB${targetDbNumber}.`);

  try {
    // Ensure supabase_migrations schema and table exist
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version character varying(255) NOT NULL PRIMARY KEY,
        inserted_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
      );
    `);

    const files = fs.readdirSync(DATA_TRACK_DIR).filter((f) => f.endsWith(".sql")).sort();
    console.log(`Executing ${files.length} data track migrations in sequence...`);

    for (const file of files) {
      const version = file.slice(0, 14);
      const filePath = path.join(DATA_TRACK_DIR, file);
      const sql = fs.readFileSync(filePath, "utf8");

      const { rows } = await client.query(
        "SELECT version FROM supabase_migrations.schema_migrations WHERE version = $1",
        [version],
      );

      if (rows.length > 0) {
        console.log(`  [SKIP] ${file} (already recorded in schema_migrations)`);
        continue;
      }

      console.log(`  [APPLY] ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1)",
          [version],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`FATAL: Migration failed on ${file}:`, err.message);
        throw err;
      }
    }

    console.log(`\nBootstrap of DB${targetDbNumber} successful! All 64 data migrations applied.`);
  } finally {
    await client.end();
  }
}

bootstrapShard().catch((err) => {
  console.error("Bootstrap error:", err);
  process.exit(1);
});
