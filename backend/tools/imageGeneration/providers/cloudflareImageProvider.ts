// SentIQ Chat v3 — Cloudflare Workers AI Image Provider
//
// Conforms to the ImageProvider abstraction and executes requests against
// the Cloudflare Workers AI REST API using the configured credential pool.
//
// Supports canonical models:
//   - @cf/black-forest-labs/flux-1-schnell
//   - @cf/black-forest-labs/flux-2-klein-4b
//   - @cf/black-forest-labs/flux-2-klein-9b
//   - @cf/lykon/dreamshaper-8-lcm
//
// Enforces model-specific request shapes:
//   - Schnell and Dreamshaper use application/json
//   - Klein 4B and 9B use multipart/form-data (FormData)
//
// Handles account-level vs model-level errors:
//   - 3036: daily neuron allocation exhaustion (account-wide until UTC midnight)
//   - 3040: capacity temporarily exceeded (short cooldown on account/model)
//   - 429: rate limit (1 retry after 1s, then cooldown on account/model)
//   - 401: auth failure (permanently disables account slot)
//   - 403: permission inspection (disables slot if token invalid)
//   - 5xx / timeout: transient cooldown on account/model

import { createHash } from "node:crypto";
import {
  ImageProviderFailure,
  failureOutcomeForHttpStatus,
  type ImageProvider,
  type ImageProviderRequestContext,
  type ImageProviderResult,
} from "../types";
import {
  getConfiguredCloudflareSlots,
  getHealthySlotsForModel,
  isAccountModelAvailable,
  recordCapacityFailure,
  recordDailyNeuronExhaustion,
  recordModelUnavailable,
  recordPermanentAuthFailure,
  recordRateLimitCooldown,
  recordSuccessfulGeneration,
  recordTransientFailure,
  type CloudflareCredentialSlot,
} from "../cloudflareAiPool";

export const CLOUDFLARE_MODEL_SCHNELL = "@cf/black-forest-labs/flux-1-schnell";
export const CLOUDFLARE_MODEL_KLEIN_4B = "@cf/black-forest-labs/flux-2-klein-4b";
export const CLOUDFLARE_MODEL_KLEIN_9B = "@cf/black-forest-labs/flux-2-klein-9b";
export const CLOUDFLARE_MODEL_DREAMSHAPER = "@cf/lykon/dreamshaper-8-lcm";

export type CloudflareModelId =
  | typeof CLOUDFLARE_MODEL_SCHNELL
  | typeof CLOUDFLARE_MODEL_KLEIN_4B
  | typeof CLOUDFLARE_MODEL_KLEIN_9B
  | typeof CLOUDFLARE_MODEL_DREAMSHAPER
  | string;

export interface CloudflareErrorItem {
  readonly code?: number;
  readonly message?: string;
}

export interface CloudflareApiResponse {
  readonly success?: boolean;
  readonly errors?: readonly CloudflareErrorItem[];
  readonly messages?: readonly unknown[];
  readonly result?: {
    readonly image?: string;
    readonly [key: string]: unknown;
  } | null;
  readonly image?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type CloudflareFetchFunction = typeof fetch;

let customFetchForTesting: CloudflareFetchFunction | null = null;

export function setCloudflareFetchForTesting(fn: CloudflareFetchFunction | null): void {
  customFetchForTesting = fn;
}

function getActiveFetch(): CloudflareFetchFunction {
  return customFetchForTesting || fetch;
}

function isKleinModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("klein") || normalized.includes("flux-2-klein");
}

function deriveSeed(requestKey?: string, prompt = ""): number | undefined {
  if (!requestKey) return undefined;
  const seedHex = createHash("sha256")
    .update(requestKey)
    .update("\0")
    .update(prompt)
    .digest("hex")
    .slice(0, 8);
  return (Number.parseInt(seedHex, 16) % 2147483646) + 1;
}

function parseSize(size?: string): { width: number; height: number } {
  if (!size) return { width: 1024, height: 1024 };
  const parts = size.split("x").map((s) => Number.parseInt(s.trim(), 10));
  const width = Number.isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1024;
  const height = Number.isFinite(parts[1]) && parts[1] > 0 ? parts[1] : 1024;
  return { width, height };
}

