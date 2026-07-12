import {
  buildWebSurfSearchPlan,
  classifyWebSurfEntityCluster,
  classifyWebSurfSourceRole,
  type WebSurfSearchPlan,
  type WebSurfSelectedSourceContext,
  type WebSurfSourceRole,
} from "./webSurfSearchIntelligence";
import type { SearchResult } from "./types";

export type WebSurfAnswerProfile =
  | "current_event_roundup"
  | "sports_update"
  | "sports_results"
  | "sports_fixtures"
  | "breaking_news"
  | "software_release"
  | "company_update"
  | "product_update"
  | "current_fact"
  | "comparison"
  | "general_web_answer";

export type WebSurfTablePolicy = "forbidden" | "small_only" | "allowed" | "preferred";
export type WebSurfUncertaintyPolicy = "state_conflicts" | "state_missing_data" | "normal";
export type WebSurfFollowUpPolicy = "none" | "single_compact_offer";

export interface WebSurfAnswerPlan {
  readonly profile: WebSurfAnswerProfile;
  readonly primaryEntity: string;
  readonly interpretation: string;
  readonly asOfDate: string;
  readonly requiredCoverageGoals: readonly string[];
  readonly optionalCoverageGoals: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly purpose: string;
    readonly required: boolean;
  }[];
  readonly maxWords: number;
  readonly maxSections: number;
  readonly tablePolicy: WebSurfTablePolicy;
  readonly maxTableRows: number;
  readonly citationPolicy: {
    readonly currentClaimsRequireCitation: boolean;
    readonly numericClaimsRequireCitation: boolean;
    readonly datesRequireCitation: boolean;
    readonly minimumDistinctSources?: number;
  };
  readonly uncertaintyPolicy: WebSurfUncertaintyPolicy;
  readonly followUpPolicy: WebSurfFollowUpPolicy;
  /** Internal invocation hint; it is never sent to a client or persisted. */
  readonly maxOutputTokens: number;
}

export interface WebSurfAnswerSourceContext {
  readonly id: string;
  readonly role: WebSurfSourceRole;
  readonly coverage: readonly string[];
  readonly entityCluster: string;
  readonly publishedAt?: string;
  readonly title: string;
}

export interface WebSurfAnswerIntelligence {
  readonly plan: WebSurfAnswerPlan;
  readonly sources: readonly WebSurfAnswerSourceContext[];
  readonly synthesisSourceIds: readonly string[];
}

export interface WebSurfAnswerPlanningSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published_at?: string;
}

export interface WebSurfAnswerPlanningInput {
  readonly query: string;
  readonly sources: readonly WebSurfAnswerPlanningSource[];
  readonly searchPlan?: WebSurfSearchPlan;
  readonly selectedSourceContext?: readonly WebSurfSelectedSourceContext[];
  readonly now?: Date;
}

const EXPLICIT_DATASET_CUES = /\b(?:all|complete|every|full\s+(?:list|schedule|breakdown)|table|detailed\s+breakdown)\b/i;
const COMPARISON_CUES = /\b(?:compare|comparison|versus|vs\.?)\b/i;
const COMPANY_CUES = /\b(?:nvidia|apple|microsoft|google|alphabet|amazon|meta|tesla|openai|samsung|intel|amd)\b/i;
const BREAKING_CUES = /\b(?:breaking|today|just in|right now|developing)\b/i;
const DIRECT_FACT_CUES = /^(?:who|what|when|where|which|how)\b/i;
const RESULT_CUES = /\b(?:score|scores|result|results|who won|standings)\b/i;
const FIXTURE_CUES = /\b(?:fixture|fixtures|schedule|upcoming match|upcoming games?)\b/i;
const RELEASE_CUES = /\b(?:stable|version|release|changelog|download)\b/i;
const MISSING_DATA_CUES = /\b(?:tbd|to be determined|not confirmed|unknown|pending)\b/i;
const CONFLICT_CUES = /\b(?:conflict(?:ing)?|dispute(?:d)?|unclear|contradict(?:ion|ory))\b/i;

function asOfDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function sections(...items: Array<readonly [string, string, boolean]>) {
  return items.map(([id, purpose, required]) => ({ id, purpose, required }));
}

function includesAny(value: string, expression: RegExp): boolean {
  return expression.test(value);
}

function isSoftwareQuery(query: string, plan: WebSurfSearchPlan): boolean {
  return plan.category === "software" || /\b(?:node(?:\.js)?|deno|bun|python|java|typescript|react|angular|ubuntu|windows|ios|android)\b/i.test(query);
}

