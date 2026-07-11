import {
  assertSafeWebSurfPresentationUrl,
  fetchWebSurfArticleMetadata,
  type WebSurfArticleMetadata,
} from "./contentExtractor";
import { routeWebSearch } from "./webSearchRouter";
import type { SearchResult, WebSearchResult } from "./types";

export type WebSurfV2Trigger = "manual" | "auto";

export interface WebSurfV2Source {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly domain: string;
  readonly snippet: string;
  readonly published_at?: string;
  readonly favicon_url?: string;
  readonly thumbnail_url?: string;
}

export interface WebSurfV2Payload {
  readonly version: 2;
  readonly query: string;
  readonly trigger: WebSurfV2Trigger;
  readonly provider?: string;
  /** Frozen before the model is called; IDs are durable presentation keys. */
  readonly sources: readonly WebSurfV2Source[];
}

export interface WebSurfV2Evidence {
  readonly payload: WebSurfV2Payload;
  readonly routeEvidence: readonly {
    readonly content: string;
    readonly label: string;
    readonly required: boolean;
    readonly relevance: number;
  }[];
}

export interface WebSurfV2Dependencies {
  readonly search?: (args: { query: string; maxResults?: number; signal?: AbortSignal }) => Promise<WebSearchResult>;
  readonly metadata?: (url: string, signal?: AbortSignal) => Promise<WebSurfArticleMetadata>;
  readonly validateUrl?: (url: string) => Promise<URL>;
}

const MAX_CANDIDATE_SOURCES = 8;
const MAX_PRESENTED_SOURCES = 6;
const METADATA_CONCURRENCY = 3;

const RESERVED_PROMPT_LABELS = /\b(?:system|developer|assistant|current user message|context handling rules|route-required web or tool evidence|saved memory context|recent chat turns)\s*:/gi;

type SourcePreparation = {
  readonly source: WebSurfV2Source | null;
  readonly metadataSucceeded: boolean;
  readonly metadataFailureClass?: string;
  readonly sourceFailureClass?: string;
};

type FailureCounts = Map<string, number>;

