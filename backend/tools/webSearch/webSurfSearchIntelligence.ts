// SentIQ Chat v2.1 - deterministic WebSurf search planning and evidence selection.

import { getCachedWebSurfSearch, setCachedWebSurfSearch } from "../../cache/cacheManager";
import { TavilyProvider, isTavilyAvailable } from "./providers/tavilyProvider";
import { routeWebSearch } from "./webSearchRouter";
import type { SearchResult, WebSearchResult } from "./types";

export const WEBSURF_SEARCH_INTELLIGENCE_VERSION = "v2.1-pass-a";
export const MAX_WEBSURF_LOGICAL_SEARCHES = 3;
export const MAX_WEBSURF_RESULTS_PER_LOGICAL_SEARCH = 6;
export const MAX_WEBSURF_CANDIDATES = 18;
export const MAX_WEBSURF_PORTFOLIO_SOURCES = 6;
export const MAX_SOURCES_PER_DOMAIN = 2;
export const WEBSURF_RETRIEVAL_DEADLINE_MS = 22_000;

export const WEBSURF_CACHE_TTL_MS = {
  live: 7 * 60 * 1_000,
  day: 15 * 60 * 1_000,
  week: 45 * 60 * 1_000,
  month: 3 * 60 * 60 * 1_000,
  current: 2 * 60 * 60 * 1_000,
} as const;

export const WEBSURF_SOURCE_SCORE_WEIGHTS = {
  providerRelevance: 16,
  queryRelevance: 18,
  entityAlignment: 20,
  freshness: 15,
  authority: 17,
  coverageGoal: 6,
  corroboration: 5,
  uniqueness: 5,
  publicationDateConfidence: 3,
} as const;

export const WEBSURF_SOURCE_SCORE_PENALTIES = {
  duplicateStory: 12,
  wrongEntity: 34,
  temporalMismatch: 14,
  promotionalOrSeo: 18,
  lowInformation: 9,
  repeatedDomain: 8,
} as const;

export const WEBSURF_FRESHNESS_TARGET_DAYS: Record<WebSurfFreshness, number> = {
  live: 2,
  day: 2,
  week: 8,
  month: 35,
  current: 120,
};

export const WEBSURF_ROLE_AUTHORITY_FACTORS: Record<WebSurfSourceRole, number> = {
  official_primary: 1,
  authoritative_news: 0.9,
  specialist_reporting: 0.72,
  live_data_or_results: 0.86,
  reference: 0.35,
  social_or_video: 0.12,
  aggregator: 0.18,
  unknown: 0.52,
};

export const MIN_WEBSURF_PORTFOLIO_SCORE = 28;

export type WebSurfSearchCategory =
  | "sports"
  | "technology"
  | "company"
  | "product"
  | "politics"
  | "current_event"
  | "software"
  | "general";

export type WebSurfSearchIntent =
  | "latest_roundup"
  | "current_status"
  | "results"
  | "fixtures"
  | "breaking_news"
  | "release_update"
  | "current_fact";

export type WebSurfFreshness = "live" | "day" | "week" | "month" | "current";

export type WebSurfSourceRole =
  | "official_primary"
  | "authoritative_news"
  | "specialist_reporting"
  | "live_data_or_results"
  | "reference"
  | "social_or_video"
  | "aggregator"
  | "unknown";

export interface WebSurfSearchPlanQuery {
  readonly id: string;
  readonly query: string;
  readonly purpose: string;
  readonly topic?: "general" | "news";
  readonly timeRange?: WebSurfFreshness;
}

export interface WebSurfSearchPlan {
  readonly primaryEntity: string;
  readonly entityAliases: readonly string[];
  readonly interpretation: string;
  readonly category: WebSurfSearchCategory;
  readonly intent: WebSurfSearchIntent;
  readonly freshness: WebSurfFreshness;
  /** 0 means genuinely balanced; 1 means deterministic cues strongly agree. */
  readonly ambiguityConfidence: number;
  readonly coverageGoals: readonly string[];
  readonly queries: readonly WebSurfSearchPlanQuery[];
}

export interface WebSurfPlannerOptions {
  readonly now?: Date;
  readonly context?: readonly string[];
}

export interface WebSurfSearchRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly signal?: AbortSignal;
  readonly topic?: "general" | "news";
  readonly days?: number;
  readonly purpose: string;
}

