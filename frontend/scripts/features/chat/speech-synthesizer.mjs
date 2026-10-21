/**
 * Speech Synthesizer for SentIQ Chat
 * Browser-native speech synthesis using window.speechSynthesis and SpeechSynthesisUtterance.
 * Zero network requests, zero AI API keys, zero external TTS services.
 * All state is ephemeral in-memory and discarded on page refresh.
 */

let currentUtterance = null;
let currentActiveButton = null;
let currentSpokenText = "";
let currentCharIndex = 0;
let playbackState = "idle"; // "idle" | "playing" | "paused"
let activeUtteranceId = 0;
let utteranceCounter = 0;

let currentOnStart = null;
let currentOnPause = null;
let currentOnResume = null;
let currentOnEnd = null;
let currentOnError = null;
let currentOnStop = null;

/**
 * Checks whether Web Speech synthesis is available in the current browser.
 */
export function isSpeechSynthesisSupported() {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && typeof window.SpeechSynthesisUtterance === "function";
}

/**
 * Prepares natural language text for speech by stripping code blocks,
 * markup, and raw URLs.
 */
export function cleanTextForSpeech(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")      // omit code blocks
    .replace(/`[^`]+`/g, " ")             // omit inline code
    .replace(/https?:\/\/\S+/gi, " link ") // announce link instead of raw URL
    .replace(/<[^>]+>/g, " ")              // strip HTML tags
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1") // markdown links -> label
    .replace(/[*_~#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns current playback state: "idle" | "playing" | "paused"
 */
export function getPlaybackState() {
  return playbackState;
}

/**
 * Returns current character offset reached in speech.
 */
export function getCurrentCharIndex() {
  return currentCharIndex;
}

/**
 * Returns the currently active speech synthesis utterance, if any.
 */
export function getCurrentUtterance() {
  return currentUtterance;
}

/**
 * Returns the button associated with the active playback session, if any.
 */
export function getCurrentActiveButton() {
  return currentActiveButton;
}

/**
 * Pauses active speech playback without cancelling the utterance.
 * Preserves the current reading position.
 */
export function pauseSpeech() {
  if (playbackState !== "playing") return false;
  playbackState = "paused";
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      if (typeof window.speechSynthesis.pause === "function") {
        window.speechSynthesis.pause();
      }
    } catch {}
  }
  if (typeof currentOnPause === "function") {
    try {
      currentOnPause();
    } catch {}
  }
  return true;
}

/**
 * Resumes paused speech playback from the preserved position.
 */
export function resumeSpeech() {
  if (playbackState !== "paused") return false;
  playbackState = "playing";
  let resumed = false;
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      if (typeof window.speechSynthesis.resume === "function") {
        window.speechSynthesis.resume();
        resumed = true;
      }
    } catch {}
  }
  // Browser fallback: if native resume did not resume or dropped utterance while paused
  if (
    !resumed ||
    (typeof window !== "undefined" &&
      window.speechSynthesis &&
      !window.speechSynthesis.speaking &&
      !window.speechSynthesis.paused &&
      currentCharIndex < currentSpokenText.length)
  ) {
    const remainingText = currentSpokenText.slice(currentCharIndex);
    if (remainingText.trim()) {
      startUtterance(remainingText, currentCharIndex);
    }
  }
  if (typeof currentOnResume === "function") {
    try {
      currentOnResume();
    } catch {}
  }
  return true;
}

/**
 * Stops any active speech playback in the browser, cancels the utterance,
 * resets ephemeral state, and notifies listeners.
 */
export function stopCurrentSpeech() {
  activeUtteranceId = 0; // Invalidate any subsequent callbacks from cancelled utterance
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  const prevOnStop = currentOnStop;
  currentUtterance = null;
  currentActiveButton = null;
  currentSpokenText = "";
  currentCharIndex = 0;
  playbackState = "idle";
  currentOnStart = null;
  currentOnPause = null;
  currentOnResume = null;
  currentOnEnd = null;
  currentOnError = null;
  currentOnStop = null;

  if (typeof prevOnStop === "function") {
    try {
      prevOnStop();
    } catch {}
  }
}

function startUtterance(textToSpeak, baseOffset = 0) {
  let utterance;
  try {
    utterance = new window.SpeechSynthesisUtterance(textToSpeak);
  } catch {
    return false;
  }

  // Always English
  utterance.lang = "en-US";
  currentUtterance = utterance;
  playbackState = "playing";

  const utteranceId = ++utteranceCounter;
  activeUtteranceId = utteranceId;

  utterance.onboundary = (event) => {
    if (activeUtteranceId !== utteranceId) return;
    if (event && typeof event.charIndex === "number") {
      currentCharIndex = baseOffset + event.charIndex;
    }
  };

  utterance.onstart = () => {
    if (activeUtteranceId !== utteranceId) return;
    playbackState = "playing";
    if (currentOnStart) currentOnStart();
  };

  const cleanup = (isError = false, errorEvent = null) => {
    if (activeUtteranceId !== utteranceId) return;
    activeUtteranceId = 0;
    currentUtterance = null;
    currentActiveButton = null;
    currentSpokenText = "";
    currentCharIndex = 0;
    playbackState = "idle";

    const onDone = currentOnEnd;
    const onErr = currentOnError;
    currentOnStart = null;
    currentOnPause = null;
    currentOnResume = null;
    currentOnEnd = null;
    currentOnError = null;
    currentOnStop = null;

    if (isError && onErr) {
      onErr(errorEvent);
    } else if (!isError && onDone) {
      onDone();
    }
  };

  utterance.onend = () => {
    cleanup(false);
  };

  utterance.onerror = (event) => {
    cleanup(true, event);
  };

  try {
    window.speechSynthesis.speak(utterance);
    return true;
  } catch (err) {
    cleanup(true, err);
    return false;
  }
}

/**
 * Speaks the provided natural language text using the browser's native SpeechSynthesis.
 * Implements Play/Pause/Resume toggle if called on the already active button.
 *
 * @param {string} text Text to speak.
 * @param {Object} options Playback callbacks and associated button.
 * @returns {boolean} True if speech started, paused, or resumed; false otherwise.
 */
export function speakText(text, options = {}) {
  if (!isSpeechSynthesisSupported()) return false;

  const button = options.button || null;

  // Toggle pause/resume if user clicked the button that is already in playback
  if (currentActiveButton && currentActiveButton === button) {
    if (playbackState === "playing") {
      pauseSpeech();
      return true;
    } else if (playbackState === "paused") {
      resumeSpeech();
      return true;
    }
  }

  // Cancel any running speech on another message and start fresh
  stopCurrentSpeech();

  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  currentSpokenText = spokenText;
  currentCharIndex = 0;
  currentActiveButton = button;

  currentOnStart = typeof options.onStart === "function" ? options.onStart : null;
  currentOnPause = typeof options.onPause === "function" ? options.onPause : null;
  currentOnResume = typeof options.onResume === "function" ? options.onResume : null;
  currentOnEnd = typeof options.onEnd === "function" ? options.onEnd : null;
  currentOnError = typeof options.onError === "function" ? options.onError : null;
  currentOnStop = typeof options.onStop === "function" ? options.onStop : null;

  return startUtterance(spokenText, 0);
}
