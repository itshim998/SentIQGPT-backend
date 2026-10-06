// SentIQ Chat v3 — Cloudflare Workers AI Account Pool & Health State
//
// Manages up to 8 Cloudflare credential slots for Workers AI image inference,
// tracks account-level and model-level health, and provides fair account rotation.
//
// Credentials are read from:
//   SENTIQ_CLOUDFLARE_AI_ACCOUNT_ID_1 .. 8
//   SENTIQ_CLOUDFLARE_AI_API_TOKEN_1 .. 8
//
// Health semantics:
//   - Error 3036 (daily neuron exhaustion): marks the entire account exhausted until next 00:00 UTC.
//   - HTTP 401: permanently disables that credential slot for the process lifetime.
//   - HTTP 403 (account-level): permanently disables slot if token/auth failure.
//   - Error 3040 (out of capacity): short cooldown on (account, model).
//   - HTTP 429: 1 safe retry after 1s; on failure, cooldown on (account, model).
//   - Model unavailable / 404: marks (account, model) unavailable.
//   - Timeout / Network / 5xx: transient cooldown on (account, model).

export interface CloudflareCredentialSlot {
  readonly slotIndex: number;
  readonly accountId: string;
  readonly apiToken: string;
}

export interface CloudflareAccountHealth {
  permanentlyDisabled: boolean;
  exhaustedUntil: number | null; // Next 00:00 UTC timestamp when exhausted
}

export interface CloudflareModelHealth {
  cooldownUntil: number | null;
  unavailable: boolean;
}

const DEFAULT_COOLDOWN_MS = 30_000;
const CAPACITY_COOLDOWN_MS = 15_000;
const TRANSIENT_COOLDOWN_MS = 15_000;

// Process-local health maps
const accountHealthMap = new Map<number, CloudflareAccountHealth>();
const accountModelHealthMap = new Map<string, CloudflareModelHealth>();

// Round-robin selection cursor per model
const modelRoundRobinCursors = new Map<string, number>();

// Test overrides
let slotOverridesForTesting: CloudflareCredentialSlot[] | null = null;

export function overrideCloudflareSlotsForTesting(slots: CloudflareCredentialSlot[] | null): void {
  slotOverridesForTesting = slots;
}

export function resetCloudflareHealthState(): void {
  accountHealthMap.clear();
  accountModelHealthMap.clear();
  modelRoundRobinCursors.clear();
}

/**
 * Calculate the next 00:00 UTC midnight timestamp.
 */
export function getNextUtcMidnight(): number {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return nextMidnight.getTime();
}

/**
 * Read configured Cloudflare Workers AI credential slots from environment.
 * Evaluates slots 1 through 8. Any slot missing either account ID or token is safely ignored.
 */
export function getConfiguredCloudflareSlots(): readonly CloudflareCredentialSlot[] {
  if (slotOverridesForTesting !== null) {
    return slotOverridesForTesting;
  }

  const slots: CloudflareCredentialSlot[] = [];
  for (let i = 1; i <= 8; i++) {
    const accountId = process.env[`SENTIQ_CLOUDFLARE_AI_ACCOUNT_ID_${i}`]?.trim();
    const apiToken = process.env[`SENTIQ_CLOUDFLARE_AI_API_TOKEN_${i}`]?.trim();

    if (accountId && apiToken) {
      slots.push({
        slotIndex: i,
        accountId,
        apiToken,
      });
    }
  }

  return slots;
}

function getAccountHealth(slotIndex: number): CloudflareAccountHealth {
  let health = accountHealthMap.get(slotIndex);
  if (!health) {
    health = { permanentlyDisabled: false, exhaustedUntil: null };
    accountHealthMap.set(slotIndex, health);
  }
  return health;
}

function getAccountModelKey(slotIndex: number, modelId: string): string {
  return `${slotIndex}::${modelId.trim().toLowerCase()}`;
}

function getAccountModelHealth(slotIndex: number, modelId: string): CloudflareModelHealth {
  const key = getAccountModelKey(slotIndex, modelId);
  let health = accountModelHealthMap.get(key);
  if (!health) {
    health = { cooldownUntil: null, unavailable: false };
    accountModelHealthMap.set(key, health);
  }
  return health;
}

/**
 * Check if a Cloudflare account slot is available at the account level.
 */
export function isAccountAvailable(slotIndex: number): boolean {
  const health = getAccountHealth(slotIndex);
  if (health.permanentlyDisabled) {
    return false;
  }
  if (health.exhaustedUntil !== null) {
    if (Date.now() < health.exhaustedUntil) {
      return false;
    }
    // Daily reset expired — account has refreshed
    health.exhaustedUntil = null;
  }
  return true;
}

