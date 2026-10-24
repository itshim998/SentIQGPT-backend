import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyMigrationVersion } from "./generateMigrationTracks.mjs";

const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sqlFiles = (dir) => fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();

/** Derive counts from classified, checksummed files, never from an obsolete
 * numeric constant. Validate both CLI track layouts and reject extra files. */
export function validateMigrationTracks(root = process.cwd()) {
  const base = path.join(root, "supabase");
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "migration-manifest.json"), "utf8"));
  const canonical = sqlFiles(path.join(base, "migrations"));
  const entries = manifest.migrations;
  if (!Array.isArray(entries) || manifest.totalCanonicalMigrations !== canonical.length
      || JSON.stringify(entries.map((entry) => entry.filename)) !== JSON.stringify(canonical)) {
    throw new Error("Migration manifest does not match canonical files");
  }
  const tracks = { control: [], data: [] };
  const counts = { both: 0, controlOnly: 0, dataOnly: 0, controlTrackTotal: 0, dataTrackTotal: 0 };
  const versions = new Set();
  for (const entry of entries) {
    const match = /^(\d{14})_(.+)\.sql$/.exec(entry.filename);
    if (!match || match[1] !== entry.version || match[2] !== entry.name || versions.has(entry.version)) {
      throw new Error("Invalid or duplicate migration identity");
    }
    versions.add(entry.version);
    const classified = classifyMigrationVersion(entry.version, entry.filename);
    if (entry.scope !== classified.scope || JSON.stringify(entry.targetTracks) !== JSON.stringify(classified.targetTracks)) {
      throw new Error(`Migration scope mismatch: ${entry.filename}`);
    }
    if (digest(path.join(base, "migrations", entry.filename)) !== entry.checksum) {
      throw new Error(`Canonical checksum mismatch: ${entry.filename}`);
    }
    counts[entry.scope === "BOTH" ? "both" : entry.scope === "CONTROL_ONLY" ? "controlOnly" : "dataOnly"]++;
    for (const track of entry.targetTracks) {
      tracks[track].push(entry);
      counts[`${track}TrackTotal`]++;
      for (const layout of ["migrations", path.join("supabase", "migrations")]) {
        if (digest(path.join(base, "tracks", track, layout, entry.filename)) !== entry.checksum) {
          throw new Error(`Track checksum mismatch: ${track}/${layout}/${entry.filename}`);
        }
      }
    }
  }
  for (const [key, count] of Object.entries(counts)) {
    if (manifest.counts?.[key] !== count) throw new Error(`Manifest count mismatch: ${key}`);
  }
  for (const track of ["control", "data"]) {
    for (const layout of ["migrations", path.join("supabase", "migrations")]) {
      if (JSON.stringify(sqlFiles(path.join(base, "tracks", track, layout))) !== JSON.stringify(tracks[track].map((item) => item.filename))) {
        throw new Error(`Unexpected or missing ${track} track migration`);
      }
    }
  }
  return { manifest, tracks };
}
