// SentIQ Chat v2 — Query Expander
//
// Generates 3-5 variations of a user query to improve search coverage.
// Variations include:
//   - Original query (cleaned)
//   - More specific version
//   - Broader version
//   - Time-aware version (if applicable)
//
// Deterministic (pattern-based) — no LLM calls required.

// ==============================
// Configuration
// ==============================

const MIN_EXPANSIONS = 3;
const MAX_EXPANSIONS = 5;
const CURRENT_YEAR = new Date().getFullYear();

// ==============================
// Stopwords for query analysis
// ==============================

const STOPWORDS = new Set([
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "is", "are", "was", "were", "be", "been", "being",
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
  "for", "of", "with", "by", "from", "as", "into", "about",
  "that", "this", "these", "those", "it", "its",
  "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "has", "have", "had", "shall",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "tell", "explain", "list", "please", "give", "show", "describe",
]);

// ==============================
// Time-sensitive patterns
// ==============================

const TIME_SENSITIVE_PATTERNS = [
  /\b(?:latest|recent|new|current|today|now|update|announcement|news|release|launch)\b/i,
  /\b(?:trend|trending|popular|hot|viral)\b/i,
  /\b(?:stock|price|market|score|result|weather)\b/i,
  /\b(?:election|championship|tournament|event)\b/i,
  /\b20\d{2}\b/, // Year mentions
];

// ==============================
// Query Type Detection
// ==============================

interface QueryAnalysis {
  originalQuery: string;
  keywords: string[];
  isTimeSensitive: boolean;
  hasYear: boolean;
  extractedYear?: number;
  isQuestionFormat: boolean;
  mainTopic: string;
}