export interface WebSurfSearchIntelligenceDependencies {
  /** A test seam for one bounded logical search; no model calls are involved. */
  readonly search?: (request: WebSurfSearchRequest) => Promise<WebSearchResult>;
  readonly now?: Date;
  readonly useCache?: boolean;
}

export interface WebSurfSearchExecution {
  readonly plan: WebSurfSearchPlan;
  readonly results: readonly SearchResult[];
  /**
   * Compact, score-free source context retained only for downstream answer
   * planning. It is deliberately separate from the public source registry.
   */
  readonly sourceIntelligence: readonly WebSurfSelectedSourceContext[];
  readonly provider?: string;
  readonly cacheHit: boolean;
  readonly rawResultCount: number;
  readonly logicalSearches: number;
}

export interface WebSurfSelectedSourceContext {
  readonly url: string;
  readonly role: WebSurfSourceRole;
  readonly entityCluster: string;
  readonly queryIds: readonly string[];
}

type EntityRule = {
  readonly entity: string;
  readonly aliases: readonly string[];
  readonly category: WebSurfSearchCategory;
  readonly cluster: string;
  readonly officialDomains?: readonly string[];
  readonly positiveCues?: readonly string[];
  readonly defaultCurrentWeight?: number;
};

const SPORTS_CUES = [
  "score", "scores", "result", "results", "fixture", "fixtures", "standings", "table",
  "qualified", "semi final", "semifinal", "final", "latest match", "who won", "tournament", "match",
] as const;
const GAME_CUES = ["game", "gameplay", "patch", "season pass", "video game", "ultimate team"] as const;
const RELEASE_CUES = ["release", "version", "stable", "changelog", "download", "update"] as const;
const BREAKING_CUES = ["breaking", "today", "just in", "now", "live"] as const;
const CURRENT_CUES = ["latest", "current", "recent", "update", "updates", "news", "announcements"] as const;
const STOP_WORDS = new Set([
  "a", "an", "the", "what", "is", "are", "was", "were", "who", "when", "where", "why", "how",
  "latest", "current", "recent", "update", "updates", "news", "about", "for", "on", "in", "of", "to",
]);

/* This is a small, reusable entity dictionary, not a result-domain allowlist. */
const ENTITY_RULES: readonly EntityRule[] = [
  {
    entity: "EA Sports FC 26",
    aliases: ["ea sports fc 26", "fc 26", "fifa 26", "fifa 2026"],
    category: "product",
    cluster: "sports_game",
    positiveCues: GAME_CUES,
  },
  {
    entity: "2026 FIFA World Cup",
    aliases: ["fifa world cup 2026", "2026 fifa world cup", "fifa 2026"],
    category: "sports",
    cluster: "sports_tournament",
    officialDomains: ["fifa.com"],
    positiveCues: SPORTS_CUES,
    defaultCurrentWeight: 3,
  },
  {
    entity: "Java",
    aliases: ["java", "openjdk", "jdk"],
    category: "software",
    cluster: "software_platform",
    positiveCues: RELEASE_CUES,
  },
];

function cleanQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lower(value: string): string {
  return cleanQuery(value).toLowerCase();
}

function hasCue(value: string, cues: readonly string[]): boolean {
  // Cues are user-language words and phrases, not arbitrary substrings:
  // "stable" must not accidentally satisfy the sports cue "table".
  return cues.some((cue) => new RegExp(`(?:^|\\b)${cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|\\b)`, "i").test(value));
}

function countCues(value: string, cues: readonly string[]): number {
  return cues.reduce((count, cue) => count + (value.includes(cue) ? 1 : 0), 0);
}