function isSportsQuery(query: string, plan: WebSurfSearchPlan): boolean {
  return plan.category === "sports" || /\b(?:fifa|world cup|match|tournament|league|football|soccer|nba|nfl|cricket)\b/i.test(query);
}

function selectProfile(query: string, plan: WebSurfSearchPlan): WebSurfAnswerProfile {
  if (includesAny(query, COMPARISON_CUES) && !includesAny(query, DIRECT_FACT_CUES)) return "comparison";
  if (isSportsQuery(query, plan)) {
    if (includesAny(query, DIRECT_FACT_CUES)) return "current_fact";
    if (includesAny(query, FIXTURE_CUES)) return "sports_fixtures";
    if (includesAny(query, RESULT_CUES)) return "sports_results";
    return "sports_update";
  }
  if (includesAny(query, BREAKING_CUES)) return "breaking_news";
  if (isSoftwareQuery(query, plan) && includesAny(query, RELEASE_CUES)) return "software_release";
  if (includesAny(query, COMPANY_CUES)) return "company_update";
  if (plan.category === "product") return "product_update";
  if (includesAny(query, DIRECT_FACT_CUES) || plan.intent === "current_fact") return "current_fact";
  if (/\b(?:latest|current|recent|news|update|updates)\b/i.test(query)) return "current_event_roundup";
  return "general_web_answer";
}

function resolveUncertaintyPolicy(sources: readonly WebSurfAnswerPlanningSource[]): WebSurfUncertaintyPolicy {
  const evidence = sources.map((source) => `${source.title} ${source.snippet}`).join(" ");
  if (CONFLICT_CUES.test(evidence)) return "state_conflicts";
  if (MISSING_DATA_CUES.test(evidence)) return "state_missing_data";
  return "normal";
}

function profileContract(profile: WebSurfAnswerProfile, query: string, searchPlan: WebSurfSearchPlan) {
  const explicitDataset = EXPLICIT_DATASET_CUES.test(query);
  const broadCoverage = searchPlan.coverageGoals.filter((goal) => goal !== "direct_answer");
  switch (profile) {
    case "current_fact":
      return { maxWords: 180, maxSections: 2, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 360,
        sections: sections(["answer", "Direct answer", true], ["context", "Only necessary current context", false]), followUpPolicy: "none" as const };
    case "software_release":
      return { maxWords: 250, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 500,
        sections: sections(["answer", "Direct release answer", true], ["details", "Supported version and release details", true]), followUpPolicy: "none" as const };
    case "company_update":
      return { maxWords: 450, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 780,
        sections: sections(["summary", "Current status summary", true], ["developments", "Three to five material developments", true], ["next", "What to watch next", false]), followUpPolicy: "single_compact_offer" as const };
    case "breaking_news":
      return { maxWords: 400, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 700,
        sections: sections(["what_happened", "What happened", true], ["confirmed_status", "Latest confirmed status", true], ["uncertainty", "What remains uncertain", false]), followUpPolicy: "none" as const };
    case "current_event_roundup":
      return { maxWords: 500, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 860,
        sections: sections(["status", "Current status", true], ["developments", "Key developments", true], ["next", "What happens next", true]), followUpPolicy: "single_compact_offer" as const };
    case "sports_update":
      return { maxWords: 500, maxSections: 4, tablePolicy: "small_only" as const, maxTableRows: 5, maxOutputTokens: 860,
        sections: sections(["status", "Short current-status summary", true], ["latest_results", "Latest consequential completed results only", true], ["current_stage", "Current stage or teams remaining when supported", false], ["next", "Confirmed upcoming fixtures or next stage", true]), followUpPolicy: "single_compact_offer" as const };
    case "sports_results":
      return { maxWords: explicitDataset ? 900 : 500, maxSections: 3, tablePolicy: "allowed" as const, maxTableRows: explicitDataset ? 30 : 10, maxOutputTokens: explicitDataset ? 1500 : 860,
        sections: sections(["results", "Completed results only", true], ["context", "Current status when useful", false]), followUpPolicy: "none" as const };
    case "sports_fixtures":
      return { maxWords: explicitDataset ? 900 : 500, maxSections: 3, tablePolicy: "allowed" as const, maxTableRows: explicitDataset ? 30 : 10, maxOutputTokens: explicitDataset ? 1500 : 860,
        sections: sections(["fixtures", "Confirmed upcoming fixtures only", true], ["context", "Qualification dependencies or current stage", false]), followUpPolicy: "none" as const };
    case "comparison":
      return { maxWords: 500, maxSections: 3, tablePolicy: "small_only" as const, maxTableRows: 8, maxOutputTokens: 860,
        sections: sections(["answer", "Bottom-line comparison", true], ["comparison", "Concise supported comparison", true]), followUpPolicy: "none" as const };
    case "product_update":
      return { maxWords: 400, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 700,
        sections: sections(["summary", "Current product update", true], ["details", "Material changes", true]), followUpPolicy: "single_compact_offer" as const };
    default:
      return { maxWords: 400, maxSections: 3, tablePolicy: "forbidden" as const, maxTableRows: 0, maxOutputTokens: 700,
        sections: sections(["answer", "Answer the dominant user intent", true], ["details", "Only useful supporting detail", false]), followUpPolicy: "none" as const };
  }
}

