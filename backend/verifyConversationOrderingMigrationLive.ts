import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

// Verifies that every data shard has the exact conversation-ordering migration
// before the frontend rollout is promoted. This is intentionally read-only.

const EXPECTED_VERSION = "20260809123000";
const DATA_SHARDS = [2, 3] as const;

dotenv.config();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function verifyShard(databaseId: (typeof DATA_SHARDS)[number]): Promise<void> {
  const client = createClient(
    requiredEnv(`SUPABASE_URL_${databaseId}`),
    requiredEnv(`SUPABASE_SERVICE_ROLE_KEY_${databaseId}`),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );

  const { data, error } = await client.rpc("get_conversation_user_activity_schema_version");
  if (error) {
    throw new Error(
      `Data shard ${databaseId} is missing conversation ordering migration ${EXPECTED_VERSION}: ${error.message}`,
    );
  }
  if (data !== EXPECTED_VERSION) {
    throw new Error(
      `Data shard ${databaseId} returned conversation ordering schema version ${String(data)}; expected ${EXPECTED_VERSION}`,
    );
  }

  console.log(`[SentIQ Chat] Data shard ${databaseId}: conversation ordering migration ${EXPECTED_VERSION} verified.`);
}

(async () => {
  await Promise.all(DATA_SHARDS.map((databaseId) => verifyShard(databaseId)));
  console.log("[SentIQ Chat] Conversation ordering migration is consistent across all data shards.");
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SentIQ Chat] Conversation ordering migration verification failed: ${message}`);
  process.exit(1);
});
