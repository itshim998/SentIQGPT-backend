import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT_DIR, "supabase", "migrations");
const MANIFEST_FILE = path.join(ROOT_DIR, "supabase", "migration-manifest.json");
const CONTROL_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "control", "migrations");
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

test("Migration Scope Separation & Manifest Validation", async (t) => {
  assert.ok(fs.existsSync(MANIFEST_FILE), "Manifest file must exist");
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));

  const canonicalFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await t.test("Manifest accounts for all canonical migrations", () => {
    assert.equal(manifest.totalCanonicalMigrations, canonicalFiles.length);
    assert.equal(manifest.migrations.length, canonicalFiles.length);
    assert.equal(canonicalFiles.length, 81, "Must have exactly 81 canonical migrations");

    const manifestFiles = manifest.migrations.map((m: any) => m.filename);
    assert.deepEqual(manifestFiles, canonicalFiles, "Manifest filenames must match filesystem exactly");
  });

  await t.test("Checksum integrity across all migrations", () => {
    for (const item of manifest.migrations) {
      const fullPath = path.join(MIGRATIONS_DIR, item.filename);
      const computedHash = hashFile(fullPath);
      assert.equal(item.checksum, computedHash, `Checksum mismatch on ${item.filename}`);
    }
  });

  await t.test("Migration classification counts match architecture specification", () => {
    assert.equal(manifest.counts.both, 9, "Expected exactly 9 BOTH migrations");
    assert.equal(manifest.counts.controlOnly, 15, "Expected exactly 15 CONTROL_ONLY migrations");
    assert.equal(manifest.counts.dataOnly, 57, "Expected exactly 57 DATA_ONLY migrations");
    assert.equal(manifest.counts.controlTrackTotal, 24, "Expected 24 control track migrations");
    assert.equal(manifest.counts.dataTrackTotal, 66, "Expected 66 data track migrations");
  });

  await t.test("Control track files match manifest exactly", () => {
    const controlFiles = fs.readdirSync(CONTROL_TRACK_DIR).filter((f) => f.endsWith(".sql")).sort();
    assert.equal(controlFiles.length, 24);

    const expectedControlFiles = manifest.migrations
      .filter((m: any) => m.targetTracks.includes("control"))
      .map((m: any) => m.filename)
      .sort();

    assert.deepEqual(controlFiles, expectedControlFiles);
  });

  await t.test("Data track files match manifest exactly", () => {
    const dataFiles = fs.readdirSync(DATA_TRACK_DIR).filter((f) => f.endsWith(".sql")).sort();
    assert.equal(dataFiles.length, 66);

    const expectedDataFiles = manifest.migrations
      .filter((m: any) => m.targetTracks.includes("data"))
      .map((m: any) => m.filename)
      .sort();

    assert.deepEqual(dataFiles, expectedDataFiles);
  });

  await t.test("Strict isolation: Control-only migrations never in data track", () => {
    const dataFiles = new Set(fs.readdirSync(DATA_TRACK_DIR));
    for (const item of manifest.migrations.filter((m: any) => m.scope === "CONTROL_ONLY")) {
      assert.ok(!dataFiles.has(item.filename), `Control-only migration ${item.filename} found in data track`);
    }
  });

  await t.test("Strict isolation: Data-only migrations never in control track", () => {
    const controlFiles = new Set(fs.readdirSync(CONTROL_TRACK_DIR));
    for (const item of manifest.migrations.filter((m: any) => m.scope === "DATA_ONLY")) {
      assert.ok(!controlFiles.has(item.filename), `Data-only migration ${item.filename} found in control track`);
    }
  });

  await t.test("DB4 retirement migration is control-only", () => {
    const db4Retire = manifest.migrations.find((m: any) => m.version === "20260922120000");
    assert.ok(db4Retire, "DB4 retirement migration must exist");
    assert.equal(db4Retire.scope, "CONTROL_ONLY");
    assert.deepEqual(db4Retire.targetTracks, ["control"]);
  });

  await t.test("Fail-closed classification: Unclassified migration throws error rather than defaulting to DATA_ONLY", async () => {
    // @ts-ignore
    const { classifyMigrationVersion } = await import("../scripts/generateMigrationTracks.mjs");
    assert.throws(
      () => classifyMigrationVersion("20269999999999", "20269999999999_unclassified_feature.sql"),
      /Unclassified migration detected.*Failing closed/i,
      "Must throw error on unclassified migration",
    );
  });

  await t.test("Classification sets are strictly disjoint", async () => {
    // @ts-ignore
    const { BOTH_VERSIONS, CONTROL_ONLY_VERSIONS, DATA_ONLY_VERSIONS } = await import("../scripts/generateMigrationTracks.mjs");
    for (const v of BOTH_VERSIONS) {
      assert.ok(!CONTROL_ONLY_VERSIONS.has(v), `Version ${v} is in both BOTH and CONTROL_ONLY`);
      assert.ok(!DATA_ONLY_VERSIONS.has(v), `Version ${v} is in both BOTH and DATA_ONLY`);
    }
    for (const v of CONTROL_ONLY_VERSIONS) {
      assert.ok(!DATA_ONLY_VERSIONS.has(v), `Version ${v} is in both CONTROL_ONLY and DATA_ONLY`);
    }
  });

  await t.test("CI/CD workflow decouples Supabase credentials across accounts", () => {
    const workflowPath = path.join(ROOT_DIR, ".github", "workflows", "supabase-migrations.yml");
    assert.ok(fs.existsSync(workflowPath), "supabase-migrations.yml workflow must exist");
    const workflowContent = fs.readFileSync(workflowPath, "utf8");

    // Must NOT use old shared SUPABASE_ACCESS_TOKEN
    assert.ok(
      !workflowContent.includes("secrets.SUPABASE_ACCESS_TOKEN "),
      "Workflow must not use old shared secrets.SUPABASE_ACCESS_TOKEN",
    );
    assert.ok(
      !workflowContent.includes("secrets.SUPABASE_ACCESS_TOKEN}"),
      "Workflow must not use old shared secrets.SUPABASE_ACCESS_TOKEN",
    );

    // Must have account-specific tokens for DB1, DB2, and DB3
    assert.ok(
      workflowContent.includes("secrets.SUPABASE_ACCESS_TOKEN_1"),
      "Workflow must use secrets.SUPABASE_ACCESS_TOKEN_1 for DB1",
    );
    assert.ok(
      workflowContent.includes("secrets.SUPABASE_ACCESS_TOKEN_2"),
      "Workflow must use secrets.SUPABASE_ACCESS_TOKEN_2 for DB2",
    );
    assert.ok(
      workflowContent.includes("secrets.SUPABASE_ACCESS_TOKEN_3"),
      "Workflow must use secrets.SUPABASE_ACCESS_TOKEN_3 for DB3",
    );

    // Must have separate decoupled deployment jobs
    assert.ok(workflowContent.includes("deploy-db1:"), "Workflow must have deploy-db1 job");
    assert.ok(workflowContent.includes("deploy-db2:"), "Workflow must have deploy-db2 job");
    assert.ok(workflowContent.includes("deploy-db3:"), "Workflow must have deploy-db3 job");

    // Track separation
    assert.ok(
      workflowContent.includes("--workdir supabase/tracks/control"),
      "DB1 must target control track",
    );
    assert.ok(
      workflowContent.includes("--workdir supabase/tracks/data"),
      "DB2/DB3 must target data track",
    );

    // Must NOT contain active DB4 deployment
    assert.ok(!workflowContent.includes("deploy-db4"), "Must not have DB4 deployment job");
    assert.ok(!workflowContent.includes("SUPABASE_ACCESS_TOKEN_4"), "Must not have DB4 access token");
  });
});

