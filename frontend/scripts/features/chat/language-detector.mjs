/**
 * Language Detector for SentIQ Chat
 * Browser-local, client-side English detection.
 * Strictly rejects non-English natural language text, including:
 * - Bengali script and Hindi script
 * - Romanized Bengali / Banglish (e.g. "Ami tomake bhalobashi", "Tumi kemon acho")
 * - Romanized Hindi (e.g. "Aap kaise hain", "Kya haal hai")
 * - Mixed language text containing non-English portions
 * - URLs, pure code blocks, short ambiguous snippets
 */

const NON_LATIN_SCRIPT_PATTERN = /[\u0980-\u09FF\u0900-\u097F\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/;

const BANGLISH_WORDS = new Set([
  "ami", "amra", "amader", "amar", "tumi", "tomra", "tomader", "tomar", "tomake", "amake",
  "apni", "apnara", "apnader", "apnar", "apnake", "shey", "tara", "tader", "uni", "unader",
  "kemon", "acho", "achen", "achi", "achis", "bhalo", "bhalobashi", "bhalobasi", "bhalobaso", "bhalobasen",
  "korcho", "korchen", "korbo", "korechi", "korte", "korchi", "kore", "korben", "korle", "koro", "korish",
  "hobe", "hoyeche", "hoiche", "hoye", "hocche", "hoche", "khub", "onek", "ekhon", "kokhon", "kothay", "kothaye",
  "keno", "kivabe", "kibhabe", "shathe", "sathe", "shob", "sob", "kintu", "aron", "tobe", "kono",
  "dekhe", "dekhi", "dekho", "dekhte", "bolche", "bolen", "bolte", "boli", "bolbo", "bolo",
  "jao", "jabo", "jacche", "asho", "ashbo", "ashchi", "asche", "ekta", "duto", "thako", "thaken", "thakbo",
  "bujhte", "bujhi", "bujhechi", "parbo", "parchi", "parbe", "dhoron", "shomporke", "somporke",
  "dhonnobad", "shagotom", "shuvo", "shokal", "ratre", "raat", "bondhu", "bhai", "bon", "khabar", "pani",
  "shudhu", "sudhu", "tai", "aar", "chilo", "chilen", "thakbe", "gechi", "geche", "lagbe", "chai",
  "oboshyo", "oboshwoi", "thik", "shotti", "sotti", "mithya", "shobai", "sobai", "kichu", "kokhono",
  "ghore", "bari", "shundor", "sundor", "kichui", "shokol", "shobcheye", "sobcheye"
]);

const ROMANIZED_HINDI_WORDS = new Set([
  "aap", "aapka", "aapke", "aapki", "tumhara", "tumhari", "tumhare", "hamara", "hamari", "hamare",
  "mera", "meri", "mere", "tera", "teri", "tere",
  "kya", "kyun", "kyu", "kaise", "kahan", "kaha", "kisko", "kiska", "kisne", "kaun",
  "nahi", "nahin", "hain", "hoon", "hun", "tha", "thi",
  "karna", "karo", "karta", "karti", "karte", "kiya", "kiye", "karenge", "karega", "karegi", "kijiye",
  "achha", "acha", "achhi", "achi", "achhe", "ache", "bahut", "bohot", "lekin", "magar", "bhi",
  "yeh", "woh", "batao", "bataiye", "samajh", "paas", "saath", "shukriya", "dhanyawad",
  "theek", "bolo", "boliye", "kripya", "chahiye", "sakte", "sakti", "sakta", "hoga", "hogi", "honge",
  "kuch", "sabse", "zaroorat", "samay", "namaste"
]);

const COMMON_ENGLISH_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for", "not", "on", "with",
  "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her",
  "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up",
  "out", "if", "about", "who", "get", "which", "go", "me", "when", "make", "can", "like", "time",
  "no", "just", "him", "know", "take", "people", "into", "year", "your", "good", "some", "could",
  "them", "see", "other", "than", "then", "now", "look", "only", "come", "its", "over", "think",
  "also", "back", "after", "use", "two", "how", "our", "work", "first", "well", "way", "even",
  "new", "want", "because", "any", "these", "give", "day", "most", "us", "is", "are", "was",
  "were", "been", "being", "has", "had", "does", "did", "doing", "shall", "should", "may",
  "might", "must", "here", "where", "why", "again", "further", "once", "such", "own", "same",
  "few", "more", "too", "very", "every", "both", "each", "down", "off", "above", "below",
  "under", "between", "through", "before", "during", "without", "always", "never", "please",
  "thank", "thanks", "hello", "hi", "welcome", "sure", "certainly", "help", "need", "read",
  "write", "code", "run", "file", "data", "test", "check", "system", "user", "page", "text",
  "show", "call", "send", "chat", "response", "message", "query", "answer", "result", "step",
  "steps", "guide", "note", "example", "using", "used", "create", "created", "find", "found",
  "based", "next", "last", "following", "provide", "provided", "provides", "support", "supported",
  "simple", "clean", "fast", "great", "better", "best", "high", "low", "long", "short", "large",
  "small", "different", "important", "problem", "issue", "case", "point", "part", "number",
  "group", "area", "fact", "world", "state", "true", "false", "value", "key", "name", "type",
  "line", "start", "end", "done", "still", "keep", "let", "much", "many", "real", "scalable",
  "reliable", "messaging", "terminal", "documentation", "easily", "customize", "customization",
  "configuration", "technical", "sentence", "standard", "explanation", "instruction", "settings",
  "panel", "solve", "additional", "command", "details", "complete", "open", "opening",
  "artificial", "intelligence", "transform", "transforming", "modern", "software", "engineer", "engineering",
  "workflow", "workflows", "plan", "planning", "log", "logging", "error", "optimize", "optimization",
  "query", "execution", "database", "index", "lifecycle", "cache", "policy", "solution", "section",
  "four", "helpful", "clear", "clearly", "information", "service", "process", "server", "client",
  "request", "method", "function", "feature", "build", "building", "project", "language", "learn",
  "model", "prompt", "token", "context", "history", "input", "output", "button", "screen", "window",
  "view", "table", "chart", "graph", "image", "sound", "voice", "audio", "video", "speech", "talk",
  "listen", "hear", "word", "paragraph", "format", "style", "color", "dark", "light", "mode", "card",
  "item", "list", "array", "object", "string", "save", "saving", "load", "loading", "fetch", "store",
  "sync", "refresh", "retry", "stop", "pause", "resume", "finish", "cancel", "close", "show", "hide",
  "toggle", "enable", "disable", "active", "inactive", "valid", "invalid", "ready", "busy", "idle"
]);

