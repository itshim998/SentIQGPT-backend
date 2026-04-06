import { randomInt } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DatabaseId = 1 | 2 | 3 | 4;
type AssignableDatabaseId = 2 | 3 | 4;

type UserDbMapRow = {
  assigned_db: number;
};

type DbUserCountRow = {
  assigned_db: number;
  user_count: number;
};

type DbRouterErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

// ═══════════════════════════════════════════════════════════════════════════════
// CAPACITY MANAGEMENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Maximum users per data database before it's considered "full".
 * 
 * Supabase free tier: 500MB storage
 * With conversation limit (50) and memory limit (25KB), each user uses roughly:
 *   - 50 conversations × ~2KB average = 100KB
 *   - 25KB memories
 *   - ~5KB usage_logs, user record
 *   Total: ~130KB per active user
 * 
 * 500MB / 130KB ≈ 3,800 users at max capacity
 * 90% threshold = ~3,400 users per DB
 * 
 * Conservative setting to ensure we never hit 95%:
 */
const MAX_USERS_PER_DATABASE = 3400;

/**
 * Threshold ratio for considering a DB "full" for new user assignment.
 * At 90%, we stop assigning new users to that DB.
 */
const DB_FULL_THRESHOLD_RATIO = 0.90;

/**
 * Cache TTL for user counts (in milliseconds).
 * Counts are expensive to compute, so we cache them.
 */
const USER_COUNT_CACHE_TTL_MS = 60_000; // 1 minute

const CONTROL_DATABASE_ID: DatabaseId = 1;
const ALL_DATABASE_IDS: readonly DatabaseId[] = [1, 2, 3, 4];
const ASSIGNABLE_DATABASE_IDS: readonly AssignableDatabaseId[] = [2, 3, 4];

// ═══════════════════════════════════════════════════════════════════════════════
// USER COUNT CACHE (for load-aware DB selection)
// ═══════════════════════════════════════════════════════════════════════════════

type UserCountCache = {
  counts: Map<AssignableDatabaseId, number>;
  lastUpdated: number;
};

let userCountCache: UserCountCache = {
  counts: new Map(),
  lastUpdated: 0,
};

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[dbRouter] Missing required environment variable: ${name}`);
  }
  return value;
}

function isDatabaseId(value: number): value is DatabaseId {
  return Number.isInteger(value) && ALL_DATABASE_IDS.includes(value as DatabaseId);
}

function assertValidUserId(userId: string): string {
  const normalized = userId.trim();
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidPattern.test(normalized)) {
    throw new Error(`[dbRouter] Invalid userId: "${userId}"`);
  }

  return normalized;
}

function createServiceRoleClient(databaseId: DatabaseId): SupabaseClient {
  const url = readRequiredEnv(`SUPABASE_URL_${databaseId}`);
  const serviceRoleKey = readRequiredEnv(`SUPABASE_SERVICE_ROLE_KEY_${databaseId}`);

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

const clientByDatabaseId: Readonly<Record<DatabaseId, SupabaseClient>> = {
  1: createServiceRoleClient(1),
  2: createServiceRoleClient(2),
  3: createServiceRoleClient(3),
  4: createServiceRoleClient(4),
};

const controlDbClient = clientByDatabaseId[CONTROL_DATABASE_ID];

function getClientForDatabase(dbNumber: number): SupabaseClient {
  if (!isDatabaseId(dbNumber)) {
    throw new Error(`[dbRouter] Invalid assigned_db value "${dbNumber}" in control database`);
  }

  return clientByDatabaseId[dbNumber];
}

function formatDbRouterError(error: DbRouterErrorLike): string {
  if (!error) return "unknown";
  const parts = [
    error.code ? `code=${error.code}` : null,
    error.message ? `message=${error.message}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : "unknown";
}

function logDbRouter(operation: string, userId: string, details: Record<string, string | number | null> = {}): void {
  const detailString = Object.entries(details)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const suffix = detailString ? ` ${detailString}` : "";
  console.log(`[dbRouter] ${operation} userId=${userId}${suffix}`);
}

