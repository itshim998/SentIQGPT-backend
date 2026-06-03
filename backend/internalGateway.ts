const DEFAULT_LLM_SERVICE_PORT = process.env.LLM_SERVICE_PORT?.trim() || "3002";
const DEFAULT_LLM_SERVICE_URL = `http://localhost:${DEFAULT_LLM_SERVICE_PORT}`;

export const INTERNAL_GATEWAY_TOKEN_HEADER = "X-SentIQ-Internal-Token";

function getInternalServiceToken(): string {
  return process.env.SENTIQ_INTERNAL_SERVICE_TOKEN?.trim() || "";
}

function getUnsafeInternalEndpointsEnabled(): boolean {
  return process.env.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS === "true";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function getInternalGatewayBaseUrl(): string {
  return (process.env.LLM_SERVICE_URL?.trim() || DEFAULT_LLM_SERVICE_URL).replace(/\/+$/, "");
}

export function getInternalGatewayUrl(pathname: string): string {
  if (!pathname.startsWith("/")) {
    throw new Error("[internalGateway] Gateway path must start with '/'.");
  }
  return `${getInternalGatewayBaseUrl()}${pathname}`;
}

export function getInternalGatewayHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const token = getInternalServiceToken();
  return {
    "Content-Type": "application/json",
    ...headers,
    ...(token ? { [INTERNAL_GATEWAY_TOKEN_HEADER]: token } : {}),
  };
}

export function validateInternalGatewayConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;

  if (!getInternalServiceToken()) {
    throw new Error("[internalGateway] SENTIQ_INTERNAL_SERVICE_TOKEN is required in production.");
  }
  if (getUnsafeInternalEndpointsEnabled()) {
    throw new Error("[internalGateway] SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS cannot be enabled in production.");
  }

  let gatewayUrl: URL;
  try {
    gatewayUrl = new URL(getInternalGatewayBaseUrl());
  } catch {
    throw new Error("[internalGateway] LLM_SERVICE_URL must be a valid URL in production.");
  }

  if (
    gatewayUrl.protocol !== "http:" ||
    !isLoopbackHostname(gatewayUrl.hostname) ||
    gatewayUrl.username ||
    gatewayUrl.password
  ) {
    throw new Error("[internalGateway] LLM_SERVICE_URL must use an unauthenticated loopback HTTP URL in production.");
  }
}