function sourceResult(source: WebSurfAnswerPlanningSource): SearchResult {
  return { title: source.title, url: source.url, snippet: source.snippet, source: "tavily" };
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value;
  }
}

function sourceContextFor(
  source: WebSurfAnswerPlanningSource,
  plan: WebSurfSearchPlan,
  selected: readonly WebSurfSelectedSourceContext[],
): WebSurfAnswerSourceContext {
  const match = selected.find((item) => normalizedUrl(item.url) === normalizedUrl(source.url));
  const coverage = match?.queryIds
    .map((id) => plan.queries.find((query) => query.id === id)?.purpose)
    .filter((value): value is string => Boolean(value))
    ?? [];
  const result = sourceResult(source);
  return {
    id: source.id,
    role: match?.role ?? classifyWebSurfSourceRole(result, plan),
    coverage: coverage.length > 0 ? coverage : plan.coverageGoals.slice(0, 2),
    entityCluster: match?.entityCluster ?? classifyWebSurfEntityCluster(result, plan),
    publishedAt: source.published_at,
    title: source.title,
  };
}

/** Deterministic and quota-neutral planning for the existing single WebSurf synthesis call. */
export function buildWebSurfAnswerIntelligence(input: WebSurfAnswerPlanningInput): WebSurfAnswerIntelligence {
  const now = input.now ?? new Date();
  const query = input.query.replace(/\s+/g, " ").trim();
  const searchPlan = input.searchPlan ?? buildWebSurfSearchPlan(query, { now });
  const profile = selectProfile(query, searchPlan);
  const contract = profileContract(profile, query, searchPlan);
  const sourceContexts = input.sources.map((source) => sourceContextFor(source, searchPlan, input.selectedSourceContext ?? []));
  const matchingSources = sourceContexts.filter((source) => source.entityCluster === searchPlan.interpretation || searchPlan.interpretation === "general_current_topic");
  const includedSources = matchingSources.length > 0 ? matchingSources : sourceContexts;
  const uncertaintyPolicy = resolveUncertaintyPolicy(input.sources.filter((source) => includedSources.some((item) => item.id === source.id)));
  const requiredCoverageGoals = profile === "sports_update"
    ? ["current_event_status", "latest_consequential_results", "what_happens_next"]
    : searchPlan.coverageGoals.slice(0, profile === "current_fact" ? 1 : 2);

  return {
    plan: {
      profile,
      primaryEntity: searchPlan.primaryEntity,
      interpretation: searchPlan.interpretation,
      asOfDate: asOfDate(now),
      requiredCoverageGoals,
      optionalCoverageGoals: searchPlan.coverageGoals.filter((goal) => !requiredCoverageGoals.includes(goal)),
      sections: contract.sections,
      maxWords: contract.maxWords,
      maxSections: contract.maxSections,
      tablePolicy: contract.tablePolicy,
      maxTableRows: contract.maxTableRows,
      citationPolicy: {
        currentClaimsRequireCitation: true,
        numericClaimsRequireCitation: true,
        datesRequireCitation: true,
        minimumDistinctSources: profile === "current_fact" || profile === "software_release" ? 1 : 2,
      },
      uncertaintyPolicy,
      followUpPolicy: contract.followUpPolicy,
      maxOutputTokens: contract.maxOutputTokens,
    },
    sources: includedSources,
    synthesisSourceIds: includedSources.map((source) => source.id),
  };
}

/** Server-only Pass B subfeature. */
export function isWebSurfV2AnswerIntelligenceEnabled(
  value = process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === "true";
}