/**
 * Strips code blocks, URLs, markup and formatting so only the natural-language portion is analyzed.
 */
export function cleanNaturalLanguageText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/```[\s\S]*?```/g, " ")      // strip fenced code blocks
    .replace(/`[^`]+`/g, " ")             // strip inline code
    .replace(/https?:\/\/\S+/gi, " ")      // strip URLs
    .replace(/<[^>]+>/g, " ")              // strip HTML tags
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1") // markdown links -> text
    .replace(/[#*_~>|]/g, " ")            // strip markdown formatting characters
    .replace(/\s+/g, " ")                  // collapse whitespace
    .trim();
}

/**
 * Checks if text contains Bengali, Hindi (Devanagari), or other non-Latin scripts.
 */
export function containsNonLatinScript(text) {
  if (typeof text !== "string") return false;
  return NON_LATIN_SCRIPT_PATTERN.test(text);
}

/**
 * Checks if words contain romanized Bengali (Banglish) or Romanized Hindi markers.
 */
export function hasRomanizedMarkers(words) {
  if (!Array.isArray(words)) return false;
  for (const word of words) {
    if (BANGLISH_WORDS.has(word) || ROMANIZED_HINDI_WORDS.has(word)) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether the given text is confidently natural-language English.
 * Fails closed on short, ambiguous, mixed-language, Banglish, Hindi, or non-Latin text.
 *
 * @param {string} rawText The text to evaluate.
 * @returns {boolean} True only if confidently English.
 */
export function isConfidentEnglish(rawText) {
  if (typeof rawText !== "string") return false;

  // Immediate script rejection: if Bengali or Hindi script characters exist, reject
  if (containsNonLatinScript(rawText)) {
    return false;
  }

  // Extract clean natural language text
  const cleaned = cleanNaturalLanguageText(rawText);

  // If text is too short or empty after stripping code/URLs, fail closed
  if (cleaned.length < 15) {
    return false;
  }

  // Tokenize into natural words
  const words = cleaned.toLowerCase().match(/\b[a-z]+(?:'[a-z]+)?\b/g);
  if (!words || words.length < 3) {
    return false;
  }

  // Reject romanized Bengali (Banglish) or Hindi
  if (hasRomanizedMarkers(words)) {
    return false;
  }

  // Evaluate English word recognition density
  let englishCount = 0;
  for (const word of words) {
    if (COMMON_ENGLISH_WORDS.has(word)) {
      englishCount++;
    } else if (
      (word.endsWith("ing") && COMMON_ENGLISH_WORDS.has(word.slice(0, -3))) ||
      (word.endsWith("ed") && COMMON_ENGLISH_WORDS.has(word.slice(0, -2))) ||
      (word.endsWith("s") && COMMON_ENGLISH_WORDS.has(word.slice(0, -1))) ||
      (word.endsWith("es") && COMMON_ENGLISH_WORDS.has(word.slice(0, -2))) ||
      (word.endsWith("ly") && COMMON_ENGLISH_WORDS.has(word.slice(0, -2)))
    ) {
      englishCount++;
    }
  }

  const ratio = englishCount / words.length;

  // Fail closed: require at least 35% recognized English vocabulary and at least 2 recognized words
  return ratio >= 0.35 && englishCount >= 2;
}
