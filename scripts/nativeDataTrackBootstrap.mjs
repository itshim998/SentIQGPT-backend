import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import cp from "child_process";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const ROOT_DIR = path.resolve(process.cwd());
const MANIFEST_PATH = path.join(ROOT_DIR, "supabase", "migration-manifest.json");
const DATA_TRACK_DIR = path.join(ROOT_DIR, "supabase", "tracks", "data", "migrations");
const EXPECTED_MIGRATION_COUNT = 64;

export const REQUIRED_DATA_SHARD_TABLES = [
  "users",
  "conversations",
  "messages",
  "memories",
  "chat_generations",
  "deep_research_reports",
  "generated_files",
];

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function validateDataTrackMigrations() {
  if (!fs.existsSync(DATA_TRACK_DIR)) {
    throw new Error(`Data track migrations directory missing: ${DATA_TRACK_DIR}`);
  }

  const files = fs.readdirSync(DATA_TRACK_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(
      `[Validation Gate] Expected exactly ${EXPECTED_MIGRATION_COUNT} migrations in data track, but found ${files.length}`
    );
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const manifestDataMigrations = manifest.migrations.filter((m) => m.targetTracks.includes("data"));

  if (manifestDataMigrations.length !== EXPECTED_MIGRATION_COUNT) {
    throw new Error(
      `[Validation Gate] Manifest defines ${manifestDataMigrations.length} data migrations, expected ${EXPECTED_MIGRATION_COUNT}`
    );
  }

  for (const item of manifestDataMigrations) {
    const filePath = path.join(DATA_TRACK_DIR, item.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`[Validation Gate] Migration file missing from data track: ${item.filename}`);
    }
    const computedHash = hashFile(filePath);
    if (computedHash !== item.checksum) {
      throw new Error(`[Validation Gate] Checksum mismatch for ${item.filename}`);
    }
  }

  // Ensure zero control-only migrations
  const controlOnlyVersions = new Set(
    manifest.migrations.filter((m) => m.scope === "CONTROL_ONLY").map((m) => m.version)
  );
  for (const file of files) {
    const version = file.slice(0, 14);
    if (controlOnlyVersions.has(version)) {
      throw new Error(`[Validation Gate] Control-only migration detected in data track: ${file}`);
    }
    if (version === "20260922120000") {
      throw new Error(`[Validation Gate] Retired DB4 migration detected in data track: ${file}`);
    }
  }

  return files;
}

/**
 * Creates a clean isolated Supabase project directory containing ONLY data track migrations.
 * This guarantees native Supabase CLI resolves only data track files without touching
 * mixed canonical root migrations.
 */
export function createIsolatedDataTrackWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentiq-data-shard-sb-"));
  const sbDir = path.join(tmpDir, "supabase");
  const migrationsDir = path.join(sbDir, "migrations");

  fs.mkdirSync(migrationsDir, { recursive: true });

  // Minimal valid config.toml
  const configContent = `project_id = "sentiq-data-shard"\n[db]\nmajor_version = 15\n`;
  fs.writeFileSync(path.join(sbDir, "config.toml"), configContent);

  const files = validateDataTrackMigrations();
  for (const file of files) {
    const src = path.join(DATA_TRACK_DIR, file);
    const dest = path.join(migrationsDir, file);
    fs.copyFileSync(src, dest);
  }

  return {
    workspacePath: tmpDir,
    migrationCount: files.length,
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Warning: failed to remove temp workspace ${tmpDir}:`, err.message);
      }
    },
  };
}

export function resolveDbConnectionString(dbNumber) {
  const envUrl = process.env[`SUPABASE_DB_URL_${dbNumber}`] || process.env[`DATABASE_URL_${dbNumber}`];
  if (envUrl && envUrl.trim()) {
    try {
      const parsed = new URL(envUrl.trim());
      // If host is db.<ref>.supabase.co, route through Mumbai pooler on port 5432 to support IPv4 networks
      const match = parsed.host.match(/^db\.([a-z0-9]+)\.supabase\.co/);
      if (match && parsed.password) {
        const ref = match[1];
        const pwd = encodeURIComponent(parsed.password);
        return `postgresql://postgres.${ref}:${pwd}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`;
      }
    } catch {
      // ignore URL parse errors and return raw envUrl
    }
    return envUrl.trim();
  }

  const projectUrl = process.env[`SUPABASE_URL_${dbNumber}`]?.trim();
  const password = process.env[`SUPABASE_DB_PASSWORD_${dbNumber}`]?.trim();
  const projectId = process.env[`SUPABASE_PROJECT_ID_${dbNumber}`]?.trim();

  let ref = projectId;
  if (!ref && projectUrl) {
    const match = projectUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
    if (match) {
      ref = match[1];
    }
  }

  if (ref && password) {
    const encodedPassword = encodeURIComponent(password);
    // Connect via Supabase session pooler on port 5432 (AWS Mumbai)
    return `postgresql://postgres.${ref}:${encodedPassword}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require`;
  }

  return null;
}

