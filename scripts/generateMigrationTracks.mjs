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
  "20261003120000", // production_live_voice_architecture.sql
]);

export const CONTROL_ONLY_VERSIONS = new Set([
  "20261024120000", // paid_image_edit_ledger.sql
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
  "20261007180000", // weighted_image_credits_and_revised_tiers.sql
]);

export const DATA_ONLY_VERSIONS = new Set([
  "20261024121000", // image_edit_versions.sql
  "20260330194000", // add_memory_scope_and_chat_id.sql
  "20260406160000", // capacity_limits.sql
  "20260407030000", // chat_images_table.sql
  "20260412090000", // incremental_memory_usage_tracking.sql
  "20260412101000", // fix_memory_limit_concurrency.sql
  "20260428153000", // add_message_client_request_id.sql
  "20260502113000", // add_image_message_metadata_columns.sql
  "20260504120000", // add_memory_embeddings.sql
  "20260506120000", // serialize_conversation_limit.sql
  "20260512120000", // add_generated_files.sql
  "20260513120000", // private_generated_files.sql
  "20260517120000", // add_assistant_text_client_request_id_unique.sql
  "20260519120000", // conversation_canonicalization.sql
  "20260522120000", // atomic_image_generation_quota.sql
  "20260522130000", // memory_maintenance.sql
  "20260522140000", // list_user_conversations.sql
  "20260528120000", // conversation_last_activity.sql
  "20260628140000", // add_deep_research_reports.sql
  "20260702120000", // add_context_capsules.sql
  "20260702160000", // add_source_document_retrieval.sql
  "20260709131000", // data_shard_startup_verification_rpc.sql
  "20260715120000", // automatic_memory_idempotency.sql
  "20260804180700", // add_fast_context_snapshot.sql
  "20260805043000", // harden_long_pdf_ingestion.sql
  "20260805095900", // defer_phase5_document_map_backfill.sql
  "20260805100000", // strengthen_source_fts_retrieval.sql
  "20260805100100", // harden_phase5_document_maps.sql
  "20260805100200", // fix_phase5_ready_trigger.sql
  "20260805100250", // prepare_phase5_safe_backfill.sql
  "20260805100300", // fix_phase5_map_ambiguity.sql
  "20260805100400", // fix_phase5_search_rpc_ambiguity.sql
  "20260805100500", // fix_phase5_ready_trigger_recursion.sql
  "20260805100600", // fix_phase5_sentence_regex.sql
  "20260805145950", // prepare_memory_pgcrypto_resolution.sql
  "20260805150000", // improve_memory_hybrid_retrieval.sql
  "20260805150025", // infer_memory_project_scope.sql
  "20260805150050", // guard_direct_memory_writes.sql
  "20260805150100", // upgrade_fast_memory_snapshot.sql
  "20260805215950", // prepare_continuity_search_vector.sql
  "20260805220000", // add_cross_conversation_continuity.sql
  "20260805220050", // maintain_continuity_search_vector.sql
  "20260805220100", // upgrade_fast_cross_conversation_snapshot.sql
  "20260805220150", // preserve_fast_snapshot_contract.sql
  "20260809123000", // conversation_user_activity_ordering.sql
  "20260816150000", // add_chat_generations.sql
  "20260816162000", // add_generation_execution_snapshot.sql
  "20260817080000", // add_generation_sessions.sql
  "20260817090000", // add_generation_execution_leases.sql
  "20260817092000", // add_generation_session_reload_grace.sql
  "20260817093000", // add_generation_session_request_claims.sql
  "20260817094000", // reuse_generation_session_on_reload.sql
  "20260817095000", // fix_generation_session_reload_reuse_scope.sql
  "20260817101000", // add_generation_event_types_and_concurrency.sql
  "20260817113000", // harden_generation_p0_controls.sql
  "20260817123000", // durable_generation_event_log.sql
  "20260817140000", // durable_guest_generations.sql
  "20261001120000", // add_visual_assets.sql
  "20261010120000", // update_guest_generation_claim_concurrency.sql
  "20261017120000", // fix_generation_lease_serialization_retry_loop.sql
]);

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function classifyMigrationVersion(version, filename = "") {
  let inBoth = BOTH_VERSIONS.has(version);
  let inControl = CONTROL_ONLY_VERSIONS.has(version);
  let inData = DATA_ONLY_VERSIONS.has(version);

  const matchedCategories = (inBoth ? 1 : 0) + (inControl ? 1 : 0) + (inData ? 1 : 0);
  if (matchedCategories > 1) {
    throw new Error(
      `[generateMigrationTracks] Ambiguous classification: version ${version} (${filename}) is defined in multiple classification sets.`
    );
  }

  if (inBoth) {
    return { scope: "BOTH", targetTracks: ["control", "data"] };
  }
  if (inControl) {
    return { scope: "CONTROL_ONLY", targetTracks: ["control"] };
  }
  if (inData) {
    return { scope: "DATA_ONLY", targetTracks: ["data"] };
  }

  // Fail-closed: Never default to DATA_ONLY or any other scope
  throw new Error(
    `[generateMigrationTracks] Unclassified migration detected: "${filename || version}" (version ${version}). ` +
    `Every canonical migration must be explicitly classified as BOTH, CONTROL_ONLY, or DATA_ONLY. Failing closed.`
  );
}

