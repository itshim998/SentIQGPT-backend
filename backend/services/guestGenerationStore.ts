import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDataShardDatabases } from "../dbRouter";

const DATA_SHARDS = getDataShardDatabases();
const GUEST_OWNER_KEY_VERSION = "sentiq-guest-generation-v1|";

export function normalizeGuestOwnerKey(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error("Guest owner key is required");
  return normalized;
}

function shardIndex(ownerKey: string): number {
  const normalized = normalizeGuestOwnerKey(ownerKey);
  const digest = createHash("sha256").update(normalized).digest();
  return digest.readUInt32BE(0) % DATA_SHARDS.length;
}

/**
 * Resolve a data shard from the canonical durable guest owner key.
 * The owner key is already a versioned SHA-256 digest derived from the
 * browser anonymous ID; do not hash it again during shard selection.
 */
export function getGuestGenerationDatabase(ownerKey: string): SupabaseClient {
  return createGuestGenerationDbProxy(DATA_SHARDS[shardIndex(ownerKey)]);
}

export function createGuestGenerationDbProxy(base: SupabaseClient): SupabaseClient {
  const tableMap: Record<string, string> = {
    chat_generations: "guest_chat_generations",
    chat_generation_events: "guest_chat_generation_events",
  };
  const rpcMap: Record<string, string> = {
    claim_chat_generation_execution: "claim_guest_chat_generation_execution",
    renew_chat_generation_execution_lease: "renew_guest_chat_generation_execution_lease",
    release_chat_generation_execution_lease: "release_guest_chat_generation_execution_lease",
    request_chat_generation_cancel: "request_guest_chat_generation_cancel",
    cancel_chat_generation: "cancel_guest_chat_generation",
    append_chat_generation_event_fenced: "append_guest_chat_generation_event_fenced",
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "from") {
        return (table: string) => target.from(tableMap[table] || table);
      }
      if (property === "rpc") {
        return (functionName: string, args?: Record<string, unknown>) => {
          const mappedName = rpcMap[functionName] || functionName;
          if (!rpcMap[functionName]) return target.rpc(mappedName, args as any);
          const mappedArgs = { ...(args || {}) } as Record<string, unknown>;
          if ("p_user_id" in mappedArgs) {
            mappedArgs.p_owner_key_hash = mappedArgs.p_user_id;
            delete mappedArgs.p_user_id;
          }
          return target.rpc(mappedName, mappedArgs as any);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as SupabaseClient;
}

export function guestGenerationOwnerKeyFromAnonymousId(anonymousId: string): string {
  return createHash("sha256")
    .update(GUEST_OWNER_KEY_VERSION)
    .update(normalizeGuestOwnerKey(anonymousId))
    .digest("hex");
}

export function getGuestGenerationOwnerKeyForRequest(req: { headers?: Record<string, unknown> }): string {
  const raw = req.headers?.["x-sentiq-anonymous-id"];
  const anonymousId = Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
  return guestGenerationOwnerKeyFromAnonymousId(normalizeGuestOwnerKey(anonymousId));
}

export async function claimGuestGenerationRecoveryAttempt(
  userDb: SupabaseClient,
  ownerKey: string,
  generationId: string,
  expectedAttempts: number,
  errorMessage = "backend_execution_recovery_started",
) {
  const currentAttempts = Number.isFinite(expectedAttempts) ? Math.max(0, Math.floor(expectedAttempts)) : 0;
  const result = await userDb
    .from("chat_generations")
    .update({
      recovery_attempts: currentAttempts + 1,
      last_execution_error: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", generationId)
    .eq("user_id", normalizeGuestOwnerKey(ownerKey))
    .eq("recovery_attempts", currentAttempts)
    .select("id, recovery_attempts, last_execution_error, updated_at")
    .maybeSingle();

  return {
    data: result.data ? {
      id: String(result.data.id),
      recovery_attempts: Number(result.data.recovery_attempts ?? currentAttempts + 1),
      last_execution_error: result.data.last_execution_error ?? null,
      updated_at: result.data.updated_at ?? null,
    } : null,
    error: result.error,
    claimed: Boolean(result.data),
  };
}

export async function recordGuestGenerationRecoveryFailure(
  userDb: SupabaseClient,
  ownerKey: string,
  generationId: string,
  errorMessage: string,
) {
  return userDb
    .from("chat_generations")
    .update({
      last_execution_error: String(errorMessage || "guest_generation_recovery_failed").slice(0, 512),
      updated_at: new Date().toISOString(),
    })
    .eq("id", generationId)
    .eq("user_id", normalizeGuestOwnerKey(ownerKey));
}
