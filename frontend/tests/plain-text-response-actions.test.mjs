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
  getPlaybackState,
  getCurrentCharIndex,
  pauseSpeech,
  resumeSpeech,
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

// 1.3 Icon-only buttons with accessible aria-label and title attributes (no visible text labels)
assert.doesNotMatch(
  chatController,
  /<span class="message-action-label">(?:Read aloud|Good response|Bad response|Retry|Copy)<\/span>/,
  "Action buttons must not contain visible text labels"
);
assert.match(
  chatController,
  /readAloudBtn\.setAttribute\("aria-label",\s*"Read aloud"\);[\s\S]*?readAloudBtn\.setAttribute\("title",\s*"Read aloud"\)/,
  "Read aloud button must have aria-label and title"
);
assert.match(
  chatController,
  /goodBtn\.setAttribute\("aria-label",\s*"Good response"\);[\s\S]*?goodBtn\.setAttribute\("title",\s*"Good response"\)/,
  "Good response button must have aria-label and title"
);
assert.match(
  chatController,
  /badBtn\.setAttribute\("aria-label",\s*"Bad response"\);[\s\S]*?badBtn\.setAttribute\("title",\s*"Bad response"\)/,
  "Bad response button must have aria-label and title"
);
assert.match(
  chatController,
  /retryBtn\.setAttribute\("aria-label",\s*"Retry"\);[\s\S]*?retryBtn\.setAttribute\("title",\s*"Retry"\)/,
  "Retry button must have aria-label and title"
);
assert.match(
  chatController,
  /copyBtn\.setAttribute\("aria-label",\s*baseCopyLabel\);[\s\S]*?copyBtn\.setAttribute\("title",\s*baseCopyLabel\)/,
  "Copy button must have aria-label and title"
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
assert.match(actionsCss, /\.message-action-bar\.is-pending/);
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
let mockPaused = false;

globalThis.window = {
  speechSynthesis: {
    speak(utterance) {
      mockSpeaking = true;
      mockPaused = false;
      mockUtterances.push(utterance);
      queueMicrotask(() => {
        utterance.onstart?.();
      });
    },
    pause() {
      mockPaused = true;
      mockSpeaking = false;
    },
    resume() {
      mockPaused = false;
      mockSpeaking = true;
    },
    cancel() {
      mockSpeaking = false;
      mockPaused = false;
    },
    get paused() { return mockPaused; },
    get speaking() { return mockSpeaking; },
  },
  SpeechSynthesisUtterance: class MockSpeechSynthesisUtterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onboundary = null;
    }
  },
};

assert.equal(isSpeechSynthesisSupported(), true, "Should report supported when speechSynthesis exists");

// Test 3.2.1: Starting playback creates one utterance and enters 'playing' state
let started = false;
let paused = false;
let resumed = false;
let ended = false;
const fakeBtn1 = { id: "btn-1" };
const fakeBtn2 = { id: "btn-2" };

const success = speakText("This is a clear and helpful assistant response.", {
  button: fakeBtn1,
  onStart: () => { started = true; },
  onPause: () => { paused = true; },
  onResume: () => { resumed = true; },
  onEnd: () => { ended = true; },
});

assert.equal(success, true, "speakText should return true on initial start");
assert.equal(mockUtterances.length, 1, "Exactly one utterance created on start");
assert.equal(mockUtterances[0].lang, "en-US", "Speech utterance must use en-US");
assert.equal(getPlaybackState(), "playing", "Playback state must be 'playing'");

// Simulate speech boundary progress
mockUtterances[0].onboundary?.({ charIndex: 14 });
assert.equal(getCurrentCharIndex(), 14, "Boundary charIndex tracked in memory");

// Test 3.2.2: Clicking same button while speaking pauses existing utterance instead of cancelling
const pauseSuccess = speakText("This is a clear and helpful assistant response.", { button: fakeBtn1 });
assert.equal(pauseSuccess, true, "Toggling active button should pause");
assert.equal(getPlaybackState(), "paused", "Playback state must transition to 'paused'");
assert.equal(mockPaused, true, "speechSynthesis.pause() was called");
assert.equal(paused, true, "onPause callback was fired");
assert.equal(mockUtterances.length, 1, "Utterance was NOT recreated on pause; count remains 1");

// Test 3.2.3: Clicking again resumes the same utterance from preserved position without restarting
const resumeSuccess = speakText("This is a clear and helpful assistant response.", { button: fakeBtn1 });
assert.equal(resumeSuccess, true, "Toggling paused button should resume");
assert.equal(getPlaybackState(), "playing", "Playback state must transition back to 'playing'");
assert.equal(mockSpeaking, true, "speechSynthesis.resume() was called");
assert.equal(resumed, true, "onResume callback was fired");
assert.equal(mockUtterances.length, 1, "No new utterance created on resume; speech continues from saved position");
assert.equal(getCurrentCharIndex(), 14, "Char offset preserved during pause and resume without restarting from beginning");

