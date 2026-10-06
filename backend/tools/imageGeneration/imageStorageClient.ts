// SentIQ Chat v3 — Dedicated Supabase Image Storage Client
//
// Manages the dedicated Supabase client for binary image storage.
// The dedicated image-storage project is separate from user database shards (DB2/DB3)
// and handles only raw generated image binaries in the configured storage bucket.
//
// Configuration:
//   SENTIQ_IMAGE_STORAGE_SUPABASE_URL
//   SENTIQ_IMAGE_STORAGE_SUPABASE_SERVICE_ROLE_KEY
//
// If the dedicated environment variables are absent, callers safely fall back
// to the legacy database shard storage client for backward compatibility.
//
// Security & session contract:
//   - Uses service-role key
//   - autoRefreshToken = false
//   - persistSession = false
//   - Never exposes or logs credentials

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedDedicatedClient: SupabaseClient | null = null;
let testClientOverride: SupabaseClient | null = null;

export function isDedicatedImageStorageConfigured(): boolean {
  if (testClientOverride !== null) return true;
  const url = process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_SERVICE_ROLE_KEY?.trim();
  return Boolean(url && serviceRoleKey);
}

/**
 * Get or initialize the dedicated Supabase client for image binary storage.
 * Returns null if the dedicated environment variables are not configured.
 */
export function getDedicatedImageStorageClient(): SupabaseClient | null {
  if (testClientOverride !== null) {
    return testClientOverride;
  }

  const url = process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SENTIQ_IMAGE_STORAGE_SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !serviceRoleKey) {
    return null;
  }

  if (!cachedDedicatedClient) {
    cachedDedicatedClient = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    console.log("[ImageStorage] Dedicated Supabase image storage client initialized.");
  }

  return cachedDedicatedClient;
}

export function resetDedicatedImageStorageClient(): void {
  cachedDedicatedClient = null;
  testClientOverride = null;
}

export function overrideDedicatedImageStorageClientForTesting(client: SupabaseClient | null): void {
  testClientOverride = client;
}