export function isDailyNeuronExhaustion(code?: number, message = ""): boolean {
  if (code === 3036) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("daily free allocation of neurons") ||
    (lower.includes("daily free allocation") && lower.includes("neuron") && lower.includes("exhaust"))
  );
}

function isCapacityExceeded(code?: number, message = ""): boolean {
  if (code === 3040) return true;
  const lower = message.toLowerCase();
  return lower.includes("capacity") || lower.includes("temporarily exceeded") || lower.includes("busy");
}

export function isAccountLevelForbidden(code?: number, message = ""): boolean {
  if (code === 3023) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("not enabled for this account") ||
    lower.includes("account access denied") ||
    lower.includes("account forbidden") ||
    lower.includes("account suspended") ||
    lower.includes("missing permission") ||
    lower.includes("invalid token") ||
    lower.includes("token unauthorized") ||
    lower.includes("authentication")
  );
}

export function isModelAccessForbidden(code?: number, message = ""): boolean {
  if (code === 5018 || code === 3041 || code === 5035) return true;
  const lower = message.toLowerCase();
  return (
    lower.includes("model not authorized") ||
    lower.includes("model restricted") ||
    lower.includes("model access") ||
    lower.includes("model terms") ||
    lower.includes("terms not accepted") ||
    lower.includes("gated model")
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted"));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Image generation aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class CloudflareImageProvider implements ImageProvider {
  readonly name: string;
  readonly modelId: string;
  private readonly timeoutMs: number;

  constructor(modelId: CloudflareModelId, options?: { timeoutMs?: number }) {
    this.name = modelId;
    this.modelId = modelId;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    const configured = getConfiguredCloudflareSlots();
    if (configured.length === 0) return false;
    return configured.some((slot) => isAccountModelAvailable(slot.slotIndex, this.modelId));
  }

  async generate(
    prompt: string,
    size?: string,
    signal?: AbortSignal,
    context?: ImageProviderRequestContext,
  ): Promise<ImageProviderResult> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
    }

    const healthySlots = getHealthySlotsForModel(this.modelId);
    if (healthySlots.length === 0) {
      throw new ImageProviderFailure(
        `No healthy Cloudflare accounts available for model ${this.modelId}`,
        "indeterminate",
      );
    }

    const errors: string[] = [];
    const activeFetch = getActiveFetch();

    for (const slot of healthySlots) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
      }

      // Check if slot was marked unavailable during this request's execution
      if (!isAccountModelAvailable(slot.slotIndex, this.modelId)) {
        continue;
      }

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
        }

        const abortController = new AbortController();
        const timeoutTimer = setTimeout(() => abortController.abort(), this.timeoutMs);
        const onParentAbort = () => abortController.abort(signal?.reason);

        if (signal?.aborted) onParentAbort();
        else signal?.addEventListener("abort", onParentAbort, { once: true });

        try {
          const endpoint = `https://api.cloudflare.com/client/v4/accounts/${slot.accountId}/ai/run/${this.modelId}`;
          const isKlein = isKleinModel(this.modelId);
          const seed = deriveSeed(context?.requestKey, prompt);
          const { width, height } = parseSize(size);

          let requestInit: RequestInit;

          if (isKlein) {
            // Klein models require multipart/form-data
            const formData = new FormData();
            formData.append("prompt", prompt);
            if (width) formData.append("width", String(width));
            if (height) formData.append("height", String(height));
            if (seed !== undefined) formData.append("seed", String(seed));

            requestInit = {
              method: "POST",
              headers: {
                Authorization: `Bearer ${slot.apiToken}`,
              },
              body: formData,
              signal: abortController.signal,
            };
          } else {
            // Schnell and Dreamshaper use application/json
            const jsonBody: Record<string, unknown> = {
              prompt,
              steps: 4,
            };
            if (seed !== undefined) jsonBody.seed = seed;
            if (this.modelId.includes("dreamshaper")) {
              jsonBody.num_steps = 4;
            }

            requestInit = {
              method: "POST",
              headers: {
                Authorization: `Bearer ${slot.apiToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(jsonBody),
              signal: abortController.signal,
            };
          }

          const response = await activeFetch(endpoint, requestInit);

          // Handle 429 Rate Limit
          if (response.status === 429) {
            let errorText = "";
            let errorCode: number | undefined;
            try {
              const bodyJson = (await response.json()) as CloudflareApiResponse;
              errorText = bodyJson.errors?.[0]?.message || "";
              errorCode = bodyJson.errors?.[0]?.code;
            } catch {
              // Non-JSON 429
            }

            // Check if 429 is actually Daily Neuron Exhaustion (3036)
            if (isDailyNeuronExhaustion(errorCode, errorText)) {
              recordDailyNeuronExhaustion(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: daily neuron quota exhausted (code ${errorCode || 3036})`);
              break; // Stop retrying this account, advance to next account
            }

            // Check if 429 is Capacity Exceeded (3040)
            if (isCapacityExceeded(errorCode, errorText)) {
              recordCapacityFailure(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: temporary capacity limit (code ${errorCode || 3040})`);
              break; // Stop retrying this account, advance to next account
            }

            // Standard Rate Limit 429: retry once after 1s
            if (attempt === 1) {
              console.log(
                `[IMAGE][CLOUDFLARE] account=${slot.slotIndex} model=${this.modelId} outcome=rate_limited attempt=1 retrying in 1s`,
              );
              await sleep(1000, signal);
              continue;
            }

            // Second 429 failure: set cooldown on (account, model)
            recordRateLimitCooldown(slot.slotIndex, this.modelId);
            errors.push(`Account ${slot.slotIndex}: rate limited (429)`);
            break;
          }

          // Handle 401 Unauthorized
          if (response.status === 401) {
            recordPermanentAuthFailure(slot.slotIndex, this.modelId, "401_unauthorized");
            errors.push(`Account ${slot.slotIndex}: authentication failed (401)`);
            break;
          }

          // Handle 403 Forbidden
          if (response.status === 403) {
            let errorMsg = "";
            let errorCode: number | undefined;
            try {
              const body = (await response.json()) as CloudflareApiResponse;
              errorCode = body.errors?.[0]?.code;
              errorMsg = body.errors?.[0]?.message || "";
            } catch {
              // non-JSON
            }

            if (isModelAccessForbidden(errorCode, errorMsg)) {
              // Model-access restriction (5018, 3041, 5035): marks ONLY this model unavailable on this account
              recordModelUnavailable(slot.slotIndex, this.modelId);
              errors.push(
                `Account ${slot.slotIndex}: model access restricted (403 code ${errorCode ?? "unknown"}${errorMsg ? `: ${errorMsg}` : ""})`,
              );
            } else if (isAccountLevelForbidden(errorCode, errorMsg)) {
              // Account-level restriction (3023 or account/token permissions): permanently disables this account
              recordPermanentAuthFailure(
                slot.slotIndex,
                this.modelId,
                `403_${errorCode || "account_forbidden"}`,
              );
              errors.push(
                `Account ${slot.slotIndex}: account forbidden (403 code ${errorCode ?? "unknown"}${errorMsg ? `: ${errorMsg}` : ""})`,
              );
            } else {
              // Default 403 fallback: treat as account-level credential failure
              recordPermanentAuthFailure(
                slot.slotIndex,
                this.modelId,
                `403_${errorCode || "forbidden"}`,
              );
              errors.push(`Account ${slot.slotIndex}: credential forbidden (403)`);
            }
            break;
          }

          // Handle 404 / Model Not Found
          if (response.status === 404) {
            recordModelUnavailable(slot.slotIndex, this.modelId);
            errors.push(`Account ${slot.slotIndex}: model not found (404)`);
            break;
          }

          // Handle 5xx Server Errors
          if (response.status >= 500) {
            recordTransientFailure(slot.slotIndex, this.modelId);
            errors.push(`Account ${slot.slotIndex}: server error (${response.status})`);
            break;
          }

          // Handle 400 Bad Request
          if (response.status === 400) {
            let errorText = "";
            let errorCode: number | undefined;
            try {
              const bodyJson = (await response.json()) as CloudflareApiResponse;
              errorText = bodyJson.errors?.[0]?.message || "";
              errorCode = bodyJson.errors?.[0]?.code;
            } catch {
              // Non-JSON
            }

            if (isDailyNeuronExhaustion(errorCode, errorText)) {
              recordDailyNeuronExhaustion(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: daily neuron quota exhausted`);
              break;
            }

            if (isCapacityExceeded(errorCode, errorText)) {
              recordCapacityFailure(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: capacity limit`);
              break;
            }

            if (isModelAccessForbidden(errorCode, errorText)) {
              recordModelUnavailable(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: model access restricted (${errorCode ?? "unknown"})`);
              break;
            }

            if (isAccountLevelForbidden(errorCode, errorText)) {
              recordPermanentAuthFailure(slot.slotIndex, this.modelId, `400_${errorCode || "account_forbidden"}`);
              errors.push(`Account ${slot.slotIndex}: account forbidden (${errorCode ?? "unknown"})`);
              break;
            }

            errors.push(`Account ${slot.slotIndex}: bad request (400) ${errorText}`);
            break;
          }

          // Handle other HTTP errors
          if (!response.ok) {
            const outcome = failureOutcomeForHttpStatus(response.status);
            recordTransientFailure(slot.slotIndex, this.modelId);
            errors.push(`Account ${slot.slotIndex}: HTTP ${response.status}`);
            break;
          }

          // Process successful response
          const contentType = (response.headers.get("content-type") || "").toLowerCase();

          // Case A: JSON response with base64 image data
          if (contentType.includes("application/json")) {
            const json = (await response.json()) as CloudflareApiResponse;

            if (json.success === false && json.errors && json.errors.length > 0) {
              const firstErr = json.errors[0];
              const code = firstErr.code;
              const msg = firstErr.message || "";

              if (isDailyNeuronExhaustion(code, msg)) {
                recordDailyNeuronExhaustion(slot.slotIndex, this.modelId);
                errors.push(`Account ${slot.slotIndex}: daily neuron quota exhausted`);
                break;
              }

              if (isCapacityExceeded(code, msg)) {
                recordCapacityFailure(slot.slotIndex, this.modelId);
                errors.push(`Account ${slot.slotIndex}: temporary capacity exceeded`);
                break;
              }

              if (isModelAccessForbidden(code, msg)) {
                recordModelUnavailable(slot.slotIndex, this.modelId);
                errors.push(`Account ${slot.slotIndex}: model access restricted (${code ?? "unknown"}: ${msg})`);
                break;
              }

              if (isAccountLevelForbidden(code, msg)) {
                recordPermanentAuthFailure(slot.slotIndex, this.modelId, `err_${code || "account_forbidden"}`);
                errors.push(`Account ${slot.slotIndex}: account forbidden (${code ?? "unknown"}: ${msg})`);
                break;
              }

              recordTransientFailure(slot.slotIndex, this.modelId);
              errors.push(`Account ${slot.slotIndex}: Cloudflare error ${code}: ${msg}`);
              break;
            }

            const base64 = json.result?.image || json.image;
            if (typeof base64 === "string" && base64.length > 0) {
              recordSuccessfulGeneration(slot.slotIndex, this.modelId);
              return { base64 };
            }

            errors.push(`Account ${slot.slotIndex}: response missing image field`);
            break;
          }

          // Case B: Binary image bytes returned directly
          const arrayBuffer = await response.arrayBuffer();
          if (arrayBuffer.byteLength > 0) {
            const base64 = Buffer.from(arrayBuffer).toString("base64");
            recordSuccessfulGeneration(slot.slotIndex, this.modelId);
            return { base64 };
          }

          errors.push(`Account ${slot.slotIndex}: empty image binary received`);
          break;
        } catch (err) {
          if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
          }

          const isTimeout = abortController.signal.aborted;
          recordTransientFailure(slot.slotIndex, this.modelId);
          errors.push(
            `Account ${slot.slotIndex}: ${isTimeout ? "request timed out" : err instanceof Error ? err.message : String(err)}`,
          );
          break;
        } finally {
          clearTimeout(timeoutTimer);
          if (signal) {
            signal.removeEventListener("abort", onParentAbort);
          }
        }
      }
    }

    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Image generation aborted");
    }

    throw new ImageProviderFailure(
      `Cloudflare model ${this.modelId} failed on all configured accounts: ${errors.join(" | ")}`,
      "indeterminate",
    );
  }
}