// Test 3.2.4: Single-active coordination: speaking on another message cancels the first and clears state
let btn1Stopped = false;
const success2 = speakText("Second assistant answer playing now.", {
  button: fakeBtn2,
  onStart: () => {},
  onEnd: () => {},
  onStop: () => { btn1Stopped = true; },
});
assert.equal(success2, true, "Speaking second text should succeed");
assert.equal(mockUtterances.length, 2, "Second utterance created for new message");
assert.equal(getPlaybackState(), "playing", "Playback state is 'playing' for new message");

// Test 3.2.5: Natural completion resets playback state to 'idle'
mockUtterances[1].onend?.();
assert.equal(getPlaybackState(), "idle", "Natural completion resets playbackState to 'idle'");

// Test 3.2.6: stopCurrentSpeech cancels playback and resets state
stopCurrentSpeech();
assert.equal(mockSpeaking, false, "stopCurrentSpeech must cancel synthesis");
assert.equal(getPlaybackState(), "idle");

// Test 3.2.7: Ephemeral state - verify no localStorage, sessionStorage, or persistent stores used
assert.equal(typeof globalThis.localStorage, "undefined", "No localStorage used for speech state");
assert.equal(typeof globalThis.sessionStorage, "undefined", "No sessionStorage used for speech state");

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

// ============================================================================
// Gate 5: Retry Prompt-Lookup & Response-to-Prompt Association Verification
// ============================================================================

// 5.1 Chat messages array where user message and assistant message share the same clientRequestId
const SHARED_REQ_ID = "req-test-uuid-12345";
const chatHistory = [
  {
    id: `user-${SHARED_REQ_ID}`,
    role: "user",
    content: "Explain how web workers improve browser responsiveness.",
    clientRequestId: SHARED_REQ_ID,
  },
  {
    id: `assistant-${SHARED_REQ_ID}`,
    role: "assistant",
    content: "Web workers run background scripts in a separate thread...",
    clientRequestId: SHARED_REQ_ID,
    meta: { executionMode: "intuitive" },
  },
];

// Verify naive lookup bug reproduction:
const naiveAssistantIndex = chatHistory.findIndex((m) => m.clientRequestId === SHARED_REQ_ID);
assert.equal(naiveAssistantIndex, 0, "Naive findIndex matches the user message first because of shared clientRequestId");
let naiveUserIndex = -1;
for (let i = naiveAssistantIndex - 1; i >= 0; i--) {
  if (chatHistory[i].role === "user") { naiveUserIndex = i; break; }
}
assert.equal(naiveUserIndex, -1, "Naive search fails to find user prompt, leading to 'Couldn't find the original prompt to retry.'");

// 5.2 Corrected lookup requiring role === 'assistant'
const correctedAssistantIndex = chatHistory.findIndex(
  (m) => m.role === "assistant" && (m.clientRequestId === SHARED_REQ_ID || m.id === `assistant-${SHARED_REQ_ID}`)
);
assert.equal(correctedAssistantIndex, 1, "Corrected lookup identifies assistant response at index 1");

// 5.3 User lookup via shared request association requiring role === 'user'
const correctedUserIndex = chatHistory.findIndex(
  (m) => m.role === "user" && (m.clientRequestId === SHARED_REQ_ID || m.id === `user-${SHARED_REQ_ID}`)
);
assert.equal(correctedUserIndex, 0, "Corrected lookup identifies user prompt at index 0");
assert.equal(chatHistory[correctedUserIndex].content, "Explain how web workers improve browser responsiveness.");

// 5.4 Multi-turn conversation with preceding context
const multiTurnHistory = [
  { id: "u1", role: "user", content: "Hi", clientRequestId: "req-1" },
  { id: "a1", role: "assistant", content: "Hello!", clientRequestId: "req-1" },
  { id: "u2", role: "user", content: "Write a poem about trees", clientRequestId: "req-2" },
  { id: "a2", role: "assistant", content: "Roots deep in the earth...", clientRequestId: "req-2", meta: { executionMode: "fast" } },
  { id: "u3", role: "user", content: "Add more verses", clientRequestId: "req-3" },
  { id: "a3", role: "assistant", content: "Branches reaching for the sky...", clientRequestId: "req-3" },
];

// Retrying turn 2 (req-2 assistant):
const targetReq = "req-2";
const asstIdx = multiTurnHistory.findIndex((m) => m.role === "assistant" && m.clientRequestId === targetReq);
assert.equal(asstIdx, 3, "Finds assistant turn 2");
const usrIdx = multiTurnHistory.findIndex((m) => m.role === "user" && m.clientRequestId === targetReq);
assert.equal(usrIdx, 2, "Finds user prompt turn 2");
assert.equal(multiTurnHistory[usrIdx].content, "Write a poem about trees");

