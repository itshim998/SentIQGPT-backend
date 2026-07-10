import { HttpError } from "./httpErrors";

const INTERNAL_TOKEN_HEADER = "X-SentIQ-Internal-Token";
const INTERNAL_GATEWAY_HEALTH_TIMEOUT_MS = 500;
const INTERNAL_GATEWAY_READY_WAIT_MS = 3_000;
const INTERNAL_GATEWAY_READY_POLL_MS = 250;
const INTERNAL_GATEWAY_READY_CACHE_MS = 1_000;

let readyGatewayUrl: string | null = null;
let readyGatewayCheckedAt = 0;
let readinessWait: Promise<void> | null = null;
let readinessWaitUrl: string | null = null;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function isInternalGatewayHealthy(
  timeoutMs = INTERNAL_GATEWAY_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(getInternalGatewayUrl("/llm/health"), {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function pollUntilInternalGatewayReady(gatewayUrl: string): Promise<void> {
  const deadline = Date.now() + INTERNAL_GATEWAY_READY_WAIT_MS;

  while (true) {
    if (await isInternalGatewayHealthy()) {
      readyGatewayUrl = gatewayUrl;
      readyGatewayCheckedAt = Date.now();
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new HttpError(503, "Service is still starting. Please try again shortly.", {
        code: "backend_unavailable",
        expose: true,
        headers: { "Retry-After": "2" },
      });
    }
    await delay(Math.min(INTERNAL_GATEWAY_READY_POLL_MS, remainingMs));
  }
}

export async function waitForInternalGatewayReady(): Promise<void> {
  const gatewayUrl = getInternalGatewayUrl();
  if (
    readyGatewayUrl === gatewayUrl &&
    Date.now() - readyGatewayCheckedAt < INTERNAL_GATEWAY_READY_CACHE_MS
  ) return;

  if (!readinessWait || readinessWaitUrl !== gatewayUrl) {
    readinessWaitUrl = gatewayUrl;
    readinessWait = pollUntilInternalGatewayReady(gatewayUrl).finally(() => {
      readinessWait = null;
      readinessWaitUrl = null;
    });
  }

  await readinessWait;
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
