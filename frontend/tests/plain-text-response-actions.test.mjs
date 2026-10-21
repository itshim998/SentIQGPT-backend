import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isConfidentEnglish,
  containsNonLatinScript,
  hasRomanizedMarkers,
  cleanNaturalLanguageText,
} from "../scripts/features/chat/language-detector.mjs";

import {
  cleanTextForSpeech,
  isSpeechSynthesisSupported,
  speakText,
  stopCurrentSpeech,
} from "../scripts/features/chat/speech-synthesizer.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const chatController = readFileSync(resolve(root, "frontend/scripts/features/chat-controller.js"), "utf8");
const actionsCss = readFileSync(resolve(root, "frontend/styles/modules/33-message-actions.css"), "utf8");
const indexHtml = readFileSync(resolve(root, "frontend/index.html"), "utf8");

// ============================================================================
// Gate 1: Contract & Integrity Verifications
// ============================================================================

// 1.1 Preserve data-execution-menu="v2" in frontend/index.html
assert.match(
  indexHtml,
  /data-execution-menu="v2"/,
  "frontend/index.html must preserve data-execution-menu=\"v2\""
);

// 1.2 Verify 5 actions exist in chat-controller in exact order
assert.match(
  chatController,
  /readAloudBtn[\s\S]*goodBtn[\s\S]*badBtn[\s\S]*retryBtn[\s\S]*copyBtn/,
  "Action buttons must be created in exact order: Read aloud, Good response, Bad response, Retry, Copy"
);

// 1.3 Exact visible labels for Good response and Bad response
assert.match(
  chatController,
  /<span class="message-action-label">Good response<\/span>/,
  "Good response button must have exact visible text 'Good response'"
);
assert.match(
  chatController,
  /<span class="message-action-label">Bad response<\/span>/,
  "Bad response button must have exact visible text 'Bad response'"
);

// 1.4 Mutual exclusivity and aria-pressed attributes
assert.match(
  chatController,
  /feedbackState\s*===\s*"good"\s*\?\s*null\s*:\s*"good"/,
  "Good feedback must toggle and be mutually exclusive"
);
assert.match(
  chatController,
  /feedbackState\s*===\s*"bad"\s*\?\s*null\s*:\s*"bad"/,
  "Bad feedback must toggle and be mutually exclusive"
);
assert.match(
  chatController,
  /goodBtn\.setAttribute\("aria-pressed",\s*isGood\s*\?\s*"true"\s*:\s*"false"\)/,
  "Good response button must manage aria-pressed attribute"
);
assert.match(
  chatController,
  /badBtn\.setAttribute\("aria-pressed",\s*isBad\s*\?\s*"true"\s*:\s*"false"\)/,
  "Bad response button must manage aria-pressed attribute"
);

// 1.5 Client-side only feedback (no backend telemetry or fake endpoints)
assert.doesNotMatch(
  chatController,
  /\/api\/feedback|\/api\/messages\/.*\/feedback|submitFeedback|sendFeedback/,
  "Feedback must remain client-side only without inventing backend endpoints"
);

// 1.6 Exact original prompt reuse (no synthetic expansion or prefixing)
assert.match(
  chatController,
  /const originalPrompt = userMessage\.content;/,
  "Retry must retrieve the exact user prompt without alterations"
);
assert.doesNotMatch(
  chatController,
  /originalPrompt\s*=\s*`Please try again|originalPrompt\s*=\s*"Please retry|originalPrompt\s*=\s*`Retry:/,
  "Retry must never prepend or modify the original prompt"
);

// 1.7 Preceding context isolation (excludes answer being retried and subsequent turns)
assert.match(
  chatController,
  /const precedingContext = messages\.slice\(0,\s*userIndex\)\.map/,
  "Retry context must slice up to userIndex, excluding replaced turn and subsequent turns"
);

