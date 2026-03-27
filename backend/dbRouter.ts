import { randomInt } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type DatabaseId = 1 | 2 | 3 | 4;
type AssignableDatabaseId = 2 | 3 | 4;

type UserDbMapRow = {
  assigned_db: number;
};

type DbRouterErrorLike = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

const CONTROL_DATABASE_ID: DatabaseId = 1;
const ALL_DATABASE_IDS: readonly DatabaseId[] = [1, 2, 3, 4];
const ASSIGNABLE_DATABASE_IDS: readonly AssignableDatabaseId[] = [2, 3, 4];

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

  const assignedDb = pickRandomDataDatabase();
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