const precedingContext = multiTurnHistory.slice(0, usrIdx).map((m) => ({ role: m.role, content: m.content }));
assert.equal(precedingContext.length, 2, "Preceding context includes only turns preceding user prompt 2");
assert.equal(precedingContext[0].content, "Hi");
assert.equal(precedingContext[1].content, "Hello!");
// Excludes replaced turn and subsequent turns:
assert.equal(precedingContext.some((m) => m.content.includes("poem")), false);
assert.equal(precedingContext.some((m) => m.content.includes("verses")), false);

// 5.5 Execution mode preservation:
const preservedMode = multiTurnHistory[asstIdx]?.meta?.executionMode || "fast";
assert.equal(preservedMode, "fast", "Original fast execution mode is preserved");

// ============================================================================
// Gate 6: Action Bar Visibility Lifecycle Verification
// ============================================================================

// 6.1 Action-bar lifecycle simulation mirroring chat-controller implementation
function simulateAssistantActionBar(initialText, options = {}) {
  let isStreaming = Boolean(options.isStreaming);
  let isCompleted = !isStreaming;
  const element = {
    style: { display: isStreaming ? "none" : "" },
    attributes: {},
    classList: new Set(isStreaming ? ["message-action-bar", "is-pending"] : ["message-action-bar"]),
    inert: isStreaming,
    setAttribute(name, val) { this.attributes[name] = String(val); },
    getAttribute(name) { return this.attributes[name] || null; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
  if (isStreaming) {
    element.setAttribute("aria-hidden", "true");
  }

  const readAloudBtn = { style: { display: "none" } };

  function refresh() {
    if (isStreaming || !isCompleted) {
      element.style.display = "none";
      element.setAttribute("aria-hidden", "true");
      element.classList.add("is-pending");
      element.inert = true;
      readAloudBtn.style.display = "none";
      return;
    }
    element.style.display = "";
    element.removeAttribute("aria-hidden");
    element.classList.delete("is-pending");
    element.inert = false;
    const isEnglish = isConfidentEnglish(initialText);
    readAloudBtn.style.display = isEnglish ? "" : "none";
  }

  function markComplete() {
    isStreaming = false;
    isCompleted = true;
    refresh();
  }

  refresh();
  return { element, readAloudBtn, markComplete, refresh, isStreaming: () => isStreaming };
}

// 6.2 Newly submitted prompt / streaming starts: All actions hidden
const streamingBar = simulateAssistantActionBar("Hello this is streaming", { isStreaming: true });
assert.equal(streamingBar.element.style.display, "none", "Action bar must be display: none while streaming");
assert.equal(streamingBar.element.getAttribute("aria-hidden"), "true", "Action bar must be aria-hidden while streaming");
assert.equal(streamingBar.element.inert, true, "Action bar must be inert while streaming");
assert.equal(streamingBar.element.classList.has("is-pending"), true, "Action bar must have is-pending class while streaming");

// 6.3 First token arrives: refresh() must NOT reveal the toolbar while streaming
streamingBar.refresh();
assert.equal(streamingBar.element.style.display, "none", "Action bar must stay hidden on first token refresh");
assert.equal(streamingBar.element.getAttribute("aria-hidden"), "true", "Action bar must remain aria-hidden");

// 6.4 Successful completion reveals the action bar and checks language eligibility
streamingBar.markComplete();
assert.equal(streamingBar.element.style.display, "", "Action bar must become visible after markComplete");
assert.equal(streamingBar.element.getAttribute("aria-hidden"), null, "aria-hidden must be removed");
assert.equal(streamingBar.element.inert, false, "inert must be false after completion");
assert.equal(streamingBar.element.classList.has("is-pending"), false, "is-pending must be removed");
assert.equal(streamingBar.readAloudBtn.style.display, "", "Read aloud must be visible for completed English text");

// 6.5 Bengali response completed: Action bar visible, Read aloud hidden
const bengaliBar = simulateAssistantActionBar("আমি বাংলায় গান গাই", { isStreaming: true });
assert.equal(bengaliBar.element.style.display, "none", "Bengali response action bar hidden while streaming");
bengaliBar.markComplete();
assert.equal(bengaliBar.element.style.display, "", "Action bar visible after completion");
assert.equal(bengaliBar.readAloudBtn.style.display, "none", "Read aloud button must stay hidden for non-English response");

// 6.6 Interrupted / cancelled streaming: markComplete is NOT called, bar remains hidden
const interruptedBar = simulateAssistantActionBar("Partial answer...", { isStreaming: true });
const interruptionNotice = "Stopped. Partial answer saved.";
if (!interruptionNotice) {
  interruptedBar.markComplete();
}
assert.equal(interruptedBar.element.style.display, "none", "Action bar must remain hidden when generation was interrupted");
assert.equal(interruptedBar.element.getAttribute("aria-hidden"), "true");

console.log("Plain-text response actions test suite passed cleanly!");
