export const UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION = "20260728100000";

export interface UnifiedTextProductionReadinessReport {
  readonly ready: boolean;
  readonly status: "ready" | "blocked";
  readonly schemaVersion: string | null;
  readonly structuralReady: boolean;
  readonly missingCount: number | null;
  readonly issueCode: string | null;
}

type FetchLike = typeof fetch;

function readRequiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = String(environment[name] ?? "").trim();
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}

function normalizeSupabaseBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("invalid_control_database_url");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function callRpc(args: {
  readonly fetchImpl: FetchLike;
  readonly baseUrl: string;
  readonly serviceRoleKey: string;
  readonly functionName: string;
}): Promise<unknown> {
  const response = await args.fetchImpl(`${args.baseUrl}/rest/v1/rpc/${args.functionName}`, {
    method: "POST",
    headers: {
      apikey: args.serviceRoleKey,
      Authorization: `Bearer ${args.serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`rpc_unavailable:${args.functionName}:${response.status}`);
  return response.json();
}

function readScalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return null;
}

function readStructuralResult(value: unknown): {
  readonly ready: boolean;
  readonly schemaVersion: string | null;
  readonly missingCount: number | null;
} {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ready: false, schemaVersion: null, missingCount: null };
  }
  const record = candidate as Record<string, unknown>;
  const missingCount = Number(record.missing_count);
  return {
    ready: record.ready === true,
    schemaVersion: typeof record.schema_version === "string" ? record.schema_version : null,
    missingCount: Number.isFinite(missingCount) ? missingCount : null,
  };
}

export async function verifyUnifiedTextProductionReadiness(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<UnifiedTextProductionReadinessReport> {
  try {
    const baseUrl = normalizeSupabaseBaseUrl(readRequiredEnvironment(environment, "SUPABASE_URL_1"));
    const serviceRoleKey = readRequiredEnvironment(environment, "SUPABASE_SERVICE_ROLE_KEY_1");
    const [versionResult, structuralResult] = await Promise.all([
      callRpc({
        fetchImpl,
        baseUrl,
        serviceRoleKey,
        functionName: "get_unified_text_tokens_v2_schema_version",
      }),
      callRpc({
        fetchImpl,
        baseUrl,
        serviceRoleKey,
        functionName: "verify_unified_text_tokens_v2_rollout",
      }),
    ]);
    const schemaVersion = readScalarString(versionResult);
    const structural = readStructuralResult(structuralResult);
    const ready = schemaVersion === UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION
      && structural.ready
      && structural.schemaVersion === UNIFIED_TEXT_FULL_ROLLOUT_SCHEMA_VERSION
      && structural.missingCount === 0;
    return {
      ready,
      status: ready ? "ready" : "blocked",
      schemaVersion,
      structuralReady: structural.ready,
      missingCount: structural.missingCount,
      issueCode: ready ? null : "unified_text_full_rollout_migration_incomplete",
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "unknown";
    const issueCode = raw.startsWith("missing_environment:")
      ? "unified_text_database_environment_missing"
      : raw === "invalid_control_database_url"
        ? "unified_text_database_url_invalid"
        : "unified_text_full_rollout_migration_unavailable";
    return {
      ready: false,
      status: "blocked",
      schemaVersion: null,
      structuralReady: false,
      missingCount: null,
      issueCode,
    };
  }
}
