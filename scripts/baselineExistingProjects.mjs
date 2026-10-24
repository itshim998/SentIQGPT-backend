import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { validateMigrationTracks } from "./validateMigrationTracks.mjs";

dotenv.config();

const ROOT_DIR = path.resolve(process.cwd());
const CONTROL_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "control", "migrations");
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");

export const SCHEMA_VERIFICATION_REQUIREMENTS = {
  1: {
    track: "control",
    name: "Control DB (DB1)",
    requiredTables: ["user_db_map", "live_capacity_leases", "live_sessions"],
    requiredRpc: "verify_sentiq_control_startup",
  },
  2: {
    track: "data",
    name: "Data Shard (DB2)",
    requiredTables: [
      "users",
      "conversations",
      "messages",
      "memories",
      "chat_generations",
      "deep_research_reports",
      "generated_files",
    ],
    requiredRpc: "verify_sentiq_data_shard_startup",
  },
};

/**
 * Smallest safe verification gate compatible with the repository:
 * Checks required tables and executes the built-in startup verifier RPC.
 * Fails closed if any requirement is not met, refusing to baseline.
 */
export async function verifySchemaGate(supabaseClient, dbNumber) {
  const reqs = SCHEMA_VERIFICATION_REQUIREMENTS[dbNumber];
  if (!reqs) {
    throw new Error(`[Baseline Gate] Unknown database number: ${dbNumber}`);
  }

  console.log(`[Baseline Gate] Verifying DB${dbNumber} (${reqs.name}) schema against ${reqs.track} track requirements...`);

  // 1. Table existence checks via Supabase client
  for (const table of reqs.requiredTables) {
    const { error } = await supabaseClient
      .from(table)
      .select("*", { count: "exact", head: true })
      .limit(1);

    if (error) {
      throw new Error(
        `[Baseline Gate] DB${dbNumber} schema does NOT satisfy ${reqs.track} track. Table "${table}" check failed: ${error.message} (code ${error.code}). Refusing to baseline.`
      );
    }
  }
  console.log(`  ✓ Required tables verified: [${reqs.requiredTables.join(", ")}]`);

  // 2. Startup verifier RPC check
  const probeId = crypto.randomUUID();
  if (reqs.requiredRpc === "verify_sentiq_control_startup") {
    const { data: result, error } = await supabaseClient
      .rpc("verify_sentiq_control_startup", { p_probe_user_id: probeId });

    if (error || !result?.ok) {
      const details = error?.message || JSON.stringify(result?.failures || "unknown");
      throw new Error(
        `[Baseline Gate] DB1 startup verification RPC failed: ${details}. Refusing to baseline.`
      );
    }
    console.log(`  ✓ Startup verifier RPC passed: verify_sentiq_control_startup`);
  } else if (reqs.requiredRpc === "verify_sentiq_data_shard_startup") {
    const { data: result, error } = await supabaseClient
      .rpc("verify_sentiq_data_shard_startup", { p_probe_user_id: probeId, p_verify_live: false });

    if (error || !result?.ok) {
      const details = error?.message || JSON.stringify(result?.failures || "unknown");
      throw new Error(
        `[Baseline Gate] DB${dbNumber} startup verification RPC failed: ${details}. Refusing to baseline.`
      );
    }
    console.log(`  ✓ Startup verifier RPC passed: verify_sentiq_data_shard_startup`);
  }

  console.log(`[Baseline Gate] DB${dbNumber} schema satisfies ${reqs.track} track! Safe to baseline.`);
  return true;
}