/**
 * Check if a specific (account slot, model) combination is available for inference.
 */
export function isAccountModelAvailable(slotIndex: number, modelId: string): boolean {
  if (!isAccountAvailable(slotIndex)) {
    return false;
  }

  const modelHealth = getAccountModelHealth(slotIndex, modelId);
  if (modelHealth.unavailable) {
    return false;
  }

  if (modelHealth.cooldownUntil !== null) {
    if (Date.now() < modelHealth.cooldownUntil) {
      return false;
    }
    modelHealth.cooldownUntil = null;
  }

  return true;
}

/**
 * Retrieve healthy Cloudflare slots for a given model, ordered fairly in round-robin sequence.
 */
export function getHealthySlotsForModel(modelId: string): CloudflareCredentialSlot[] {
  const configuredSlots = getConfiguredCloudflareSlots();
  if (configuredSlots.length === 0) return [];

  // Filter to slots that are healthy for this model
  const eligibleSlots = configuredSlots.filter((slot) =>
    isAccountModelAvailable(slot.slotIndex, modelId),
  );

  if (eligibleSlots.length === 0) return [];

  // Fair selection: rotate starting offset
  const normalizedModel = modelId.trim().toLowerCase();
  const currentCursor = modelRoundRobinCursors.get(normalizedModel) ?? 0;
  const nextCursor = (currentCursor + 1) % eligibleSlots.length;
  modelRoundRobinCursors.set(normalizedModel, nextCursor);

  // Return slots starting from currentCursor
  const ordered: CloudflareCredentialSlot[] = [];
  for (let i = 0; i < eligibleSlots.length; i++) {
    const idx = (currentCursor + i) % eligibleSlots.length;
    ordered.push(eligibleSlots[idx]);
  }

  return ordered;
}

// ============================================================================
// Health Mutation Functions
// ============================================================================

/**
 * Mark an account slot as having exhausted its daily free neuron allocation (e.g. error 3036).
 * Affects the ENTIRE account for all image models until next 00:00 UTC.
 */
export function recordDailyNeuronExhaustion(slotIndex: number, modelId: string): void {
  const health = getAccountHealth(slotIndex);
  health.exhaustedUntil = getNextUtcMidnight();
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=daily_neuron_exhaustion resetAt=${new Date(health.exhaustedUntil).toISOString()}`,
  );
}

/**
 * Mark a temporary capacity failure (e.g. error 3040).
 * Applies short cooldown to the (account, model) pair without disabling the account.
 */
export function recordCapacityFailure(slotIndex: number, modelId: string, cooldownMs = CAPACITY_COOLDOWN_MS): void {
  const modelHealth = getAccountModelHealth(slotIndex, modelId);
  modelHealth.cooldownUntil = Date.now() + cooldownMs;
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=capacity cooldownMs=${cooldownMs}`,
  );
}

/**
 * Mark a rate limit (HTTP 429) after retry failure on the (account, model) pair.
 */
export function recordRateLimitCooldown(slotIndex: number, modelId: string, cooldownMs = DEFAULT_COOLDOWN_MS): void {
  const modelHealth = getAccountModelHealth(slotIndex, modelId);
  modelHealth.cooldownUntil = Date.now() + cooldownMs;
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=rate_limited cooldownMs=${cooldownMs}`,
  );
}

/**
 * Permanently disable a credential slot for the process lifetime (HTTP 401 or fatal 403).
 */
export function recordPermanentAuthFailure(slotIndex: number, modelId: string, reason = "auth_failure"): void {
  const health = getAccountHealth(slotIndex);
  health.permanentlyDisabled = true;
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=permanently_disabled reason=${reason}`,
  );
}

/**
 * Mark a model unavailable for a specific account (e.g. 404 / unsupported model).
 */
export function recordModelUnavailable(slotIndex: number, modelId: string): void {
  const modelHealth = getAccountModelHealth(slotIndex, modelId);
  modelHealth.unavailable = true;
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=model_unavailable`,
  );
}

/**
 * Mark a transient error (timeout / 5xx / transport) on the (account, model) pair.
 */
export function recordTransientFailure(slotIndex: number, modelId: string, cooldownMs = TRANSIENT_COOLDOWN_MS): void {
  const modelHealth = getAccountModelHealth(slotIndex, modelId);
  modelHealth.cooldownUntil = Date.now() + cooldownMs;
  console.log(
    `[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=transient_failure cooldownMs=${cooldownMs}`,
  );
}

/**
 * Record a successful inference outcome.
 */
export function recordSuccessfulGeneration(slotIndex: number, modelId: string): void {
  console.log(`[IMAGE][CLOUDFLARE] account=${slotIndex} model=${modelId} outcome=success`);
}