function analyzeQuery(query: string): QueryAnalysis {
  const cleaned = query.trim();
  const tokens = cleaned
    .replace(/[?!.,;:'"()\[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const keywords = tokens.filter(
    (t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 2
  );

  const isTimeSensitive = TIME_SENSITIVE_PATTERNS.some((p) => p.test(cleaned));
  const yearMatch = cleaned.match(/\b(20\d{2})\b/);
  const hasYear = !!yearMatch;
  const extractedYear = yearMatch ? parseInt(yearMatch[1], 10) : undefined;
  const isQuestionFormat = /^(?:what|who|how|why|when|where|which|is|are|can|do|does)/i.test(cleaned);

  // Extract main topic (longest non-stopword sequence)
  const mainTopic = keywords.slice(0, 3).join(" ");

  return {
    originalQuery: cleaned,
    keywords,
    isTimeSensitive,
    hasYear,
    extractedYear,
    isQuestionFormat,
    mainTopic,
  };
}

// ==============================
// Expansion Strategies
// ==============================

function generateSpecificVariation(analysis: QueryAnalysis): string | null {
  const { keywords, mainTopic, hasYear } = analysis;

  if (keywords.length < 2) return null;

  // Add qualifiers for specificity
  const qualifiers = ["detailed", "complete", "comprehensive", "in-depth"];
  const randomQualifier = qualifiers[Math.floor(Math.random() * qualifiers.length)];

  if (!hasYear && keywords.length >= 2) {
    return `${randomQualifier} ${mainTopic} guide`;
  }

  return `${mainTopic} ${randomQualifier} overview`;
}

function generateBroaderVariation(analysis: QueryAnalysis): string | null {
  const { keywords, mainTopic } = analysis;

  if (keywords.length < 2) return null;

  // Remove specific modifiers to broaden
  const broadKeywords = keywords.filter(
    (k) => !/\b(?:best|top|latest|new|specific|detailed|guide|tutorial)\b/i.test(k)
  );

  if (broadKeywords.length >= 1 && broadKeywords.length < keywords.length) {
    return broadKeywords.slice(0, 4).join(" ");
  }

  // Use only the core topic
  return keywords.slice(0, 2).join(" ");
}

function generateTimeAwareVariation(analysis: QueryAnalysis): string | null {
  const { originalQuery, hasYear, extractedYear, mainTopic, isTimeSensitive } = analysis;

  // If already has current year, try next year or add "latest"
  if (hasYear && extractedYear === CURRENT_YEAR) {
    return `latest ${mainTopic}`;
  }

  // If no year and time-sensitive, add current year
  if (!hasYear && isTimeSensitive) {
    return `${mainTopic} ${CURRENT_YEAR}`;
  }

  // For general queries, try adding "latest" or current year
  if (!hasYear) {
    return `${mainTopic} ${CURRENT_YEAR}`;
  }

  return null;
}

function generateComparisonVariation(analysis: QueryAnalysis): string | null {
  const { keywords, mainTopic } = analysis;

  // Only for queries that seem to be about evaluating options
  if (/\b(?:best|top|compare|versus|vs|review)\b/i.test(analysis.originalQuery)) {
    return `${mainTopic} comparison review`;
  }

  if (keywords.length >= 2) {
    return `${mainTopic} alternatives comparison`;
  }

  return null;
}

function generateBenchmarkVariation(analysis: QueryAnalysis): string | null {
  const { keywords, mainTopic, originalQuery } = analysis;

  // For tech/performance related queries
  if (/\b(?:model|performance|speed|benchmark|test|rating)\b/i.test(originalQuery)) {
    return `${mainTopic} benchmark performance`;
  }

  if (keywords.some((k) => /\b(?:ai|ml|llm|gpt|model)\b/i.test(k))) {
    return `${mainTopic} performance benchmarks`;
  }

  return null;
}

// ==============================
// Main Expander
// ==============================

export interface ExpandedQueries {
  original: string;
  variations: string[];
  all: string[];
}

/**
 * Expand a user query into 3-5 search variations for better coverage.
 *
 * Returns:
 *   - original: The cleaned original query
 *   - variations: Additional generated variations
 *   - all: Original + variations (deduped)
 */
export function expandQuery(userQuery: string): ExpandedQueries {
  const analysis = analyzeQuery(userQuery);
  const variations: string[] = [];

  // Strategy 1: Time-aware variation (high priority for time-sensitive queries)
  const timeAware = generateTimeAwareVariation(analysis);
  if (timeAware && timeAware !== analysis.originalQuery) {
    variations.push(timeAware);
  }

  // Strategy 2: More specific variation
  const specific = generateSpecificVariation(analysis);
  if (specific && specific !== analysis.originalQuery) {
    variations.push(specific);
  }

  // Strategy 3: Broader variation
  const broader = generateBroaderVariation(analysis);
  if (broader && broader !== analysis.originalQuery && broader.length >= 3) {
    variations.push(broader);
  }

  // Strategy 4: Comparison/review variation
  const comparison = generateComparisonVariation(analysis);
  if (comparison && comparison !== analysis.originalQuery) {
    variations.push(comparison);
  }

  // Strategy 5: Benchmark variation (for tech queries)
  const benchmark = generateBenchmarkVariation(analysis);
  if (benchmark && benchmark !== analysis.originalQuery) {
    variations.push(benchmark);
  }

  // Deduplicate and normalize
  const uniqueVariations = [...new Set(variations)]
    .map((v) => v.trim())
    .filter((v) => v.length > 0 && v.toLowerCase() !== analysis.originalQuery.toLowerCase())
    .slice(0, MAX_EXPANSIONS - 1); // Leave room for original

  // Ensure minimum expansions
  if (uniqueVariations.length < MIN_EXPANSIONS - 1) {
    // Add simple reformulations
    const reformulations = [
      `${analysis.mainTopic} explained`,
      `${analysis.mainTopic} overview`,
      `about ${analysis.mainTopic}`,
    ];

    for (const r of reformulations) {
      if (uniqueVariations.length >= MIN_EXPANSIONS - 1) break;
      if (!uniqueVariations.includes(r) && r !== analysis.originalQuery) {
        uniqueVariations.push(r);
      }
    }
  }

  const all = [analysis.originalQuery, ...uniqueVariations];

  console.log(
    `[QueryExpander] expanded "${userQuery.slice(0, 40)}..." into ${all.length} queries`
  );

  return {
    original: analysis.originalQuery,
    variations: uniqueVariations,
    all,
  };
}

/**
 * Build a clean search query from natural language (simplified version).
 * Strips stopwords and returns keyword-focused query.
 */
export function buildCleanQuery(userMessage: string): string {
  const cleaned = userMessage.replace(/[?!.,;:'"()\[\]{}]/g, "");
  const tokens = cleaned.split(/\s+/).filter(Boolean);

  const keywords: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token.toLowerCase())) continue;
    keywords.push(token);
    if (keywords.length >= 8) break;
  }

  if (keywords.length < 2) {
    return tokens.slice(0, 6).join(" ");
  }

  return keywords.join(" ");
}
