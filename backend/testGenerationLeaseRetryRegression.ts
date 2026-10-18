import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { appendChatGenerationEventFenced } from "./services/chatGenerationEventService";

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT_DIR, "supabase", "migrations");
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");
const DATA_TRACK_SB_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "supabase", "migrations");
const CONTROL_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "control", "migrations");
const MANIFEST_PATH = path.join(ROOT_DIR, "supabase", "migration-manifest.json");

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

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

  // Must preserve SECURITY DEFINER and safe search_path declarations
  const definerMatches = sql.match(/security definer/gi) || [];
  assert.equal(definerMatches.length, 5, "All 5 functions must declare SECURITY DEFINER");

  const searchPathMatches = sql.match(/set search_path = public, pg_temp/gi) || [];
  assert.equal(searchPathMatches.length, 5, "All 5 functions must declare safe search_path");

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

test("regression: all data track mirror files are identical to canonical migration", () => {
  const filename = "20261017120000_fix_generation_lease_serialization_retry_loop.sql";
  const canonical = fs.readFileSync(path.join(MIGRATIONS_DIR, filename));
  const dataTrack = fs.readFileSync(path.join(DATA_TRACK_DIR, filename));
  const dataTrackSb = fs.readFileSync(path.join(DATA_TRACK_SB_DIR, filename));

  assert.equal(sha256(canonical), sha256(dataTrack), "Data track migration copy must be byte-for-byte identical to canonical");
  assert.equal(sha256(canonical), sha256(dataTrackSb), "Data track Supabase copy must be byte-for-byte identical to canonical");
});

test("regression: migration manifest registers 20261017120000 strictly under DATA_ONLY scope", () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), "Manifest file must exist");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  const targetMigration = manifest.migrations.find((m: any) => m.version === "20261017120000");
  assert.ok(targetMigration, "Migration 20261017120000 must be in manifest");
  assert.equal(targetMigration.scope, "DATA_ONLY", "Scope must be DATA_ONLY");
  assert.deepEqual(targetMigration.targetTracks, ["data"], "Target track must be data only");

  const canonicalFile = path.join(MIGRATIONS_DIR, targetMigration.filename);
  const dataTrackFile = path.join(DATA_TRACK_DIR, targetMigration.filename);
  const controlTrackFile = path.join(CONTROL_TRACK_DIR, targetMigration.filename);

  assert.ok(fs.existsSync(dataTrackFile), "Must exist in data track");
  assert.ok(!fs.existsSync(controlTrackFile), "Must NOT exist in control track (strict shard isolation)");
  assert.equal(targetMigration.checksum, sha256(fs.readFileSync(canonicalFile)), "Manifest checksum must match canonical file");
});

test("runtime contract: appendChatGenerationEventFenced does NOT retry on permanent lease-loss failure", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      assert.equal(fn, "append_chat_generation_event_fenced");
      return {
        data: null,
        error: { code: "P0001", message: "Generation execution lease lost" },
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "hello", sequence: 1 } as any,
    partialText: "hello",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 1, "Must immediately terminate without retrying on lease lost");
  assert.equal(res.data, null);
  assert.equal(res.error?.code, "P0001");
  assert.equal(res.error?.message, "Generation execution lease lost");
});

test("runtime contract: appendChatGenerationEventFenced does NOT retry on sequence mismatch failure", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      return {
        data: null,
        error: { code: "P0001", message: "Generation event sequence mismatch: expected 2 received 5" },
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "world", sequence: 5 } as any,
    partialText: "world",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 1, "Must immediately terminate without retrying on sequence mismatch");
  assert.equal(res.data, null);
  assert.equal(res.error?.code, "P0001");
});

test("runtime contract: appendChatGenerationEventFenced does NOT retry on sequence already exists", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      return {
        data: null,
        error: { code: "P0001", message: "Generation event sequence already exists" },
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "duplicate", sequence: 1 } as any,
    partialText: "duplicate",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 1, "Must immediately terminate without retrying on sequence already exists");
  assert.equal(res.data, null);
  assert.equal(res.error?.code, "P0001");
});

test("runtime contract: appendChatGenerationEventFenced DOES retry on genuine transient failures", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      if (callCount === 1) {
        // First attempt fails with transient timeout/network error
        return {
          data: null,
          error: { code: "57014", message: "canceling statement due to statement timeout" },
        };
      }
      // Second attempt succeeds
      return {
        data: [{ generation_id: "test-gen", sequence: 1 }],
        error: null,
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "recovered", sequence: 1 } as any,
    partialText: "recovered",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 2, "Must retry transient errors up to maxAttempts");
  assert.ok(res.data, "Should succeed on second attempt");
  assert.equal(res.error, null);
});

test("runtime contract: appendChatGenerationEventFenced DOES retry on genuine 40001 serialization conflicts", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      if (callCount === 1) {
        // First attempt fails with genuine PostgreSQL serialization failure
        return {
          data: null,
          error: { code: "40001", message: "could not serialize access due to concurrent update" },
        };
      }
      // Second attempt succeeds
      return {
        data: [{ generation_id: "test-gen", sequence: 1 }],
        error: null,
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "serialization-recovered", sequence: 1 } as any,
    partialText: "serialization-recovered",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 2, "Must retry genuine serialization conflict up to maxAttempts");
  assert.ok(res.data, "Should succeed on second attempt");
  assert.equal(res.error, null);
});

test("runtime contract: appendChatGenerationEventFenced terminates on legacy 40001 if message is lease lost", async () => {
  let callCount = 0;
  const mockDb = {
    rpc: async (fn: string, params: any) => {
      callCount++;
      return {
        data: null,
        error: { code: "40001", message: "Generation execution lease lost" },
      };
    },
  };

  const res = await appendChatGenerationEventFenced(mockDb, {
    userId: "test-user-id",
    generationId: "test-generation-id",
    leaseId: "test-lease-id",
    event: { type: "token", text: "legacy-lease-lost", sequence: 1 } as any,
    partialText: "legacy-lease-lost",
    tokensGenerated: 1,
    status: "generating",
  });

  assert.equal(callCount, 1, "Must not retry even under 40001 if message indicates lease loss");
  assert.equal(res.data, null);
  assert.equal(res.error?.code, "40001");
});