async function fetchAssignedDatabase(userId: string): Promise<DatabaseId | null> {
  const normalizedUserId = assertValidUserId(userId);

  const { data, error } = await controlDbClient
    .from("user_db_map")
    .select("assigned_db")
    .eq("user_id", normalizedUserId)
    .maybeSingle<UserDbMapRow>();

  if (error) {
    throw new Error(
      `[dbRouter] Failed to fetch database assignment for user ${normalizedUserId}: ${error.message}`,
    );
  }

  if (!data) {
    return null;
  }

  if (!isDatabaseId(data.assigned_db)) {
    throw new Error(
      `[dbRouter] Control database returned out-of-range assigned_db=${String(data.assigned_db)} for user ${normalizedUserId}`,
    );
  }

  return data.assigned_db;
}

async function ensureControlUserSession(userId: string): Promise<void> {
  const normalizedUserId = assertValidUserId(userId);
  logDbRouter("control-session.init.start", normalizedUserId, { db: CONTROL_DATABASE_ID });

  const { error } = await controlDbClient.rpc("initialize_user_session", {
    p_user_id: normalizedUserId,
  });

  if (error) {
    console.error(
      `[dbRouter] control-session.init.failed userId=${normalizedUserId} db=${CONTROL_DATABASE_ID} ${formatDbRouterError(error)}`,
    );
    throw new Error(
      `[dbRouter] Failed to initialize control user session for user ${normalizedUserId}: ${error.message}`,
    );
  }

  logDbRouter("control-session.init.ok", normalizedUserId, { db: CONTROL_DATABASE_ID });
}

