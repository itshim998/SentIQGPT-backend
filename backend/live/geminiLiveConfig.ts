export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const DEFAULT_GEMINI_LIVE_VOICE = "Kore";
export const GEMINI_LIVE_TOKEN_URL = "https://generativelanguage.googleapis.com/v1alpha/auth_tokens";
export const GEMINI_LIVE_WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";

const DEFAULT_SESSION_MAX_SECONDS = 600;
const MIN_SESSION_MAX_SECONDS = 60;
const MAX_AUDIO_SESSION_SECONDS = 900;

export type GeminiLiveConfig = {
  enabled: boolean;
  model: string;
  defaultVoice: string;
  sessionMaxSeconds: number;
  audioOnly: boolean;
  disableSearchGrounding: boolean;
  tokenUrl: string;
  webSocketUrl: string;
};

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function readSessionMaxSeconds(value: string | undefined): number {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_MAX_SECONDS;
  return Math.min(MAX_AUDIO_SESSION_SECONDS, Math.max(MIN_SESSION_MAX_SECONDS, parsed));
}

function normalizeModel(value: string | undefined): string {
  const normalized = value?.trim().replace(/^models\//, "") || DEFAULT_GEMINI_LIVE_MODEL;
  return /^[a-z0-9._-]+$/i.test(normalized) ? normalized : DEFAULT_GEMINI_LIVE_MODEL;
}

function normalizeVoice(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_GEMINI_LIVE_VOICE;
  return /^[a-z][a-z0-9_-]{0,63}$/i.test(normalized) ? normalized : DEFAULT_GEMINI_LIVE_VOICE;
}

function disableSearchGrounding(env: NodeJS.ProcessEnv): boolean {
  // Core audio must work on Gemini projects that do not have a paid Search
  // grounding quota. Search is therefore an explicit opt-in, while the older
  // disable flag remains an emergency override for existing deployments.
  const enabled = readBoolean(env.SENTIQ_LIVE_SEARCH_GROUNDING_ENABLED, false);
  const disabled = readBoolean(env.SENTIQ_LIVE_DISABLE_SEARCH_GROUNDING, false);
  return !enabled || disabled;
}

export function loadGeminiLiveConfig(env: NodeJS.ProcessEnv = process.env): GeminiLiveConfig {
  return {
    enabled: readBoolean(env.SENTIQ_LIVE_ENABLED, false),
    model: normalizeModel(env.SENTIQ_LIVE_MODEL),
    defaultVoice: normalizeVoice(env.SENTIQ_LIVE_DEFAULT_VOICE),
    sessionMaxSeconds: readSessionMaxSeconds(env.SENTIQ_LIVE_SESSION_MAX_SECONDS),
    audioOnly: readBoolean(env.SENTIQ_LIVE_AUDIO_ONLY, true),
    disableSearchGrounding: disableSearchGrounding(env),
    tokenUrl: GEMINI_LIVE_TOKEN_URL,
    webSocketUrl: GEMINI_LIVE_WEBSOCKET_URL,
  };
}
