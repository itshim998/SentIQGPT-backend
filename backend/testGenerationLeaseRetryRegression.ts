import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT_DIR, "supabase", "migrations");
const MANIFEST_PATH = path.join(ROOT_DIR, "supabase", "migration-manifest.json");
const EVENT_SERVICE_PATH = path.join(ROOT_DIR, "backend", "services", "chatGenerationEventService.ts");

test("regression: canonical forward migration 20261017120000 exists and eliminates 40001 retry hazard", () => {
  const migrationFile = path.join(MIGRATIONS_DIR, "20261017120000_fix_generation_lease_serialization_retry_loop.sql");
  assert.ok(fs.existsSync(migrationFile), "Forward migration 20261017120000 must exist");

  const sql = fs.readFileSync(migrationFile, "utf8");

  // Must define all 5 fenced generation lease RPCs
  assert.match(sql, /create or replace function public\.checkpoint_chat_generation_fenced/);
  assert.match(sql, /create or replace function public\.finalize_chat_generation_fenced/);
  assert.match(sql, /create or replace function public\.append_chat_generation_event_fenced/);
  assert.match(sql, /create or replace function public\.renew_guest_chat_generation_execution_lease/);
  assert.match(sql, /create or replace function public\.append_guest_chat_generation_event_fenced/);

  // Must use P0001 instead of 40001 to prevent PostgREST Haskell retry storms
  assert.doesNotMatch(sql, /errcode\s*=\s*'40001'/, "Forward migration must not use SQLSTATE 40001 (serialization_failure)");
  assert.match(sql, /errcode = 'P0001'/, "Forward migration must use errcode = 'P0001'");

  // Verify each function specifically uses P0001
  const checkpointFunc = sql.slice(sql.indexOf("checkpoint_chat_generation_fenced"), sql.indexOf("finalize_chat_generation_fenced"));
  assert.match(checkpointFunc, /errcode = 'P0001'/);
  assert.doesNotMatch(checkpointFunc, /errcode\s*=\s*'40001'/);

  const finalizeFunc = sql.slice(sql.indexOf("finalize_chat_generation_fenced"), sql.indexOf("append_chat_generation_event_fenced"));
  assert.match(finalizeFunc, /errcode = 'P0001'/);
  assert.doesNotMatch(finalizeFunc, /errcode\s*=\s*'40001'/);

  const appendAuthFunc = sql.slice(sql.indexOf("append_chat_generation_event_fenced"), sql.indexOf("renew_guest_chat_generation_execution_lease"));
  assert.match(appendAuthFunc, /errcode = 'P0001'/);
  assert.doesNotMatch(appendAuthFunc, /errcode\s*=\s*'40001'/);

  const renewGuestFunc = sql.slice(sql.indexOf("renew_guest_chat_generation_execution_lease"), sql.indexOf("append_guest_chat_generation_event_fenced"));
  assert.match(renewGuestFunc, /errcode = 'P0001'/);
  assert.doesNotMatch(renewGuestFunc, /errcode\s*=\s*'40001'/);

  const appendGuestFunc = sql.slice(sql.indexOf("append_guest_chat_generation_event_fenced"));
  assert.match(appendGuestFunc, /errcode = 'P0001'/);
  assert.doesNotMatch(appendGuestFunc, /errcode\s*=\s*'40001'/);
});

test("regression: migration manifest registers 20261017120000 strictly under DATA_ONLY scope", () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), "Manifest file must exist");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  const targetMigration = manifest.migrations.find((m: any) => m.version === "20261017120000");
  assert.ok(targetMigration, "Migration 20261017120000 must be in manifest");
  assert.equal(targetMigration.scope, "DATA_ONLY", "Scope must be DATA_ONLY");
  assert.deepEqual(targetMigration.targetTracks, ["data"], "Target track must be data only");

  // Verify track files
  const dataTrackFile = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations", targetMigration.filename);
  const controlTrackFile = path.join(ROOT_DIR, "supabase", "tracks", "control", "migrations", targetMigration.filename);

  assert.ok(fs.existsSync(dataTrackFile), "Must exist in data track");
  assert.ok(!fs.existsSync(controlTrackFile), "Must NOT exist in control track (strict shard isolation)");
});

test("regression: chatGenerationEventService handles P0001 lease-loss as terminal without retry", () => {
  const code = fs.readFileSync(EVENT_SERVICE_PATH, "utf8");

  // Must check for P0001 and lease lost to avoid redundant attempts
  assert.match(code, /result\.error\?\.code === "P0001"/);
  assert.match(code, /lease lost/);
});
