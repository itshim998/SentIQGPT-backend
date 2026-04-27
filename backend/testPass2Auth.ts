import assert from "assert/strict";
import { SignJWT } from "jose";
import {
  AuthError,
  type AuthenticatedRequest,
  getAuthVerificationStats,
  resetAuthVerificationStats,
  resolveRequestUser,
} from "./middleware/auth";

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";
const TEST_JWT_SECRET = "pass2-test-secret";

function makeRequest(authHeader?: string): AuthenticatedRequest {
  return {
    header(name: string) {
      return name.toLowerCase() === "authorization" ? authHeader : undefined;
    },
  } as unknown as AuthenticatedRequest;
}

async function signToken(expiresAtSeconds: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(TEST_USER_ID)
    .setIssuedAt()
    .setExpirationTime(expiresAtSeconds)
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

function configureFallbackEnv(): void {
  process.env.SUPABASE_URL_1 = "https://auth.test";
  process.env.SUPABASE_ANON_KEY_1 = "anon-test-key";
}

function findJsonLog(logs: string[], event: string): Record<string, unknown> | undefined {
  for (const log of logs) {
    try {
      const parsed = JSON.parse(log) as Record<string, unknown>;
      if (parsed.event === event) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON console output from dependencies.
    }
  }
  return undefined;
}

async function captureInfoLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const originalInfo = console.info;
  const logs: string[] = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.info = originalInfo;
  }
}

async function expectAuthError(promise: Promise<unknown>, code: AuthError["code"]): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof AuthError, "expected AuthError");
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`Expected AuthError with code ${code}`);
}

async function testExpiredTokenClassification(): Promise<void> {
  resetAuthVerificationStats();
  process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
  configureFallbackEnv();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fallback should not be called for expired local JWTs");
  }) as typeof fetch;

  try {
    const expiredToken = await signToken(Math.floor(Date.now() / 1000) - 60);
    await expectAuthError(
      resolveRequestUser(makeRequest(`Bearer ${expiredToken}`), { allowGuest: false }),
      "expired_token",
    );
    assert.equal(fetchCalls, 0, "expired local classification should skip fallback");
    assert.deepEqual(getAuthVerificationStats(), {
      localVerifications: 0,
      fallbackVerifications: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testLocalVerificationMetric(): Promise<void> {
  resetAuthVerificationStats();
  process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
  configureFallbackEnv();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fallback should not be called for valid local JWTs");
  }) as typeof fetch;

  try {
    const token = await signToken(Math.floor(Date.now() / 1000) + 3600);
    const { result: user, logs } = await captureInfoLogs(() =>
      resolveRequestUser(makeRequest(`Bearer ${token}`), { allowGuest: false }),
    );
    assert.equal(user.sub, TEST_USER_ID);
    assert.equal(user.verificationMethod, "local");
    assert.equal(fetchCalls, 0);
    assert.deepEqual(getAuthVerificationStats(), {
      localVerifications: 1,
      fallbackVerifications: 0,
    });
    const metricLog = findJsonLog(logs, "auth.local_verifications");
    assert(metricLog, "expected local verification metric log");
    assert.equal(metricLog.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testFallbackVerificationMetric(): Promise<void> {
  resetAuthVerificationStats();
  delete process.env.SUPABASE_JWT_SECRET;
  configureFallbackEnv();

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: TEST_USER_ID }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { result: user, logs } = await captureInfoLogs(() =>
      resolveRequestUser(makeRequest("Bearer fallback-token"), { allowGuest: false }),
    );
    assert.equal(user.sub, TEST_USER_ID);
    assert.equal(user.verificationMethod, "fallback");
    assert.equal(fetchCalls, 1);
    assert.deepEqual(getAuthVerificationStats(), {
      localVerifications: 0,
      fallbackVerifications: 1,
    });
    const metricLog = findJsonLog(logs, "auth.fallback_verifications");
    assert(metricLog, "expected fallback verification metric log");
    assert.equal(metricLog.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testSequentialGuestThenRequiredAuth(): Promise<void> {
  resetAuthVerificationStats();
  const req = makeRequest();

  const guest = await resolveRequestUser(req, { allowGuest: true });
  assert.equal(guest.isGuest, true);

  await expectAuthError(resolveRequestUser(req, { allowGuest: false }), "missing_token");
}

async function testConcurrentMixedOptionsUseSeparatePromises(): Promise<void> {
  resetAuthVerificationStats();
  const req = makeRequest();

  const allowGuestPromise = resolveRequestUser(req, { allowGuest: true });
  const requireUserPromise = resolveRequestUser(req, { allowGuest: false }).catch((error: unknown) => error);

  assert(req.authResolutionPromises?.allow_guest, "expected allowGuest cache entry");
  assert(req.authResolutionPromises?.require_user, "expected requireUser cache entry");
  assert.notEqual(
    req.authResolutionPromises.allow_guest,
    req.authResolutionPromises.require_user,
    "mixed option calls must not share one in-flight auth promise",
  );

  const [guest, requiredError] = await Promise.all([allowGuestPromise, requireUserPromise]);
  assert.equal(guest.isGuest, true);
  assert(requiredError instanceof AuthError);
  assert.equal(requiredError.code, "missing_token");
}

async function main(): Promise<void> {
  await testExpiredTokenClassification();
  await testLocalVerificationMetric();
  await testFallbackVerificationMetric();
  await testSequentialGuestThenRequiredAuth();
  await testConcurrentMixedOptionsUseSeparatePromises();
  console.log("PASS | PASS 2 auth regression tests passed.");
}

main().catch((error) => {
  console.error("FAIL | PASS 2 auth regression tests failed.");
  console.error(error);
  process.exit(1);
});