export function executeSupabaseCliPush({ workspacePath, connectionString, dryRun }) {
  const args = [
    "supabase",
    "db",
    "push",
    "--workdir",
    workspacePath,
    "--db-url",
    connectionString,
    "--include-all",
    "--skip-vault",
  ];

  if (dryRun) {
    args.push("--dry-run");
  }

  const cmd = `npx ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
  // Never log raw connectionString
  console.log(`Executing Supabase CLI (dryRun=${dryRun})...`);

  try {
    const output = cp.execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, output };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    // Sanitize any secrets in error output
    const sanitizedError = (stderr + "\n" + stdout).replace(/postgresql:\/\/[^@\s]+@/g, "postgresql://***:***@");
    return { ok: false, error: sanitizedError };
  }
}

export async function verifyShardPostBootstrap(dbNumber) {
  const url = process.env[`SUPABASE_URL_${dbNumber}`]?.trim();
  const key = process.env[`SUPABASE_SERVICE_ROLE_KEY_${dbNumber}`]?.trim();

  if (!url || !key) {
    throw new Error(`Missing SUPABASE_URL_${dbNumber} or SUPABASE_SERVICE_ROLE_KEY_${dbNumber}`);
  }

  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`[Verification] Checking required tables for DB${dbNumber}...`);
  for (const table of REQUIRED_DATA_SHARD_TABLES) {
    const { error } = await client.from(table).select("*", { count: "exact", head: true }).limit(1);
    if (error) {
      throw new Error(`Table "${table}" missing or inaccessible on DB${dbNumber}: ${error.message} (code ${error.code})`);
    }
    console.log(`  ✓ Table ${table} present`);
  }

  console.log(`[Verification] Running verify_sentiq_data_shard_startup on DB${dbNumber}...`);
  const probeId = crypto.randomUUID();
  const { data: result, error: rpcErr } = await client.rpc("verify_sentiq_data_shard_startup", {
    p_probe_user_id: probeId,
    p_verify_live: false,
  });

  if (rpcErr) {
    throw new Error(`Startup verification RPC returned error on DB${dbNumber}: ${rpcErr.message}`);
  }

  if (!result?.ok) {
    throw new Error(
      `Startup verification RPC failed on DB${dbNumber}: ${JSON.stringify(result?.failures || "unknown")}`
    );
  }

  console.log(`  ✓ Startup verifier RPC passed! ok=${result.ok}, failures=${JSON.stringify(result.failures)}`);

  const connStr = resolveDbConnectionString(dbNumber);
  if (connStr) {
    console.log(`[Verification] Checking native supabase_migrations.schema_migrations count on DB${dbNumber}...`);
    try {
      const out = cp.execSync(`npx supabase migration list --db-url "${connStr}"`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parsed = JSON.parse(out);
      const applied = parsed.migrations.filter((m) => m.remote);
      console.log(`  ✓ Native schema_migrations contains exactly ${applied.length} applied versions`);
      if (applied.length !== EXPECTED_MIGRATION_COUNT) {
        throw new Error(`Expected ${EXPECTED_MIGRATION_COUNT} applied versions on DB${dbNumber}, but found ${applied.length}`);
      }
    } catch (err) {
      if (err.message.includes("Expected")) throw err;
      console.warn(`  (Note: could not query CLI migration list: ${err.message})`);
    }
  }

  return result;
}

if (process.argv[1] && process.argv[1].endsWith("nativeDataTrackBootstrap.mjs")) {
  (async () => {
    const targetDb = process.argv[2] ? parseInt(process.argv[2], 10) : 2;
    const isApply = process.argv.includes("--apply");
    const isVerifyOnly = process.argv.includes("--verify-only");

    console.log(`\n=== Native Supabase Data Track Bootstrap (Target DB${targetDb}) ===`);

    if (isVerifyOnly) {
      await verifyShardPostBootstrap(targetDb);
      process.exit(0);
    }

    const connStr = resolveDbConnectionString(targetDb);
    if (!connStr) {
      console.log(`Note: Direct PostgreSQL connection credentials not found in environment for DB${targetDb}.`);
      console.log(`Set SUPABASE_DB_URL_${targetDb} (or SUPABASE_DB_PASSWORD_${targetDb}) in local .env to proceed.`);
      process.exit(1);
    }

    const ws = createIsolatedDataTrackWorkspace();
    console.log(`Created isolated workspace with ${ws.migrationCount} migrations at: ${ws.workspacePath}`);

    try {
      console.log(`\nStep 1: Native Dry-Run`);
      const dryRunRes = executeSupabaseCliPush({
        workspacePath: ws.workspacePath,
        connectionString: connStr,
        dryRun: true,
      });

      if (!dryRunRes.ok) {
        console.error(`Dry-run failed:\n${dryRunRes.error}`);
        process.exit(1);
      }

      console.log(`Dry-run output:\n${dryRunRes.output}`);

      if (isApply) {
        console.log(`\nStep 2: Applying ${ws.migrationCount} migrations to DB${targetDb}...`);
        const applyRes = executeSupabaseCliPush({
          workspacePath: ws.workspacePath,
          connectionString: connStr,
          dryRun: false,
        });

        if (!applyRes.ok) {
          console.error(`Migration push failed:\n${applyRes.error}`);
          process.exit(1);
        }

        console.log(`Migration push output:\n${applyRes.output}`);

        console.log(`\nStep 3: Verification Post-Bootstrap`);
        await verifyShardPostBootstrap(targetDb);
        console.log(`\nDB${targetDb} bootstrap & verification completely successful!`);
      } else {
        console.log(`\nDry-run completed successfully! Use --apply to execute migrations.`);
      }
    } finally {
      ws.cleanup();
    }
  })().catch((err) => {
    console.error("Bootstrap error:", err.message);
    process.exit(1);
  });
}

