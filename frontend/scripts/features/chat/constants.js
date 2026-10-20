import "../welcome-composition.js";
import "../contextual-starter-actions.js";
import "../home-position-composer.js";
import "../advanced-liquid-composer.js";
import "../context-aware-composer.js";
import "../tool-action-sheet.js";
import "../attachment-context-surface.js";
import "../execution-mode-selector.js";
import "../free-tool-execution-policy.js";
import "../ui-stability.js";
import "../streaming-polish.js";
import "../controlled-response-polish.js";
import "../live/live-audio-visualizer.js";
import "../artifact-workspace.js";
import "../brand-polish.js";
import { STORAGE_KEYS, LEGACY_STORAGE_KEYS, FALLBACK_ACCOUNT_NAME } from "../../shared/brand.js";

export { FALLBACK_ACCOUNT_NAME };

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
  "How can I help{suffix}?",
  "What are you working on{suffix}?",
  "Where do you want to start{suffix}?",
  "What do you need{suffix}?",
];

export const COMPOSER_HINTS = [
  "summarizing an article",
  "planning a project",
  "checking a draft",
  "debugging an error",
  "comparing two options",
];