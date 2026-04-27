import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";

const GUEST_USER_ID = "guest";
const DEFAULT_JWT_TIMEOUT_MS = 1500;
const JWT_TIMEOUT_MS = (() => {
  const raw = process.env.JWT_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_JWT_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JWT_TIMEOUT_MS;
  }
  return parsed;
})();

export type VerificationMethod = "guest" | "local" | "fallback";

export type VerifiedRequestUser = {
  sub: string;
  isGuest: boolean;
  verificationMethod: VerificationMethod;
};

type AuthResolutionCacheKey = "allow_guest" | "require_user";

export type AuthenticatedRequest = Request & {
  user?: VerifiedRequestUser;
  authResolutionPromises?: Partial<Record<AuthResolutionCacheKey, Promise<VerifiedRequestUser>>>;
};

type ResolveRequestUserOptions = {
  allowGuest: boolean;
};

type AuthErrorCode = "missing_token" | "expired_token" | "invalid_token";

type AuthVerificationStats = {
  localVerifications: number;
  fallbackVerifications: number;
};

const authVerificationStats: AuthVerificationStats = {
  localVerifications: 0,
  fallbackVerifications: 0,
};

export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;

  constructor(message: string, code: AuthErrorCode, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

function logAuth(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, string | number | boolean | null>,
): void {
  const payload = {
    scope: "auth",
    event,
    ...details,
  };

  if (level === "info") {
    console.info(JSON.stringify(payload));
    return;
  }
  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }
  console.error(JSON.stringify(payload));
}

function incrementAuthVerificationMetric(method: "local" | "fallback", userId: string): void {
  if (method === "local") {
    authVerificationStats.localVerifications += 1;
    logAuth("info", "auth.local_verifications", {
      method,
      userId,
      isGuest: false,
      count: authVerificationStats.localVerifications,
    });
    return;
  }

  authVerificationStats.fallbackVerifications += 1;
  logAuth("info", "auth.fallback_verifications", {
    method,
    userId,
    isGuest: false,
    count: authVerificationStats.fallbackVerifications,
  });
}

export function getAuthVerificationStats(): AuthVerificationStats {
  return { ...authVerificationStats };
}

export function resetAuthVerificationStats(): void {
  authVerificationStats.localVerifications = 0;
  authVerificationStats.fallbackVerifications = 0;
}

function getAuthorizationHeader(req: Request): string {
  return req.header("authorization")?.trim() ?? "";
}

function readBearerToken(authHeader: string, allowGuest: boolean): string | null {
  if (!authHeader) {
    if (allowGuest) {
      return null;
    }
    throw new AuthError("Missing token.", "missing_token");
  }

  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!bearerMatch) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  const token = bearerMatch[1]?.trim();
  if (!token) {
    throw new AuthError("Missing token.", "missing_token");
  }

  return token;
}

function buildGuestUser(): VerifiedRequestUser {
  return {
    sub: GUEST_USER_ID,
    isGuest: true,
    verificationMethod: "guest",
  };
}

function getLocalJwtSecret(): Uint8Array | null {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!jwtSecret) {
    return null;
  }
  return new TextEncoder().encode(jwtSecret);
}

function classifyJwtFailure(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }

  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";

  if (code === "ERR_JWT_EXPIRED") {
    return new AuthError("Token expired.", "expired_token");
  }

  return new AuthError("Invalid token.", "invalid_token");
}

async function verifyLocally(token: string): Promise<VerifiedRequestUser> {
  const secret = getLocalJwtSecret();
  if (!secret) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  const { payload } = await jwtVerify(token, secret);
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  return {
    sub,
    isGuest: false,
    verificationMethod: "local",
  };
}

async function verifyWithSupabase(token: string): Promise<VerifiedRequestUser> {
  const supabaseUrl = process.env.SUPABASE_URL_1?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY_1?.trim();

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  let response: globalThis.Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnonKey,
      },
      signal: AbortSignal.timeout(JWT_TIMEOUT_MS),
    });
  } catch {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  if (!response.ok) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  const verifiedUser = await response.json() as { id?: string };
  const sub = typeof verifiedUser.id === "string" ? verifiedUser.id.trim() : "";
  if (!sub) {
    throw new AuthError("Invalid token.", "invalid_token");
  }

  return {
    sub,
    isGuest: false,
    verificationMethod: "fallback",
  };
}

