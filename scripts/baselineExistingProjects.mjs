import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Client } = pg;
const ROOT_DIR = path.resolve(process.cwd());
const CONTROL_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "control", "migrations");
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");

async function baselineProject(dbNumber, trackDir, trackName) {
  const files = fs.readdirSync(trackDir).filter((f) => f.endsWith(".sql")).sort();
  const versions = files.map((f) => f.slice(0, 14));

  console.log(`\n--- Baseline for DB${dbNumber} (${trackName} track: ${versions.length} migrations) ---`);

  const dbUrl = process.env[`SUPABASE_DB_URL_${dbNumber}`] || process.env[`DATABASE_URL_${dbNumber}`];
  if (!dbUrl) {
    console.log(`Connection string SUPABASE_DB_URL_${dbNumber} not set in .env.`);
    console.log(`Generated SQL to baseline DB${dbNumber} via Supabase SQL Editor:`);
    console.log(`
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version character varying(255) NOT NULL PRIMARY KEY,
  inserted_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

INSERT INTO supabase_migrations.schema_migrations (version) VALUES
${versions.map((v) => `  ('${v}')`).join(",\n")}
ON CONFLICT (version) DO NOTHING;
    `);
    return;
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
        version character varying(255) NOT NULL PRIMARY KEY,
        inserted_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
      );
    `);

    const insertSql = `
      INSERT INTO supabase_migrations.schema_migrations (version) VALUES
      ${versions.map((v) => `('${v}')`).join(", ")}
      ON CONFLICT (version) DO NOTHING;
    `;
    await client.query(insertSql);

    const { rows } = await client.query(
      "SELECT count(*) FROM supabase_migrations.schema_migrations"
    );
    console.log(`DB${dbNumber} baselined successfully! Total recorded versions: ${rows[0].count}`);
  } finally {
    await client.end();
  }
}

async function main() {
  console.log("== SentIQ Chat: Baseline Existing Projects Migration Tracking ==");
  await baselineProject(1, CONTROL_TRACK_DIR, "Control (DB1)");
  await baselineProject(2, DATA_TRACK_DIR, "Data Shard (DB2)");
}

main().catch((err) => {
  console.error("Baseline error:", err);
  process.exit(1);
});