function pickRandomDataDatabase(): AssignableDatabaseId {
  const index = randomInt(0, ASSIGNABLE_DATABASE_IDS.length);
  return ASSIGNABLE_DATABASE_IDS[index];
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD-AWARE DATABASE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetches user counts per assignable database from the control DB's user_db_map.
 * Returns a map of database ID to user count.
 */
async function fetchUserCountsPerDatabase(): Promise<Map<AssignableDatabaseId, number>> {
  const { data, error } = await controlDbClient
    .from("user_db_map")
    .select("assigned_db")
    .in("assigned_db", ASSIGNABLE_DATABASE_IDS);

  if (error) {
    console.error(`[dbRouter] fetchUserCounts.failed ${formatDbRouterError(error)}`);
    // Return empty counts on error - will fall back to random selection
    return new Map(ASSIGNABLE_DATABASE_IDS.map(id => [id, 0]));
  }

  // Count users per database
  const counts = new Map<AssignableDatabaseId, number>(
    ASSIGNABLE_DATABASE_IDS.map(id => [id, 0])
  );

  for (const row of (data ?? []) as { assigned_db: number }[]) {
    const dbId = row.assigned_db as AssignableDatabaseId;
    if (ASSIGNABLE_DATABASE_IDS.includes(dbId)) {
      counts.set(dbId, (counts.get(dbId) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Gets cached user counts, refreshing if cache is stale.
 */
async function getCachedUserCounts(): Promise<Map<AssignableDatabaseId, number>> {
  const now = Date.now();
  
  if (now - userCountCache.lastUpdated < USER_COUNT_CACHE_TTL_MS && userCountCache.counts.size > 0) {
    return userCountCache.counts;
  }

  const freshCounts = await fetchUserCountsPerDatabase();
  userCountCache = {
    counts: freshCounts,
    lastUpdated: now,
  };

  // Log current DB utilization
  for (const [dbId, count] of freshCounts) {
    const utilization = ((count / MAX_USERS_PER_DATABASE) * 100).toFixed(1);
    console.log(`[dbRouter] db-stats db=${dbId} users=${count} utilization=${utilization}%`);
  }

  return freshCounts;
}

/**
 * Selects the best database for a new user based on current load.
 * 
 * Algorithm:
 * 1. Filter out databases that are at or above 90% capacity
 * 2. From remaining DBs, select the one with the fewest users
 * 3. If all DBs are full, throw an error (system at capacity)
 * 
 * This ensures even distribution and prevents any single DB from exceeding 95%.
 */
async function selectLeastLoadedDatabase(): Promise<AssignableDatabaseId> {
  const counts = await getCachedUserCounts();
  const threshold = Math.floor(MAX_USERS_PER_DATABASE * DB_FULL_THRESHOLD_RATIO);

  // Find available DBs (under 90% capacity)
  const availableDbs: { id: AssignableDatabaseId; count: number }[] = [];

  for (const dbId of ASSIGNABLE_DATABASE_IDS) {
    const count = counts.get(dbId) ?? 0;
    if (count < threshold) {
      availableDbs.push({ id: dbId, count });
    } else {
      console.log(`[dbRouter] db-full db=${dbId} users=${count} threshold=${threshold}`);
    }
  }

  // If no DBs available, system is at capacity
  if (availableDbs.length === 0) {
    const totalUsers = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    throw new Error(
      `[dbRouter] All databases at capacity. Total users: ${totalUsers}. ` +
      `Each DB threshold: ${threshold} users (${(DB_FULL_THRESHOLD_RATIO * 100).toFixed(0)}% of ${MAX_USERS_PER_DATABASE}).`
    );
  }

  // Sort by count (ascending) and pick the least loaded
  availableDbs.sort((a, b) => a.count - b.count);
  const selected = availableDbs[0];

  console.log(
    `[dbRouter] load-aware-select selected_db=${selected.id} user_count=${selected.count} ` +
    `available_dbs=${availableDbs.map(d => `${d.id}:${d.count}`).join(",")}`
  );

  return selected.id;
}

/**
 * Invalidates the user count cache.
 * Call this after successfully assigning a user to ensure accurate counts.
 */
function invalidateUserCountCache(): void {
  userCountCache.lastUpdated = 0;
}

function isUniqueConstraintViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || error.message?.toLowerCase().includes("duplicate key") === true;
}

export async function getUserDatabase(userId: string): Promise<SupabaseClient | null> {
  const assignedDb = await fetchAssignedDatabase(userId);
  return assignedDb === null ? null : getClientForDatabase(assignedDb);
}

export async function assignDatabaseToUser(userId: string): Promise<SupabaseClient> {
  const normalizedUserId = assertValidUserId(userId);
  await ensureControlUserSession(normalizedUserId);

  const existingAssignment = await fetchAssignedDatabase(normalizedUserId);
  if (existingAssignment !== null) {
    logDbRouter("assign.skip-existing", normalizedUserId, { assigned_db: existingAssignment });
    return getClientForDatabase(existingAssignment);
  }

  // Use load-aware selection instead of random
  const assignedDb = await selectLeastLoadedDatabase();
  logDbRouter("assign.start", normalizedUserId, { assigned_db: assignedDb });
  const { error } = await controlDbClient
    .from("user_db_map")
    .insert({ user_id: normalizedUserId, assigned_db: assignedDb });

  if (error) {
    console.error(
      `[dbRouter] assign.failed userId=${normalizedUserId} assigned_db=${assignedDb} ${formatDbRouterError(error)}`,
    );
    if (isUniqueConstraintViolation(error)) {
      const winningAssignment = await fetchAssignedDatabase(normalizedUserId);
      if (winningAssignment !== null) {
        logDbRouter("assign.race-won", normalizedUserId, { assigned_db: winningAssignment });
        return getClientForDatabase(winningAssignment);
      }

      throw new Error(
        `[dbRouter] Database assignment race detected for user ${normalizedUserId}, but no persisted mapping was found afterward`,
      );
    }

    throw new Error(
      `[dbRouter] Failed to assign database ${assignedDb} to user ${normalizedUserId}: ${error.message}`,
    );
  }

  logDbRouter("assign.ok", normalizedUserId, { assigned_db: assignedDb });
  
  // Invalidate cache so next assignment gets fresh counts
  invalidateUserCountCache();
  
  return getClientForDatabase(assignedDb);
}

export async function getOrAssignUserDatabase(userId: string): Promise<SupabaseClient> {
  const normalizedUserId = assertValidUserId(userId);
  await ensureControlUserSession(normalizedUserId);

  const assignedDb = await fetchAssignedDatabase(normalizedUserId);
  if (assignedDb !== null) {
    logDbRouter("resolve.ok", normalizedUserId, { assigned_db: assignedDb });
    return getClientForDatabase(assignedDb);
  }

  logDbRouter("resolve.missing-map", normalizedUserId);
  return assignDatabaseToUser(normalizedUserId);
}
