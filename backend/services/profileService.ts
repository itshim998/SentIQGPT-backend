type ProfileDbClient = {
  from: (table: string) => any;
};

type ProfileDbError = {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
} | null | undefined;

type ProfileRow = {
  display_name?: string | null;
  display_name_updated_at?: string | null;
};

type ProfileLogger = (
  event: string,
  details: Record<string, string | boolean | null | undefined>,
) => void;

export type MirroredUserProfile = {
  displayName: string | null;
  requiresName: boolean;
  source: "shard" | "control" | "none";
  repaired: {
    control: boolean;
    shard: boolean;
  };
};

const MAX_DISPLAY_NAME_LENGTH = 80;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatProfileError(error: ProfileDbError): string {
  if (!error) return "unknown";
  const parts = [
    error.code ? `code=${error.code}` : null,
    error.message ? `message=${error.message}` : null,
    error.details ? `details=${error.details}` : null,
    error.hint ? `hint=${error.hint}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "unknown";
}

function normalizeStoredDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = collapseWhitespace(value);
  if (!normalized || normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    return null;
  }
  return normalized;
}

export function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Display name is required.");
  }

  const normalized = collapseWhitespace(value);
  if (!normalized) {
    throw new Error("Display name is required.");
  }
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`Display name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters.`);
  }

  return normalized;
}

async function readProfileRow(
  db: ProfileDbClient,
  userId: string,
): Promise<ProfileRow | null> {
  const result = await (db
    .from("users")
    .select("display_name, display_name_updated_at")
    .eq("id", userId)
    .maybeSingle() as PromiseLike<{ data: ProfileRow | null; error: ProfileDbError }>);

  if (result.error) {
    throw new Error(formatProfileError(result.error));
  }

  return result.data ?? null;
}

async function writeProfileRow(
  db: ProfileDbClient,
  userId: string,
  displayName: string,
): Promise<void> {
  const result = await (db
    .from("users")
    .update({
      display_name: displayName,
      display_name_updated_at: new Date().toISOString(),
    })
    .eq("id", userId) as PromiseLike<{ error: ProfileDbError }>);

  if (result.error) {
    throw new Error(formatProfileError(result.error));
  }
}

async function tryRepairMirror(
  db: ProfileDbClient | null | undefined,
  target: "control" | "shard",
  userId: string,
  displayName: string,
  logger?: ProfileLogger,
): Promise<boolean> {
  if (!db) return false;
  try {
    await writeProfileRow(db, userId, displayName);
    logger?.("profile.repair.ok", { target, userId });
    return true;
  } catch (error) {
    logger?.("profile.repair.failed", {
      target,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function getMirroredUserProfile(args: {
  userId: string;
  controlDb: ProfileDbClient;
  userDb?: ProfileDbClient | null;
  logger?: ProfileLogger;
}): Promise<MirroredUserProfile> {
  const [controlRow, shardRow] = await Promise.all([
    readProfileRow(args.controlDb, args.userId),
    args.userDb ? readProfileRow(args.userDb, args.userId) : Promise.resolve(null),
  ]);

  const controlName = normalizeStoredDisplayName(controlRow?.display_name);
  const shardName = normalizeStoredDisplayName(shardRow?.display_name);

  const source: MirroredUserProfile["source"] = shardName
    ? "shard"
    : controlName
      ? "control"
      : "none";

  const displayName = shardName ?? controlName ?? null;
  const repaired = {
    control: false,
    shard: false,
  };

  if (displayName) {
    if (args.userDb && shardName !== displayName) {
      repaired.shard = await tryRepairMirror(args.userDb, "shard", args.userId, displayName, args.logger);
    }
    if (controlName !== displayName) {
      repaired.control = await tryRepairMirror(args.controlDb, "control", args.userId, displayName, args.logger);
    }
  }

  return {
    displayName,
    requiresName: !displayName,
    source,
    repaired,
  };
}

export async function saveMirroredUserProfile(args: {
  userId: string;
  displayName: string;
  controlDb: ProfileDbClient;
  userDb: ProfileDbClient;
}): Promise<{ displayName: string }> {
  const normalizedDisplayName = validateDisplayName(args.displayName);

  const results = await Promise.allSettled([
    writeProfileRow(args.controlDb, args.userId, normalizedDisplayName),
    writeProfileRow(args.userDb, args.userId, normalizedDisplayName),
  ]);

  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));

  if (failures.length > 0) {
    throw new Error(`Failed to save mirrored profile: ${failures.join(" | ")}`);
  }

  return { displayName: normalizedDisplayName };
}