async function resolveFreshRequestUser(
  req: Request,
  options: ResolveRequestUserOptions,
): Promise<VerifiedRequestUser> {
  const authHeader = getAuthorizationHeader(req);
  const token = readBearerToken(authHeader, options.allowGuest);

  if (!token) {
    const guestUser = buildGuestUser();
    logAuth("info", "verify.success", {
      method: guestUser.verificationMethod,
      userId: guestUser.sub,
      isGuest: true,
    });
    return guestUser;
  }

  try {
    const localUser = await verifyLocally(token);
    incrementAuthVerificationMetric("local", localUser.sub);
    logAuth("info", "verify.success", {
      method: localUser.verificationMethod,
      userId: localUser.sub,
      isGuest: false,
    });
    return localUser;
  } catch (error) {
    const localFailure = classifyJwtFailure(error);
    const shouldUseFallback = localFailure.code !== "expired_token";
    logAuth("warn", "verify.local_failed", {
      reason: localFailure.code,
      hasFallback: shouldUseFallback,
      isGuest: false,
      userId: null,
    });

    if (!shouldUseFallback) {
      logAuth("warn", "verify.failed", {
        reason: localFailure.code,
        method: "local",
        isGuest: false,
        userId: null,
      });
      throw localFailure;
    }

    try {
      const fallbackUser = await verifyWithSupabase(token);
      incrementAuthVerificationMetric("fallback", fallbackUser.sub);
      logAuth("info", "verify.success", {
        method: fallbackUser.verificationMethod,
        userId: fallbackUser.sub,
        isGuest: false,
      });
      return fallbackUser;
    } catch (fallbackError) {
      const fallbackFailure = fallbackError instanceof AuthError
        ? fallbackError
        : new AuthError(localFailure.message, localFailure.code);
      const authFailure = fallbackFailure.code === "invalid_token"
        ? new AuthError(localFailure.message, localFailure.code)
        : fallbackFailure;

      logAuth("warn", "verify.failed", {
        reason: authFailure.code,
        method: "fallback",
        isGuest: false,
        userId: null,
      });
      throw authFailure;
    }
  }
}

function getAuthResolutionCacheKey(options: ResolveRequestUserOptions): AuthResolutionCacheKey {
  return options.allowGuest ? "allow_guest" : "require_user";
}

export async function resolveRequestUser(
  req: Request,
  options: ResolveRequestUserOptions,
): Promise<VerifiedRequestUser> {
  const authReq = req as AuthenticatedRequest;

  if (authReq.user) {
    if (!options.allowGuest && authReq.user.isGuest) {
      throw new AuthError("Missing token.", "missing_token");
    }
    return authReq.user;
  }

  const cacheKey = getAuthResolutionCacheKey(options);
  authReq.authResolutionPromises ??= {};

  if (!authReq.authResolutionPromises[cacheKey]) {
    authReq.authResolutionPromises[cacheKey] = resolveFreshRequestUser(req, options)
      .then((user) => {
        authReq.user = user;
        return user;
      })
      .finally(() => {
        delete authReq.authResolutionPromises?.[cacheKey];
        if (authReq.authResolutionPromises && Object.keys(authReq.authResolutionPromises).length === 0) {
          delete authReq.authResolutionPromises;
        }
      });
  }

  const resolvedUser = await authReq.authResolutionPromises[cacheKey];
  if (!options.allowGuest && resolvedUser.isGuest) {
    throw new AuthError("Missing token.", "missing_token");
  }
  return resolvedUser;
}

export function getRequestUser(req: Request): VerifiedRequestUser {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user) {
    throw new Error("Request user was not resolved.");
  }
  return authReq.user;
}

export function verifyJWT(options: ResolveRequestUserOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await resolveRequestUser(req, options);
      next();
    } catch (error) {
      if (error instanceof AuthError) {
        if (!res.headersSent && !res.writableEnded) {
          res.status(error.status).json({ error: error.message });
        }
        return;
      }
      next(error);
    }
  };
}
