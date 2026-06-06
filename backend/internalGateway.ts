const INTERNAL_TOKEN_HEADER = "X-SentIQ-Internal-Token";

function getRuntimeEnv(): string {
  return (process.env.NODE_ENV || process.env.RUNTIME_ENV || "development").trim().toLowerCase();
}

function isProductionRuntime(): boolean {
  return getRuntimeEnv() === "production";
}

function getDefaultGatewayUrl(): string {
  return `http://127.0.0.1:${process.env.LLM_SERVICE_PORT || "3002"}`;
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function getInternalGatewayUrl(path = ""): string {
  const baseUrl = (process.env.LLM_SERVICE_URL || getDefaultGatewayUrl()).replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

export function getInternalGatewayHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const token = process.env.SENTIQ_INTERNAL_SERVICE_TOKEN?.trim();
  return {
    ...headers,
    ...(token ? { [INTERNAL_TOKEN_HEADER]: token } : {}),
  };
}

export function validateInternalGatewayConfiguration(): void {
  if (!isProductionRuntime()) return;

  const token = process.env.SENTIQ_INTERNAL_SERVICE_TOKEN?.trim();
  if (!token) {
    throw new Error("SENTIQ_INTERNAL_SERVICE_TOKEN is required in production");
  }

  if (process.env.SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS === "true") {
    throw new Error("SENTIQ_ENABLE_UNSAFE_INTERNAL_ENDPOINTS cannot be enabled in production");
  }

  const gatewayUrl = process.env.LLM_SERVICE_URL || getDefaultGatewayUrl();
  if (!isLoopbackHttpUrl(gatewayUrl)) {
    throw new Error("LLM_SERVICE_URL must remain on the internal loopback HTTP URL in production");
  }
}