// 1.8 In-place message replacement in storage
assert.match(
  chatController,
  /replaceLocalChatMessage\(\s*targetChatId,\s*options\.targetAssistantMessage\.id,\s*options\.targetAssistantIndex/,
  "Retry must replace assistant message in place in storage"
);

// 1.9 Route retry through existing Standard/Lite quota pathway
assert.match(
  chatController,
  /await handleSend\(originalPrompt,\s*\{\s*isRetry:\s*true/,
  "Retry must route through handleSend with isRetry: true"
);

// 1.10 Preserving executionMode across retries
assert.match(
  chatController,
  /originalExecutionMode\s*=\s*assistantMessage\?\.meta\?\.executionMode[\s\S]*executionMode:\s*originalExecutionMode/,
  "Retry must preserve the original turn's execution mode"
);

// 1.11 Fallback and rollback on retry failure or quota rejection
assert.match(
  chatController,
  /if\s*\(options\.isRetry\s*&&\s*options\.targetAssistantBubble\)\s*\{[\s\S]*options\.targetAssistantBubble\.style\.display\s*=\s*"";[\s\S]*resetRetryButton/,
  "On retry failure, target assistant bubble must be restored and reset"
);

// 1.12 Speech termination on retry
assert.match(
  chatController,
  /async function retryAssistantMessage\([\s\S]*?stopCurrentSpeech\(\);/,
  "Active speech must stop immediately when retry is triggered"
);

// 1.13 CSS rules for message action bar
assert.match(actionsCss, /\.message-action-bar\s*\{/);
assert.match(actionsCss, /\.message-feedback-good\.is-active/);
assert.match(actionsCss, /\.message-feedback-bad\.is-active/);
assert.match(actionsCss, /\.message-read-aloud-btn\.is-speaking/);
assert.match(actionsCss, /\.message-action-btn\.is-loading svg/);
assert.match(actionsCss, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(actionsCss, /@media \(forced-colors: active\)/);

// ============================================================================
// Gate 2: Language Detector Verification (Fail-Closed Policy)
// ============================================================================

// Standard English
assert.equal(isConfidentEnglish("Artificial intelligence is transforming modern software engineering workflows."), true);
assert.equal(isConfidentEnglish("Please check the following error log and optimize the query execution plan."), true);
assert.equal(isConfidentEnglish("Here is the solution to your issue:\n```javascript\nconst x = 42;\n```\nHope this helps!"), true);
assert.equal(isConfidentEnglish("For documentation, visit https://example.com/docs and review section four."), true);

// Bengali script - Must fail closed
assert.equal(isConfidentEnglish("আমি তোমাকে ভালোবাসি।"), false);
assert.equal(isConfidentEnglish("আজকে আবহাওয়া কেমন?"), false);
assert.equal(containsNonLatinScript("আমি বাংলায় গান গাই"), true);

// Hindi script - Must fail closed
assert.equal(isConfidentEnglish("नमस्ते, आप कैसे हैं? सब कुशल मंगल?"), false);
assert.equal(isConfidentEnglish("यह एक हिंदी वाक्य है।"), false);
assert.equal(containsNonLatinScript("नमस्ते"), true);

// Banglish (Romanized Bengali) - Must fail closed
assert.equal(isConfidentEnglish("Ami tomake bhalobashi"), false);
assert.equal(isConfidentEnglish("Tumi kemon acho bondhu"), false);
assert.equal(isConfidentEnglish("Amar sonar bangla ami tomay bhalobashi"), false);
assert.equal(isConfidentEnglish("Kobe ashbe tumi?"), false);
assert.equal(hasRomanizedMarkers(["ami", "tomake", "bhalobashi"]), true);

// Romanized Hindi - Must fail closed
assert.equal(isConfidentEnglish("kya haal hai bhai"), false);
assert.equal(isConfidentEnglish("tum kaise ho"), false);
assert.equal(isConfidentEnglish("mujhe yeh samajh nahi aaya"), false);
assert.equal(hasRomanizedMarkers(["kya", "haal", "hai"]), true);

// Pure code, raw URLs, and short ambiguous strings - Must fail closed
assert.equal(isConfidentEnglish("```python\nimport sys\nprint(sys.version)\n```"), false);
assert.equal(isConfidentEnglish("https://github.com/itshim998/SentIQGPT-backend"), false);
assert.equal(isConfidentEnglish("Ok"), false);
assert.equal(isConfidentEnglish("Yes"), false);
assert.equal(isConfidentEnglish("Hi"), false);

// ============================================================================
// Gate 3: Speech Synthesizer Verification
// ============================================================================

// 3.1 Text cleaning for speech
const rawTextWithCode = "Run `npm start` to launch.\n```bash\nnode index.js\n```\nCheck https://example.com for info.";
const cleaned = cleanTextForSpeech(rawTextWithCode);
assert.equal(cleaned.includes("node index.js"), false, "Code blocks must be stripped from spoken text");
assert.equal(cleaned.includes("https://example.com"), false, "Raw URLs must be replaced with 'link'");
assert.equal(cleaned.includes("link"), true, "URLs should be announced as link");
assert.equal(cleaned.includes("Run to launch."), true, "Natural language surrounding code must be retained");

// 3.2 Mock window.speechSynthesis to test speech synthesis state machine
const mockUtterances = [];
let mockSpeaking = false;

globalThis.window = {
  speechSynthesis: {
    speak(utterance) {
      mockSpeaking = true;
      mockUtterances.push(utterance);
      queueMicrotask(() => {
        utterance.onstart?.();
      });
    },
    cancel() {
      mockSpeaking = false;
    },
  },
  SpeechSynthesisUtterance: class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
    }
  },
};

assert.equal(isSpeechSynthesisSupported(), true, "Should report supported when speechSynthesis exists");

// Test speech playback lifecycle
let started = false;
let ended = false;
const fakeBtn1 = { id: "btn-1" };
const fakeBtn2 = { id: "btn-2" };

const success = speakText("This is a clear and helpful assistant response.", {
  button: fakeBtn1,
  onStart: () => { started = true; },
  onEnd: () => { ended = true; },
});

assert.equal(success, true, "speakText should return true");
assert.equal(mockUtterances.length, 1);
assert.equal(mockUtterances[0].lang, "en-US", "Speech utterance must use en-US");

// Single-active coordination: speaking on another message cancels the first
let btn1Reset = false;
const success2 = speakText("Second assistant answer playing now.", {
  button: fakeBtn2,
  onStart: () => {},
  onEnd: () => {},
});
assert.equal(success2, true, "Speaking second text should succeed");
assert.equal(mockUtterances.length, 2);

// stopCurrentSpeech cancels playback
stopCurrentSpeech();
assert.equal(mockSpeaking, false, "stopCurrentSpeech must cancel synthesis");

// Unsupported browser fallback
delete globalThis.window.speechSynthesis;
assert.equal(isSpeechSynthesisSupported(), false, "Should report unsupported when speechSynthesis is missing");
assert.equal(speakText("Hello"), false, "speakText must fail gracefully when unsupported");

// Clean up globals
delete globalThis.window;

// ============================================================================
// Gate 4: Specialized Surfaces Isolation Check
// ============================================================================

// 4.1 In deliverAssistantResponse, verify specialized types don't receive plainTextEligible: true
assert.match(
  chatController,
  /response\?\.route\s*===\s*"file_generation"[\s\S]*?appendMessageBubble\("assistant",\s*assistantText,\s*fileMeta/,
  "File generation responses must render fileMeta without plainTextEligible tag"
);
assert.match(
  chatController,
  /if\s*\(webSurfV2\)\s*\{[\s\S]*?appendMessageBubble\("assistant",\s*assistantText,\s*webSurfMeta/,
  "WebSurf responses must render webSurfMeta without plainTextEligible tag"
);
assert.match(
  chatController,
  /if\s*\(hasRenderableChart\(chartMeta\)\)\s*\{[\s\S]*?appendMessageBubble\("assistant",\s*assistantText,\s*chartMeta/,
  "Chart responses must render chartMeta without plainTextEligible tag"
);
assert.match(
  chatController,
  /if\s*\(\(response\?\.route\s*===\s*"image_generation"[\s\S]*?appendMessageBubble\("assistant",\s*assistantText,\s*imageMeta/,
  "Image responses must render imageMeta without plainTextEligible tag"
);

// 4.2 In deliverAssistantResponse, verify ordinary text responses receive plainTextEligible: true
assert.match(
  chatController,
  /appendMessageBubble\("assistant",\s*"",\s*\{\s*type:\s*"text",\s*plainTextEligible:\s*true,/,
  "Ordinary text responses must explicitly set plainTextEligible: true"
);

// 4.3 In createAssistantActionBar, non-plain-text surfaces strip the 4 new action buttons
assert.match(
  chatController,
  /if\s*\(!isPlainTextEligible\)\s*\{[\s\S]*?readAloudBtn\.remove\(\);[\s\S]*?goodBtn\.remove\(\);[\s\S]*?badBtn\.remove\(\);[\s\S]*?retryBtn\.remove\(\);/,
  "When message is not plain-text eligible, readAloud, good, bad, and retry buttons must be removed"
);

console.log("Plain-text response actions test suite passed cleanly!");
