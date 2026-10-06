import type { GeminiLiveConfig } from "./geminiLiveConfig";
import type { GeminiLiveFailureClass } from "./geminiLiveKeyPool";

type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export type GeminiLiveTokenResult = {
  token: string;
  expiresAt: string;
  newSessionExpiresAt: string;
};

export class GeminiLiveTokenError extends Error {
  readonly failureClass: GeminiLiveFailureClass;
  readonly statusCode?: number;

  constructor(message: string, failureClass: GeminiLiveFailureClass, statusCode?: number) {
    super(message);
    this.name = "GeminiLiveTokenError";
    this.failureClass = failureClass;
    this.statusCode = statusCode;
  }
}

function classifyStatus(status: number): GeminiLiveFailureClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "capacity";
  if (status === 400 || status === 404) return "configuration";
  if (status >= 500) return "unavailable";
  return "unknown";
}

function buildLockedSetup(
  config: GeminiLiveConfig,
  systemInstruction: string,
  modelOverride?: string,
): Record<string, unknown> {
  const effectiveModel = (modelOverride || config.model).replace(/^models\//, "");
  return {
    model: `models/${effectiveModel}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: config.defaultVoice },
        },
      },
    },
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    ...(config.disableSearchGrounding ? {} : { tools: [{ googleSearch: {} }] }),
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: false },
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    contextWindowCompression: { slidingWindow: {} },
    historyConfig: { initialHistoryInClientContent: true },
  };
}

export class GeminiLiveTokenService {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(args: { fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number } = {}) {
    this.fetchImpl = args.fetchImpl ?? (fetch as unknown as FetchLike);
    this.now = args.now ?? Date.now;
    this.timeoutMs = args.timeoutMs ?? 8_000;
  }

  async createToken(args: {
    apiKey: string;
    config: GeminiLiveConfig;
    systemInstruction: string;
    sessionMaxSeconds?: number;
    modelOverride?: string;
  }): Promise<GeminiLiveTokenResult> {
    const now = this.now();
    const sessionMaxSeconds = Math.min(
      args.config.sessionMaxSeconds,
      Math.max(1, Math.floor(args.sessionMaxSeconds ?? args.config.sessionMaxSeconds)),
    );
    const expiresAt = new Date(now + sessionMaxSeconds * 1_000).toISOString();
    const newSessionWindowSeconds = Math.min(90, Math.max(1, Math.floor(sessionMaxSeconds / 2)));
    const newSessionExpiresAt = new Date(now + newSessionWindowSeconds * 1_000).toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    let response: FetchResponseLike;
    try {
      response = await this.fetchImpl(args.config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        body: JSON.stringify({
          uses: 1,
          expireTime: expiresAt,
          newSessionExpireTime: newSessionExpiresAt,
          bidiGenerateContentSetup: buildLockedSetup(args.config, args.systemInstruction, args.modelOverride),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GeminiLiveTokenError("Live token provisioning timed out.", "timeout");
      }
      throw new GeminiLiveTokenError("Live token provisioning failed.", "network");
    } finally {
      clearTimeout(timeout);
    }

    const payload = await response.json().catch(() => ({})) as { name?: unknown };
    if (!response.ok) {
      throw new GeminiLiveTokenError(
        "Live token provisioning was rejected.",
        classifyStatus(response.status),
        response.status,
      );
    }

    const token = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!token) {
      throw new GeminiLiveTokenError("Live token provisioning returned an invalid response.", "configuration");
    }

    return { token, expiresAt, newSessionExpiresAt };
  }
}
