import { STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "../../shared/brand.js";

export const DEFAULT_IMAGE_ANALYSIS_PROMPT = "Analyze this image. Describe what it shows, read any visible text, and explain any important details.";

export const CHART_REQUEST_PATTERNS = [
  /\bscatter\s*(?:plot|chart|graph)\b/i,
  /\bbar\s*(?:chart|graph|plot)\b/i,
  /\bline\s*(?:graph|chart|plot)\b/i,
  /\bpie\s*(?:chart|graph|plot)\b/i,
  /\bhistogram\b/i,
  /\bheat\s*map\b/i,
  /\bbox\s*(?:plot|chart)\b/i,
  /\bregression\s*(?:plot|line|chart)\b/i,
  /\bpca\s*(?:plot|chart)\b/i,
  /\bcluster(?:ing)?\s*(?:plot|visualization|chart)\b/i,
  /\btime[\s-]?series\s*(?:plot|chart|graph)\b/i,
  /\bdistribution\s*(?:plot|chart|graph)\b/i,
];

export const CHART_ACTION_PATTERNS = [
  /\b(?:generate|create|show|make|plot|visualize|visualise|draw)\b[\s\S]{0,80}\b(?:chart|graph|plot|visualization)\b/i,
  /\b(?:chart|graph|plot|visualization)\b[\s\S]{0,40}\b(?:for|of|with|showing)\b/i,
];

export const CHART_DATA_CONTEXT_PATTERNS = [
  /\bdata(?:set)?\s+visuali[sz]ation\b/i,
  /\bvisuali[sz]e\s+(?:the\s+)?(?:data|dataset|results?|distribution|trend|metrics?)\b/i,
  /\b(?:data|dataset|results?|distribution|trend|metrics?)\b[\s\S]{0,40}\b(?:chart|graph|plot|visualization)\b/i,
];

export const CODING_BUILD_GUARD_PATTERNS = [
  /\b(?:code|build|create|develop)\b/i,
  /\bdesign\s+and\s+build\b/i,
  /\b(?:html\s+page|website|portfolio|landing\s+page|app|component|ui|ux|hero\s+section)\b/i,
  /\b(?:next\.js|react|tailwind|gsap|framer\s+motion|three\.js|typescript)\b/i,
];

export const SELECTION_BUTTON_ID = "selection-ask-button";
export const MAX_SELECTION_LINES = 3;
export const MAX_SELECTION_CONTEXT_LINES = 3;

export const SYNC_JOB_TYPES = {
  chatCreate: "chat_create",
  chatMessage: "chat_message",
  chatDelete: "chat_delete",
  chatTitle: "chat_title",
  memoryDelete: "memory_delete",
};

export const MEMORY_SYNC_STALE_MS = 60 * 1000;
export const WELCOME_GREETING_STORAGE_PREFIX = STORAGE_KEYS.greetingIndexPrefix;
export const LEGACY_WELCOME_GREETING_STORAGE_PREFIX = LEGACY_STORAGE_KEYS.greetingIndexPrefix;

export const WELCOME_GREETINGS = [
  "Ready when you are{suffix}.",
  "Good to see you{suffix}.",
  "Let's pick up where you left off{suffix}.",
  "What should we work through today{suffix}?",
  "I'm here whenever you're ready{suffix}.",
  "Let's make progress on it{suffix}.",
  "What's on your mind today{suffix}?",
  "Happy to help you sort through it{suffix}.",
  "Let's get into it{suffix}.",
  "Where do you want to start{suffix}?",
  "Let's untangle it together{suffix}.",
  "I'm ready for the next thing{suffix}.",
];

export const COMPOSER_HINTS = [
  "summarizing a dense article",
  "planning a cleaner backend route",
  "researching what changed this week",
  "turning rough notes into a brief",
  "spotting edge cases in a feature",
];