export function generateManifestAndTracks(options = {}) {
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
  const manifestFile = options.manifestFile || MANIFEST_FILE;
  const controlTrackDir = options.controlTrackDir || CONTROL_TRACK_DIR;
  const dataTrackDir = options.dataTrackDir || DATA_TRACK_DIR;

  console.log("== SentIQ Chat: Generating Migration Manifest & Tracks ==");
  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  console.log(`Found ${migrationFiles.length} canonical migrations in ${migrationsDir}`);

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
  fs.mkdirSync(controlTrackDir, { recursive: true });
  fs.mkdirSync(dataTrackDir, { recursive: true });

  const controlSbMigrationsDir = path.join(TRACKS_DIR, "control", "supabase", "migrations");
  const dataSbMigrationsDir = path.join(TRACKS_DIR, "data", "supabase", "migrations");
  fs.mkdirSync(controlSbMigrationsDir, { recursive: true });
  fs.mkdirSync(dataSbMigrationsDir, { recursive: true });

  fs.writeFileSync(
    path.join(TRACKS_DIR, "control", "supabase", "config.toml"),
    'project_id = "sentiq-control"\n[db]\nmajor_version = 15\n'
  );
  fs.writeFileSync(
    path.join(TRACKS_DIR, "data", "supabase", "config.toml"),
    'project_id = "sentiq-data-shard"\n[db]\nmajor_version = 15\n'
  );

  for (const existing of fs.readdirSync(controlTrackDir)) {
    fs.unlinkSync(path.join(controlTrackDir, existing));
  }
  for (const existing of fs.readdirSync(dataTrackDir)) {
    fs.unlinkSync(path.join(dataTrackDir, existing));
  }
  for (const existing of fs.readdirSync(controlSbMigrationsDir)) {
    fs.unlinkSync(path.join(controlSbMigrationsDir, existing));
  }
  for (const existing of fs.readdirSync(dataSbMigrationsDir)) {
    fs.unlinkSync(path.join(dataSbMigrationsDir, existing));
  }

  for (const file of migrationFiles) {
    const filePath = path.join(migrationsDir, file);
    const match = file.match(/^(\d{14})_(.*)\.sql$/);
    if (!match) {
      throw new Error(`Migration file name does not match standard timestamp format: ${file}`);
    }

    const version = match[1];
    const name = match[2];
    const checksum = hashFile(filePath);

    // Fail-closed classification
    const { scope, targetTracks } = classifyMigrationVersion(version, file);

    if (scope === "BOTH") {
      manifest.counts.both++;
    } else if (scope === "CONTROL_ONLY") {
      manifest.counts.controlOnly++;
    } else if (scope === "DATA_ONLY") {
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
      fs.writeFileSync(path.join(controlTrackDir, file), content);
      fs.writeFileSync(path.join(controlSbMigrationsDir, file), content);
      manifest.counts.controlTrackTotal++;
    }
    if (targetTracks.includes("data")) {
      fs.writeFileSync(path.join(dataTrackDir, file), content);
      fs.writeFileSync(path.join(dataSbMigrationsDir, file), content);
      manifest.counts.dataTrackTotal++;
    }
  }

  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${manifestFile}`);
  console.log(`Generated Control Track (${manifest.counts.controlTrackTotal} migrations) at ${controlTrackDir}`);
  console.log(`Generated Data Track (${manifest.counts.dataTrackTotal} migrations) at ${dataTrackDir}`);
  console.log(`Summary: ${manifest.counts.both} BOTH, ${manifest.counts.controlOnly} CONTROL_ONLY, ${manifest.counts.dataOnly} DATA_ONLY.`);

  return manifest;
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFilePath)) {
  generateManifestAndTracks();
}