export function generateHardenedBaselineSql(dbNumber, versions) {
  const reqs = SCHEMA_VERIFICATION_REQUIREMENTS[dbNumber];
  const tableList = reqs.requiredTables.map((t) => `'${t}'`).join(", ");
  const versionList = versions.map((v) => `    ('${v}')`).join(",\n");

  return `
-- ============================================================================
-- SentIQ Chat Hardened Baseline Script for DB${dbNumber} (${reqs.name})
-- Validates schema requirements before marking ${versions.length} migrations as applied.
-- Uses native supabase_migrations.schema_migrations for Supabase CLI / db push parity.
-- ============================================================================

DO $$
DECLARE
  v_missing_tables text;
  v_rpc_result jsonb;
  v_probe_id uuid := gen_random_uuid();
BEGIN
  -- 1. Table Verification Gate
  SELECT string_agg(t, ', ') INTO v_missing_tables
  FROM unnest(ARRAY[${tableList}]) AS t
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = t
  );

  IF v_missing_tables IS NOT NULL THEN
    RAISE EXCEPTION '[Baseline Gate] DB${dbNumber} schema does NOT satisfy ${reqs.track} track. Missing tables: %. Refusing to baseline.', v_missing_tables;
  END IF;

  -- 2. Startup Verifier RPC Gate
  ${
    dbNumber === 1
      ? `SELECT public.verify_sentiq_control_startup(v_probe_id) INTO v_rpc_result;
  IF NOT (v_rpc_result->>'ok')::boolean THEN
    RAISE EXCEPTION '[Baseline Gate] DB1 startup verification RPC failed: %. Refusing to baseline.', v_rpc_result->>'failures';
  END IF;`
      : `SELECT public.verify_sentiq_data_shard_startup(v_probe_id, false) INTO v_rpc_result;
  IF NOT (v_rpc_result->>'ok')::boolean THEN
    RAISE EXCEPTION '[Baseline Gate] DB${dbNumber} startup verification RPC failed: %. Refusing to baseline.', v_rpc_result->>'failures';
  END IF;`
  }

  -- 3. Native Supabase Schema Migrations Table
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
    version character varying(255) NOT NULL PRIMARY KEY,
    inserted_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
  );

  -- 4. Mark Track Migrations as Applied
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES
${versionList}
  ON CONFLICT (version) DO NOTHING;

  RAISE NOTICE '[Baseline Gate] DB${dbNumber} verified and baselined successfully with % migrations.', ${versions.length};
END $$;
`;
}

async function baselineProject(dbNumber, trackDir) {
  const reqs = SCHEMA_VERIFICATION_REQUIREMENTS[dbNumber];
  const files = fs.readdirSync(trackDir).filter((f) => f.endsWith(".sql")).sort();
  const versions = files.map((f) => f.slice(0, 14));

  const expectedVersions = validateMigrationTracks(ROOT_DIR).tracks[reqs.track].map((entry) => entry.version);
  if (JSON.stringify(versions) !== JSON.stringify(expectedVersions)) {
    throw new Error(
      `[Baseline Gate] Track files differ from the validated ${reqs.track} manifest.`
    );
  }

  console.log(`\n==================================================================`);
  console.log(`BASELINE PROCESS: DB${dbNumber} (${reqs.name} - ${versions.length} migrations)`);
  console.log(`==================================================================`);

  const supabaseUrl = process.env[`SUPABASE_URL_${dbNumber}`]?.trim();
  const serviceKey = process.env[`SUPABASE_SERVICE_ROLE_KEY_${dbNumber}`]?.trim();

  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      `[Baseline Gate] Missing SUPABASE_URL_${dbNumber} or SUPABASE_SERVICE_ROLE_KEY_${dbNumber} in environment.`
    );
  }

  const supabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Execute verification gate
  await verifySchemaGate(supabaseClient, dbNumber);

  // Print native Supabase CLI repair commands
  console.log(`\n[Native Supabase CLI Repair Commands]`);
  console.log(`To record these ${versions.length} migrations using Supabase CLI (native migration repair):`);
  console.log(`  supabase migration repair --status applied ${versions.join(" ")}\n`);

  // Direct PostgreSQL execution if DB URL is provided and pg package is present
  const dbUrl = process.env[`SUPABASE_DB_URL_${dbNumber}`] || process.env[`DATABASE_URL_${dbNumber}`];
  if (dbUrl) {
    try {
      const pgModule = await import("pg");
      const { Client } = pgModule.default || pgModule;
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
        const { rows } = await client.query("SELECT count(*) FROM supabase_migrations.schema_migrations");
        console.log(`✓ Direct DB${dbNumber} connection: baselined successfully! Total versions in schema_migrations: ${rows[0].count}`);
      } finally {
        await client.end();
      }
      return;
    } catch (err) {
      console.log(`Note: Direct PostgreSQL insertion skipped (${err.message}).`);
    }
  }

  console.log(`[Supabase SQL Editor Script]`);
  console.log(`To record these migrations in the Supabase Dashboard, copy and execute this verified script:`);
  console.log(generateHardenedBaselineSql(dbNumber, versions));
}

export async function main() {
  console.log("== SentIQ Chat: Hardened Baseline for Existing Projects ==");
  await baselineProject(1, CONTROL_TRACK_DIR);
  await baselineProject(2, DATA_TRACK_DIR);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  main().catch((err) => {
    console.error("Baseline error:", err.message);
    process.exit(1);
  });
}