function cleanText(value: string | undefined, maxChars: number): string {
  return (value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function cleanUntrustedEvidenceText(value: string, maxChars: number): string {
  return cleanText(value, maxChars).replace(RESERVED_PROMPT_LABELS, (label) => `[page text: ${label.slice(0, -1)}]`);
}

function canonicalSourceKey(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.hostname = normalized.hostname.toLowerCase().replace(/^www\./, "");
  if (normalized.pathname !== "/") normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  for (const key of [...normalized.searchParams.keys()]) {
    if (/^(?:utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) normalized.searchParams.delete(key);
  }
  normalized.searchParams.sort();
  return normalized.toString();
}

function safeErrorClass(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z0-9_-]{1,64}$/.test(error.name)
    ? error.name
    : "Error";
  const rawCode = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  const code = /^[A-Z0-9_:-]{1,64}$/.test(rawCode) ? rawCode : "";
  return code ? `${name}:${code}` : name;
}

function recordFailure(counts: FailureCounts, failureClass: string | undefined): void {
  if (!failureClass) return;
  counts.set(failureClass, (counts.get(failureClass) ?? 0) + 1);
}

function summarizeFailures(counts: FailureCounts): string {
  const summary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([failureClass, count]) => `${failureClass}:${count}`)
    .join(",");
  return summary || "none";
}

function logPreparationStage(stage: string, fields: Record<string, string | number>): void {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.info(`[WebSurfV2] stage=${stage} ${details}`);
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return output;
}

async function createSource(
  result: SearchResult,
  index: number,
  metadata: (url: string, signal?: AbortSignal) => Promise<WebSurfArticleMetadata>,
  validateUrl: (url: string) => Promise<URL>,
  signal?: AbortSignal,
): Promise<SourcePreparation> {
  try {
    signal?.throwIfAborted();
    const parsed = await validateUrl(result.url);
    // Source cards and citations never receive non-HTTPS URLs. This also
    // prevents unvalidated provider image or favicon data from crossing the
    // presentation boundary.
    if (parsed.protocol !== "https:") {
      return { source: null, metadataSucceeded: false, sourceFailureClass: "InsecureProtocol" };
    }
    let details: WebSurfArticleMetadata = {};
    let metadataSucceeded = true;
    let metadataFailureClass: string | undefined;
    try {
      details = await metadata(parsed.toString(), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      metadataSucceeded = false;
      metadataFailureClass = safeErrorClass(error);
    }
    return {
      metadataSucceeded,
      metadataFailureClass,
      source: {
        id: `S${index + 1}`,
        title: cleanText(result.title, 220) || parsed.hostname,
        url: parsed.toString(),
        domain: parsed.hostname.replace(/^www\./i, ""),
        snippet: cleanUntrustedEvidenceText(result.body ?? result.content ?? result.snippet, 1_200),
        published_at: details.published_at,
        favicon_url: details.favicon_url,
        thumbnail_url: details.thumbnail_url,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      source: null,
      metadataSucceeded: false,
      sourceFailureClass: safeErrorClass(error),
    };
  }
}

/**
 * The canonical V2 retrieval preparation step. It has no model or billing
 * side effects, so callers can plug its evidence into the already-authoritative
 * normal-message allocation path exactly once.
 */
export async function prepareWebSurfV2(
  query: string,
  trigger: WebSurfV2Trigger,
  dependencies: WebSurfV2Dependencies = {},
  signal?: AbortSignal,
): Promise<WebSurfV2Evidence> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  if (!normalizedQuery) throw new Error("WebSurf query is required");

  const search = dependencies.search ?? routeWebSearch;
  const metadata = dependencies.metadata ?? fetchWebSurfArticleMetadata;
  // DNS-pinned validation is mandatory for optional server-side metadata
  // fetches. The frozen source registry only presents safe HTTPS links, so it
  // deliberately avoids making a transient DNS failure fatal to core search.
  const validateUrl = dependencies.validateUrl ?? (async (url: string) => assertSafeWebSurfPresentationUrl(url));
  signal?.throwIfAborted();
  const result = await search({ query: normalizedQuery, maxResults: MAX_CANDIDATE_SOURCES, signal });
  if (!result.success || result.results.length === 0) {
    logPreparationStage("core_retrieval_failed", {
      result_count: result.results.length,
      success: result.success ? 1 : 0,
    });
    throw new Error(result.error || "No web results found");
  }

  const candidates = result.results.slice(0, MAX_CANDIDATE_SOURCES);
  logPreparationStage("retrieved", { result_count: result.results.length, candidate_count: candidates.length });
  const sourcePreparations = await mapWithConcurrency(
    candidates,
    METADATA_CONCURRENCY,
    async (item, index) => {
      try {
        return await createSource(item, index, metadata, validateUrl, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return {
          source: null,
          metadataSucceeded: false,
          sourceFailureClass: safeErrorClass(error),
        } satisfies SourcePreparation;
      }
    },
  );
  signal?.throwIfAborted();

  const sourceFailureCounts: FailureCounts = new Map();
  const metadataFailureCounts: FailureCounts = new Map();
  let metadataSucceeded = 0;
  let metadataFailed = 0;
  for (const preparation of sourcePreparations) {
    recordFailure(sourceFailureCounts, preparation.sourceFailureClass);
    if (preparation.source) {
      if (preparation.metadataSucceeded) {
        metadataSucceeded += 1;
      } else {
        metadataFailed += 1;
        recordFailure(metadataFailureCounts, preparation.metadataFailureClass);
      }
    }
  }
  const sourceCandidates = sourcePreparations.map((preparation) => preparation.source);
  const urlValidCount = sourceCandidates.filter((source): source is WebSurfV2Source => source !== null).length;
  logPreparationStage("source_validation", {
    candidate_count: candidates.length,
    url_valid_count: urlValidCount,
    url_rejected_count: candidates.length - urlValidCount,
    failure_classes: summarizeFailures(sourceFailureCounts),
  });
  logPreparationStage("metadata_enrichment", {
    success_count: metadataSucceeded,
    failure_count: metadataFailed,
    failure_classes: summarizeFailures(metadataFailureCounts),
  });

  const seenUrls = new Set<string>();
  const uniqueSources: WebSurfV2Source[] = [];
  let duplicateCount = 0;
  for (const source of sourceCandidates) {
    if (!source) continue;
    try {
      const key = canonicalSourceKey(new URL(source.url));
      if (seenUrls.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seenUrls.add(key);
      uniqueSources.push(source);
    } catch (error) {
      recordFailure(sourceFailureCounts, safeErrorClass(error));
    }
  }
  // IDs must be contiguous and frozen once, before the model begins.
  const sources = uniqueSources
    .slice(0, MAX_PRESENTED_SOURCES)
    .map((source, index) => ({ ...source, id: `S${index + 1}` }));
  logPreparationStage("source_registry", {
    url_valid_count: urlValidCount,
    deduplicated_count: duplicateCount,
    final_source_count: sources.length,
    source_failure_classes: summarizeFailures(sourceFailureCounts),
  });
  if (sources.length === 0) {
    throw new Error("No safe HTTPS web sources were available");
  }

  const payload: WebSurfV2Payload = {
    version: 2,
    query: normalizedQuery,
    trigger,
    provider: result.provider_used,
    sources,
  };
  const routeEvidence = sources.map((source, index) => ({
    label: source.id,
    required: true,
    relevance: Math.max(0.5, 1 - index * 0.08),
    content: JSON.stringify({
      source_id: source.id,
      title: cleanUntrustedEvidenceText(source.title, 220),
      url: source.url,
      excerpt: source.snippet,
    }),
  }));
  return { payload, routeEvidence };
}

export function isWebSurfV2Enabled(value = process.env.SENTIQ_WEBSURF_V2_ENABLED): boolean {
  return value?.trim().toLowerCase() === "true";
}
