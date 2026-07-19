import "../welcome-composition.js";
import "../contextual-starter-actions.js";
import "../home-position-composer.js";
import "../advanced-liquid-composer.js";
import "../context-aware-composer.js";
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS } from "../../shared/brand.js";

export const DEFAULT_IMAGE_ANALYSIS_PROMPT = "Analyze this image. Describe what it shows, read any visible text, and explain any important details.";

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