function queryTerms(value: string): string[] {
  return lower(value)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function genericEntity(query: string): string {
  const terms = queryTerms(query).slice(0, 6);
  return titleCase(terms.join(" ") || "Current topic");
}

function scoreEntityRule(rule: EntityRule, normalizedQuery: string, context: readonly string[]): number {
  const haystack = `${normalizedQuery} ${context.map(lower).join(" ")}`;
  const matchedAliasLength = rule.aliases
    .filter((alias) => haystack.includes(alias))
    .reduce((longest, alias) => Math.max(longest, alias.length), 0);
  if (matchedAliasLength === 0) return Number.NEGATIVE_INFINITY;
  return matchedAliasLength
    + countCues(haystack, rule.positiveCues ?? []) * 8
    + (hasCue(normalizedQuery, CURRENT_CUES) ? rule.defaultCurrentWeight ?? 0 : 0);
}

function resolveEntity(query: string, context: readonly string[]): {
  readonly rule?: EntityRule;
  readonly confidence: number;
} {
  const normalized = lower(query);
  const scored = ENTITY_RULES
    .map((rule) => ({ rule, score: scoreEntityRule(rule, normalized, context) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score || left.rule.entity.localeCompare(right.rule.entity));
  if (scored.length === 0) return { confidence: 0.55 };
  const best = scored[0];
  const next = scored[1];
  const margin = next ? best.score - next.score : best.score;
  return {
    rule: best.rule,
    confidence: Math.max(0.5, Math.min(0.98, 0.55 + margin / 45)),
  };
}

function resolveIntent(query: string, category: WebSurfSearchCategory): WebSurfSearchIntent {
  if (hasCue(query, ["fixture", "fixtures", "upcoming match"])) return "fixtures";
  if (hasCue(query, ["score", "scores", "result", "results", "who won", "standings", "table"])) return "results";
  if (hasCue(query, BREAKING_CUES)) return "breaking_news";
  if (hasCue(query, RELEASE_CUES) && category !== "sports") return "release_update";
  if (hasCue(query, CURRENT_CUES)) return "latest_roundup";
  return "current_fact";
}

function resolveFreshness(query: string, category: WebSurfSearchCategory, intent: WebSurfSearchIntent): WebSurfFreshness {
  if (hasCue(query, ["today", "live", "now", "latest match"]) || (category === "sports" && (intent === "results" || intent === "fixtures"))) return "live";
  if (category === "sports" && intent === "latest_roundup") return "live";
  if (hasCue(query, BREAKING_CUES)) return "day";
  if (intent === "latest_roundup") return "week";
  if (intent === "release_update") return "month";
  return "current";
}

function buildQueries(
  entity: string,
  category: WebSurfSearchCategory,
  intent: WebSurfSearchIntent,
  freshness: WebSurfFreshness,
  originalQuery: string,
): { coverageGoals: string[]; queries: WebSurfSearchPlanQuery[] } {
  const precise = intent === "current_fact"
    || intent === "results"
    || intent === "fixtures"
    || /\b(?:date|version|release number|who won)\b/i.test(originalQuery);
  const topic = freshness === "live" || freshness === "day" || category === "sports" ? "news" : "general";
  const request = (id: string, query: string, purpose: string): WebSurfSearchPlanQuery => ({ id, query, purpose, topic, timeRange: freshness });
  if (precise) {
    const suffix = intent === "fixtures" ? "upcoming fixtures" : intent === "results" ? "latest results" : "latest official information";
    return { coverageGoals: ["direct_answer"], queries: [request("primary", `${entity} ${suffix}`, "direct current answer")] };
  }
  if (category === "sports") {
    return {
      coverageGoals: ["current_event_status", "latest_consequential_results", "what_happens_next", "official_confirmation"],
      queries: [
        request("state_results", `${entity} latest results current stage`, "current tournament state and consequential results"),
        request("next_stage", `${entity} upcoming fixtures current stage`, "what happens next and current fixtures"),
        request("official", `${entity} official update`, "official or primary competition confirmation"),
      ],
    };
  }
  return {
    coverageGoals: ["latest_status", "official_confirmation"],
    queries: [
      request("latest", `${entity} latest update`, "latest status and developments"),
      request("official", `${entity} official announcement update`, "primary or authoritative confirmation"),
    ],
  };
}

export function buildWebSurfSearchPlan(query: string, options: WebSurfPlannerOptions = {}): WebSurfSearchPlan {
  const normalizedQuery = cleanQuery(query);
  const normalized = lower(normalizedQuery);
  const entity = resolveEntity(normalized, options.context ?? []);
  const rule = entity.rule;
  const category = rule?.category ?? (hasCue(normalized, SPORTS_CUES) ? "sports" : hasCue(normalized, RELEASE_CUES) ? "software" : "general");
  const intent = resolveIntent(normalized, category);
  const freshness = resolveFreshness(normalized, category, intent);
  const primaryEntity = rule?.entity ?? genericEntity(normalizedQuery);
  const planData = buildQueries(primaryEntity, category, intent, freshness, normalizedQuery);
  const queries = planData.queries.slice(0, MAX_WEBSURF_LOGICAL_SEARCHES);
  return {
    primaryEntity,
    entityAliases: rule?.aliases ?? [primaryEntity],
    interpretation: rule?.cluster ?? "general_current_topic",
    category,
    intent,
    freshness,
    ambiguityConfidence: entity.confidence,
    coverageGoals: planData.coverageGoals,
    queries,
  };
}

type PlannedSearchResult = {
  readonly query: WebSurfSearchPlanQuery;
  readonly result: SearchResult;
};

type RankedCandidate = {
  readonly result: SearchResult;
  readonly canonicalUrl: string;
  readonly domain: string;
  readonly role: WebSurfSourceRole;
  readonly entityCluster: string;
  readonly queryIds: readonly string[];
  readonly storyKey: string;
  readonly score: number;
};

type CachedSearchExecution = {
  readonly results: readonly SearchResult[];
  readonly sourceIntelligence: readonly WebSurfSelectedSourceContext[];
  readonly provider?: string;
  readonly rawResultCount: number;
  readonly logicalSearches: number;
};

const AUTHORITATIVE_NEWS_DOMAINS = [
  "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "nytimes.com", "ft.com", "bloomberg.com", "theguardian.com",
] as const;
const SPECIALIST_DOMAINS = [
  "espn.com", "skysports.com", "theathletic.com", "arstechnica.com", "theverge.com", "techcrunch.com", "wired.com",
] as const;
const LIVE_DATA_DOMAINS = ["flashscore.com", "sofascore.com", "livescore.com"] as const;
const SOCIAL_OR_VIDEO_DOMAINS = ["youtube.com", "youtu.be", "tiktok.com", "instagram.com", "facebook.com", "x.com", "twitter.com", "reddit.com"] as const;
const AGGREGATOR_DOMAINS = ["news.google.com", "msn.com", "newsbreak.com", "yahoo.com"] as const;

function matchesDomain(domain: string, hints: readonly string[]): boolean {
  return hints.some((hint) => domain === hint || domain.endsWith(`.${hint}`));
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

function domainForUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function entityRuleForPlan(plan: WebSurfSearchPlan): EntityRule | undefined {
  return ENTITY_RULES.find((rule) => rule.entity === plan.primaryEntity);
}

export function classifyWebSurfSourceRole(
  result: SearchResult,
  plan: Pick<WebSurfSearchPlan, "primaryEntity">,
): WebSurfSourceRole {
  const domain = domainForUrl(result.url);
  const rule = ENTITY_RULES.find((item) => item.entity === plan.primaryEntity);
  if (matchesDomain(domain, rule?.officialDomains ?? [])) return "official_primary";
  if (matchesDomain(domain, SOCIAL_OR_VIDEO_DOMAINS)) return "social_or_video";
  if (matchesDomain(domain, AGGREGATOR_DOMAINS)) return "aggregator";
  if (domain === "wikipedia.org" || domain.endsWith(".wikipedia.org") || domain === "britannica.com") return "reference";
  if (matchesDomain(domain, LIVE_DATA_DOMAINS)) return "live_data_or_results";
  if (matchesDomain(domain, AUTHORITATIVE_NEWS_DOMAINS)) return "authoritative_news";
  if (matchesDomain(domain, SPECIALIST_DOMAINS)) return "specialist_reporting";
  if (/\.(?:gov|edu)$/i.test(domain)) return "official_primary";
  return "unknown";
}

export function classifyWebSurfEntityCluster(result: SearchResult, plan: WebSurfSearchPlan): string {
  const text = lower(`${result.title} ${result.snippet} ${result.content ?? ""}`);
  if (hasCue(text, GAME_CUES) || /\b(?:ea sports|fc 2[0-9]|ultimate team)\b/.test(text)) return "sports_game";
  if (plan.category === "sports" && (hasCue(text, SPORTS_CUES) || /\b(?:world cup|match center)\b/.test(text))) return "sports_tournament";
  return plan.interpretation;
}

function storyKey(result: SearchResult): string {
  const terms = queryTerms(result.title)
    .filter((term) => !/^(?:official|latest|news|update|updates|report|reports)$/.test(term))
    .slice(0, 7);
  return terms.join(" ");
}

function publishedAgeDays(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time > now.getTime() + 24 * 60 * 60 * 1_000) return undefined;
  return Math.max(0, (now.getTime() - time) / (24 * 60 * 60 * 1_000));
}

function freshnessValue(publishedAt: string | undefined, freshness: WebSurfFreshness, now: Date): { score: number; stale: boolean; dated: boolean } {
  const ageDays = publishedAgeDays(publishedAt, now);
  if (ageDays === undefined) return { score: 0, stale: false, dated: false };
  const target = WEBSURF_FRESHNESS_TARGET_DAYS[freshness];
  if (ageDays <= target) return { score: WEBSURF_SOURCE_SCORE_WEIGHTS.freshness, stale: false, dated: true };
  if (ageDays <= target * 3) return { score: WEBSURF_SOURCE_SCORE_WEIGHTS.freshness * 0.35, stale: false, dated: true };
  return { score: 0, stale: freshness !== "current" || ageDays > 365, dated: true };
}

function roleAuthorityValue(role: WebSurfSourceRole): number {
  return WEBSURF_ROLE_AUTHORITY_FACTORS[role] * WEBSURF_SOURCE_SCORE_WEIGHTS.authority;
}

function relevanceValue(result: SearchResult, plan: WebSurfSearchPlan): number {
  const terms = [...new Set([...queryTerms(plan.primaryEntity), ...queryTerms(plan.entityAliases.join(" "))])];
  if (terms.length === 0) return WEBSURF_SOURCE_SCORE_WEIGHTS.queryRelevance * 0.5;
  const text = lower(`${result.title} ${result.snippet} ${result.content ?? ""}`);
  const matches = terms.filter((term) => text.includes(term)).length;
  return (matches / terms.length) * WEBSURF_SOURCE_SCORE_WEIGHTS.queryRelevance;
}

function entityAlignmentValue(cluster: string, plan: WebSurfSearchPlan): number {
  if (cluster === plan.interpretation) return WEBSURF_SOURCE_SCORE_WEIGHTS.entityAlignment;
  if (plan.category !== "sports" || cluster === "general_current_topic") return WEBSURF_SOURCE_SCORE_WEIGHTS.entityAlignment * 0.55;
  return 0;
}

function sourceIsPromotional(result: SearchResult, role: WebSurfSourceRole): boolean {
  const text = lower(`${result.title} ${result.snippet} ${result.url}`);
  return role === "social_or_video" || /\b(?:buy now|sponsored|promo code|best deal|watch now|affiliate)\b/.test(text);
}

function providerRelevanceValue(result: SearchResult): number {
  const score = typeof result.score === "number" && Number.isFinite(result.score) ? Math.max(0, Math.min(1, result.score)) : 0.5;
  return score * WEBSURF_SOURCE_SCORE_WEIGHTS.providerRelevance;
}

function sourceScore(
  result: SearchResult,
  role: WebSurfSourceRole,
  cluster: string,
  queryIds: readonly string[],
  duplicateStory: boolean,
  repeatedDomain: boolean,
  plan: WebSurfSearchPlan,
  now: Date,
): number {
  const freshness = freshnessValue(result.publishedAt, plan.freshness, now);
  const textLength = cleanQuery(`${result.title} ${result.snippet} ${result.content ?? ""}`).length;
  let score = providerRelevanceValue(result)
    + relevanceValue(result, plan)
    + entityAlignmentValue(cluster, plan)
    + freshness.score
    + roleAuthorityValue(role)
    + (queryIds.length > 0 ? WEBSURF_SOURCE_SCORE_WEIGHTS.coverageGoal : 0)
    + (freshness.dated ? WEBSURF_SOURCE_SCORE_WEIGHTS.publicationDateConfidence : 0)
    + (duplicateStory ? 0 : WEBSURF_SOURCE_SCORE_WEIGHTS.uniqueness);
  if (cluster !== plan.interpretation && plan.category === "sports") score -= WEBSURF_SOURCE_SCORE_PENALTIES.wrongEntity;
  if (freshness.stale) score -= WEBSURF_SOURCE_SCORE_PENALTIES.temporalMismatch;
  if (sourceIsPromotional(result, role)) score -= WEBSURF_SOURCE_SCORE_PENALTIES.promotionalOrSeo;
  if (textLength < 45) score -= WEBSURF_SOURCE_SCORE_PENALTIES.lowInformation;
  if (duplicateStory) score -= WEBSURF_SOURCE_SCORE_PENALTIES.duplicateStory;
  if (repeatedDomain) score -= WEBSURF_SOURCE_SCORE_PENALTIES.repeatedDomain;
  return Math.max(0, Math.min(100, score));
}

function scoreCandidatePool(
  input: readonly PlannedSearchResult[],
  plan: WebSurfSearchPlan,
  now: Date,
): RankedCandidate[] {
  const byUrl = new Map<string, { result: SearchResult; queryIds: Set<string> }>();
  for (const item of input.slice(0, MAX_WEBSURF_CANDIDATES)) {
    const key = canonicalUrl(item.result.url);
    if (!key) continue;
    const prior = byUrl.get(key);
    if (prior) {
      prior.queryIds.add(item.query.id);
      continue;
    }
    byUrl.set(key, { result: item.result, queryIds: new Set([item.query.id]) });
  }
  const domainCounts = new Map<string, number>();
  const storyCounts = new Map<string, number>();
  for (const entry of byUrl.values()) {
    const domain = domainForUrl(entry.result.url);
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    const story = storyKey(entry.result);
    if (story) storyCounts.set(story, (storyCounts.get(story) ?? 0) + 1);
  }
  const candidates = [...byUrl.entries()].map(([url, entry]) => {
    const domain = domainForUrl(entry.result.url);
    const role = classifyWebSurfSourceRole(entry.result, plan);
    const cluster = classifyWebSurfEntityCluster(entry.result, plan);
    const story = storyKey(entry.result);
    const queryIds = [...entry.queryIds].sort();
    return {
      result: entry.result,
      canonicalUrl: url,
      domain,
      role,
      entityCluster: cluster,
      queryIds,
      storyKey: story,
      score: sourceScore(
        entry.result,
        role,
        cluster,
        queryIds,
        Boolean(story && (storyCounts.get(story) ?? 0) > 1),
        (domainCounts.get(domain) ?? 0) > MAX_SOURCES_PER_DOMAIN,
        plan,
        now,
      ),
    } satisfies RankedCandidate;
  });
  const corroboratedCandidates = candidates.map((candidate) => {
    const candidateTerms = new Set(queryTerms(candidate.result.title));
    const corroborated = candidates.some((other) => {
      if (other.canonicalUrl === candidate.canonicalUrl || other.domain === candidate.domain) return false;
      if (other.entityCluster !== candidate.entityCluster) return false;
      return queryTerms(other.result.title).some((term) => candidateTerms.has(term));
    });
    return corroborated
      ? { ...candidate, score: Math.min(100, candidate.score + WEBSURF_SOURCE_SCORE_WEIGHTS.corroboration) }
      : candidate;
  });
  // Keep the highest-quality instance of the same story even when publishers differ.
  const bestStories = new Map<string, RankedCandidate>();
  for (const candidate of corroboratedCandidates) {
    const key = candidate.storyKey || candidate.canonicalUrl;
    const existing = bestStories.get(key);
    if (!existing || candidate.score > existing.score || (candidate.score === existing.score && candidate.canonicalUrl < existing.canonicalUrl)) {
      bestStories.set(key, candidate);
    }
  }
  return [...bestStories.values()].sort((left, right) => right.score - left.score || left.canonicalUrl.localeCompare(right.canonicalUrl));
}

function selectSourcePortfolio(candidates: readonly RankedCandidate[], plan: WebSurfSearchPlan): RankedCandidate[] {
  const selected: RankedCandidate[] = [];
  const domainCounts = new Map<string, number>();
  const selectedUrls = new Set<string>();
  const addFirst = (predicate: (candidate: RankedCandidate) => boolean, allowWeak = false): void => {
    const candidate = candidates.find((item) => predicate(item)
      && !selectedUrls.has(item.canonicalUrl)
      && (domainCounts.get(item.domain) ?? 0) < MAX_SOURCES_PER_DOMAIN
      && (allowWeak || item.score >= MIN_WEBSURF_PORTFOLIO_SCORE));
    if (!candidate || selected.length >= MAX_WEBSURF_PORTFOLIO_SOURCES) return;
    selected.push(candidate);
    selectedUrls.add(candidate.canonicalUrl);
    domainCounts.set(candidate.domain, (domainCounts.get(candidate.domain) ?? 0) + 1);
  };

  if (plan.category === "sports") {
    addFirst((item) => item.role === "official_primary" || item.role === "live_data_or_results", true);
    addFirst((item) => item.queryIds.includes("state_results"));
    addFirst((item) => item.queryIds.includes("next_stage"));
    addFirst((item) => item.role === "authoritative_news" || item.role === "specialist_reporting");
  } else {
    addFirst((item) => item.role === "official_primary", true);
    addFirst((item) => item.role === "authoritative_news" || item.role === "specialist_reporting");
  }
  while (selected.length < MAX_WEBSURF_PORTFOLIO_SOURCES) {
    const before = selected.length;
    addFirst(() => true);
    if (selected.length === before) break;
  }
  return selected;
}

function cacheDateBoundary(freshness: WebSurfFreshness, now: Date): string {
  const isoDay = now.toISOString().slice(0, 10);
  if (freshness === "live" || freshness === "day") return isoDay;
  if (freshness === "week") {
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    return monday.toISOString().slice(0, 10);
  }
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function getWebSurfSearchCacheTtl(freshness: WebSurfFreshness): number {
  return WEBSURF_CACHE_TTL_MS[freshness];
}

export function buildWebSurfSearchCacheIdentity(plan: WebSurfSearchPlan, now = new Date()): string {
  return JSON.stringify({
    version: WEBSURF_SEARCH_INTELLIGENCE_VERSION,
    entity: lower(plan.primaryEntity),
    interpretation: plan.interpretation,
    category: plan.category,
    intent: plan.intent,
    freshness: plan.freshness,
    boundary: cacheDateBoundary(plan.freshness, now),
    queries: plan.queries.map((query) => ({ id: query.id, query: lower(query.query), purpose: query.purpose })),
  });
}

function tavilyDays(freshness: WebSurfFreshness): number | undefined {
  const days: Partial<Record<WebSurfFreshness, number>> = { live: 2, day: 3, week: 8, month: 31 };
  return days[freshness];
}

async function searchWithTavily(request: WebSurfSearchRequest): Promise<WebSearchResult> {
  if (!isTavilyAvailable()) {
    return { success: false, query: request.query, results: [], error: "Tavily unavailable" };
  }
  const provider = new TavilyProvider();
  try {
    const results = await provider.search(
      request.query,
      request.maxResults,
      "basic",
      request.signal,
      { includeAnswer: false, topic: request.topic, days: request.days },
    );
    return { success: true, query: request.query, results: [...results], provider_used: provider.name };
  } catch (error) {
    return {
      success: false,
      query: request.query,
      results: [],
      error: error instanceof Error ? error.message : "Tavily retrieval failed",
    };
  }
}

function combineSignals(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(WEBSURF_RETRIEVAL_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

function compactErrorClass(error: string | undefined): string {
  return error && /^[A-Za-z0-9 .:_-]{1,160}$/.test(error) ? error.slice(0, 160) : "retrieval_failed";
}

/**
 * Executes no more than the plan's three logical searches. It never calls a
 * language model and only falls back to the existing non-Tavily chain when no
 * Tavily query supplied viable evidence.
 */
export async function executeWebSurfSearchIntelligence(
  query: string,
  dependencies: WebSurfSearchIntelligenceDependencies = {},
  signal?: AbortSignal,
): Promise<WebSurfSearchExecution> {
  const now = dependencies.now ?? new Date();
  const plan = buildWebSurfSearchPlan(query, { now });
  const cacheIdentity = buildWebSurfSearchCacheIdentity(plan, now);
  const useCache = dependencies.useCache !== false;
  if (useCache) {
    const cached = getCachedWebSurfSearch<CachedSearchExecution>(cacheIdentity);
    if (cached) {
      console.info(`[WebSurfV2] stage=search_intelligence cache=hit category=${plan.category} intent=${plan.intent} logical_queries=${cached.logicalSearches} winning_entity_confidence=${plan.ambiguityConfidence.toFixed(2)} final_sources=${cached.results.length} ttl_ms=${getWebSurfSearchCacheTtl(plan.freshness)}`);
      return { plan, ...cached, cacheHit: true };
    }
  }

  const retrievalStartedAt = Date.now();
  const effectiveSignal = combineSignals(signal);
  effectiveSignal.throwIfAborted();
  const search = dependencies.search ?? searchWithTavily;
  const collected: PlannedSearchResult[] = [];
  const providers = new Set<string>();
  let rawResultCount = 0;
  let successfulSearches = 0;
  let fallbackUsed = false;

  for (const plannedQuery of plan.queries) {
    effectiveSignal.throwIfAborted();
    const response = await search({
      query: plannedQuery.query,
      maxResults: MAX_WEBSURF_RESULTS_PER_LOGICAL_SEARCH,
      signal: effectiveSignal,
      topic: plannedQuery.topic,
      days: tavilyDays(plan.freshness),
      purpose: plannedQuery.purpose,
    });
    if (!response.success || response.results.length === 0) {
      console.info(`[WebSurfV2] stage=logical_search outcome=empty purpose=${plannedQuery.id} error_class=${compactErrorClass(response.error)}`);
      continue;
    }
    successfulSearches += 1;
    response.provider_used && providers.add(response.provider_used);
    rawResultCount += response.results.length;
    for (const result of response.results.slice(0, MAX_WEBSURF_RESULTS_PER_LOGICAL_SEARCH)) {
      collected.push({ query: plannedQuery, result });
    }
  }

  // A single bounded fallback is enough to retain the existing safe behaviour
  // without re-running a successful Tavily logical query through Tavily again.
  if (collected.length === 0 && !dependencies.search && !effectiveSignal.aborted) {
    const primary = plan.queries[0];
    if (primary) {
      fallbackUsed = true;
      const fallback = await routeWebSearch({
        query: primary.query,
        maxResults: MAX_WEBSURF_RESULTS_PER_LOGICAL_SEARCH,
        signal: effectiveSignal,
        skipTavily: true,
        skipCache: true,
      });
      if (fallback.success && fallback.results.length > 0) {
        successfulSearches += 1;
        fallback.provider_used && providers.add(fallback.provider_used);
        rawResultCount += fallback.results.length;
        for (const result of fallback.results.slice(0, MAX_WEBSURF_RESULTS_PER_LOGICAL_SEARCH)) {
          collected.push({ query: primary, result });
        }
      }
    }
  }
  effectiveSignal.throwIfAborted();

  const ranked = scoreCandidatePool(collected, plan, now);
  const portfolio = selectSourcePortfolio(ranked, plan);
  const results = portfolio.map((candidate) => candidate.result);
  const roleCounts = portfolio.reduce<Record<WebSurfSourceRole, number>>((counts, candidate) => {
    counts[candidate.role] += 1;
    return counts;
  }, {
    official_primary: 0,
    authoritative_news: 0,
    specialist_reporting: 0,
    live_data_or_results: 0,
    reference: 0,
    social_or_video: 0,
    aggregator: 0,
    unknown: 0,
  });
  const roleSummary = Object.entries(roleCounts)
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${role}:${count}`)
    .join(",") || "none";
  const execution: CachedSearchExecution = {
    results,
    sourceIntelligence: portfolio.map((candidate) => ({
      url: candidate.result.url,
      role: candidate.role,
      entityCluster: candidate.entityCluster,
      queryIds: candidate.queryIds,
    })),
    provider: [...providers].sort().join(", ") || undefined,
    rawResultCount,
    logicalSearches: plan.queries.length,
  };
  console.info(
    `[WebSurfV2] stage=search_intelligence cache=miss category=${plan.category} intent=${plan.intent} logical_queries=${plan.queries.length} successful_queries=${successfulSearches} winning_entity_confidence=${plan.ambiguityConfidence.toFixed(2)} raw_results=${rawResultCount} deduplicated=${ranked.length} entity_clusters=${new Set(ranked.map((item) => item.entityCluster)).size} source_roles=${roleSummary} final_sources=${results.length} domain_diversity=${new Set(portfolio.map((item) => item.domain)).size} fallback_used=${fallbackUsed ? 1 : 0} ttl_ms=${getWebSurfSearchCacheTtl(plan.freshness)} latency_ms=${Date.now() - retrievalStartedAt}`,
  );
  if (useCache && results.length > 0) {
    setCachedWebSurfSearch(cacheIdentity, execution, getWebSurfSearchCacheTtl(plan.freshness));
  }
  return { plan, ...execution, cacheHit: false };
}
