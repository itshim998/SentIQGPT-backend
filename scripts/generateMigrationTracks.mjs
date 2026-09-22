import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const ROOT_DIR = path.resolve(process.cwd());
const MIGRATIONS_DIR = path.join(ROOT_DIR, "supabase", "migrations");
const MANIFEST_FILE = path.join(ROOT_DIR, "supabase", "migration-manifest.json");
const TRACKS_DIR = path.join(ROOT_DIR, "supabase", "tracks");
const CONTROL_TRACK_DIR = path.join(TRACKS_DIR, "control", "migrations");
const DATA_TRACK_DIR = path.join(TRACKS_DIR, "data", "migrations");

export const BOTH_VERSIONS = new Set([
  "20260325210100", // ai_saas_schema.sql
  "20260325211000", // session_initialization_functions.sql
  "20260326190000", // atomic_llm_request_quota.sql
  "20260326213000", // fix_multi_db_session_bootstrap.sql
  "20260428120000", // add_user_display_name.sql
  "20260703120000", // add_live_usage_policy.sql
  "20260704120000", // harden_live_session_lifecycle.sql
  "20260710190000", // refund_failed_live_startups.sql
]);

export const CONTROL_ONLY_VERSIONS = new Set([
  "20260325214500", // user_db_map.sql
  "20260412102000", // restrict_user_db_map_assigned_db.sql
  "20260604120000", // billing_plans_usage_and_subscriptions.sql
  "20260629120000", // fix_deep_research_control_scope.sql
  "20260709130000", // control_startup_verification_rpc.sql
  "20260718120000", // standard_lite_token_allowances.sql
  "20260727120000", // unified_text_tokens_v2.sql
  "20260727180000", // unified_text_tokens_v2_integrity.sql
  "20260727183000", // unified_text_tokens_v2_schema_compat.sql
  "20260728100000", // unified_text_tokens_v2_full_rollout_gate.sql
  "20260728180000", // unified_text_tokens_v2_pgcrypto_resolution.sql
  "20260801091500", // plan_tier_image_policy.sql
  "20260809133000", // guest_text_trial_quota.sql
  "20260922120000", // retire_db4_assigned_db.sql
]);

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function generateManifestAndTracks() {
  console.log("== SentIQ Chat: Generating Migration Manifest & Tracks ==");
  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`Found ${migrationFiles.length} canonical migrations in ${MIGRATIONS_DIR}`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    totalCanonicalMigrations: migrationFiles.length,
    topology: {
      controlDatabases: [1],
      dataShards: [2, 3],
      retiredDatabases: [4],
    },
    counts: {
      both: 0,
      controlOnly: 0,
      dataOnly: 0,
      controlTrackTotal: 0,
      dataTrackTotal: 0,
    },
    migrations: [],
  };

  // Ensure target track directories exist and are clean
  fs.mkdirSync(CONTROL_TRACK_DIR, { recursive: true });
  fs.mkdirSync(DATA_TRACK_DIR, { recursive: true });

  for (const existing of fs.readdirSync(CONTROL_TRACK_DIR)) {
    fs.unlinkSync(path.join(CONTROL_TRACK_DIR, existing));
  }
  for (const existing of fs.readdirSync(DATA_TRACK_DIR)) {
    fs.unlinkSync(path.join(DATA_TRACK_DIR, existing));
  }

  for (const file of migrationFiles) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const match = file.match(/^(\d{14})_(.*)\.sql$/);
    if (!match) {
      throw new Error(`Migration file name does not match standard timestamp format: ${file}`);
    }

    const version = match[1];
    const name = match[2];
    const checksum = hashFile(filePath);

    let scope;
    let targetTracks;

    if (BOTH_VERSIONS.has(version)) {
      scope = "BOTH";
      targetTracks = ["control", "data"];
      manifest.counts.both++;
    } else if (CONTROL_ONLY_VERSIONS.has(version)) {
      scope = "CONTROL_ONLY";
      targetTracks = ["control"];
      manifest.counts.controlOnly++;
    } else {
      scope = "DATA_ONLY";
      targetTracks = ["data"];
      manifest.counts.dataOnly++;
    }

    manifest.migrations.push({
      version,
      name,
      filename: file,
      scope,
      targetTracks,
      checksum,
    });

    const content = fs.readFileSync(filePath);
    if (targetTracks.includes("control")) {
      fs.writeFileSync(path.join(CONTROL_TRACK_DIR, file), content);
      manifest.counts.controlTrackTotal++;
    }
    if (targetTracks.includes("data")) {
      fs.writeFileSync(path.join(DATA_TRACK_DIR, file), content);
      manifest.counts.dataTrackTotal++;
    }
  }

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${MANIFEST_FILE}`);
  console.log(`Generated Control Track (${manifest.counts.controlTrackTotal} migrations) at ${CONTROL_TRACK_DIR}`);
  console.log(`Generated Data Track (${manifest.counts.dataTrackTotal} migrations) at ${DATA_TRACK_DIR}`);
  console.log(`Summary: ${manifest.counts.both} BOTH, ${manifest.counts.controlOnly} CONTROL_ONLY, ${manifest.counts.dataOnly} DATA_ONLY.`);

  return manifest;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  generateManifestAndTracks();
}
