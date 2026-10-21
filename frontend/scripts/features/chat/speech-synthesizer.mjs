/**
 * Speech Synthesizer for SentIQ Chat
 * Browser-native speech synthesis using window.speechSynthesis and SpeechSynthesisUtterance.
 * Zero network requests, zero AI API keys, zero external TTS services.
 */

let currentUtterance = null;
let currentActiveButton = null;
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
 * Stops any active speech playback in the browser and notifies listeners.
 */
export function stopCurrentSpeech() {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  if (typeof currentOnStop === "function") {
    try {
      currentOnStop();
    } catch {}
  }
  currentUtterance = null;
  currentActiveButton = null;
  currentOnStop = null;
}

/**
 * Returns the currently active speech synthesis utterance, if any.
 */
export function getCurrentUtterance() {
  return currentUtterance;
}

/**
 * Speaks the provided natural language text using the browser's native SpeechSynthesis.
 * Cancels any active utterance before starting.
 *
 * @param {string} text Text to speak.
 * @param {Object} options Playback callbacks and associated button.
 * @returns {boolean} True if speech started, false otherwise.
 */
export function speakText(text, options = {}) {
  if (!isSpeechSynthesisSupported()) return false;

  const button = options.button || null;
  const onStart = typeof options.onStart === "function" ? options.onStart : null;
  const onEnd = typeof options.onEnd === "function" ? options.onEnd : null;
  const onError = typeof options.onError === "function" ? options.onError : null;

  // Toggle stop if user clicked the button that is already playing
  if (currentActiveButton && currentActiveButton === button) {
    stopCurrentSpeech();
    return false;
  }

  // Cancel any running speech on another message
  stopCurrentSpeech();

  const spokenText = cleanTextForSpeech(text);
  if (!spokenText) return false;

  let utterance;
  try {
    utterance = new window.SpeechSynthesisUtterance(spokenText);
  } catch {
    return false;
  }

  // Always English
  utterance.lang = "en-US";

  currentUtterance = utterance;
  currentActiveButton = button;

  const cleanup = (isError = false, errorEvent = null) => {
    if (currentUtterance === utterance) {
      currentUtterance = null;
      currentActiveButton = null;
      currentOnStop = null;
      if (isError && onError) {
        onError(errorEvent);
      } else if (onEnd) {
        onEnd();
      }
    }
  };

  currentOnStop = () => cleanup(false);

  utterance.onstart = () => {
    if (onStart) onStart();
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
