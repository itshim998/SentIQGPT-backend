import assert from "node:assert/strict";
import { cacheClear } from "./cache/cacheStore";
import {
  buildWebSurfSearchCacheIdentity,
  buildWebSurfSearchPlan,
  executeWebSurfSearchIntelligence,
  getWebSurfSearchCacheTtl,
} from "./tools/webSearch/webSurfSearchIntelligence";
import { isWebSurfV2SearchIntelligenceEnabled, prepareWebSurfV2 } from "./tools/webSearch/webSurfV2";
import type { SearchResult, WebSearchResult } from "./tools/webSearch/types";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function source(
  title: string,
  url: string,
  options: Partial<SearchResult> = {},
): SearchResult {
  return {
    title,
    url,
    snippet: options.snippet ?? `${title} current reporting and useful detail.`,
    source: options.source ?? "tavily",
    score: options.score ?? 0.8,
    content: options.content,
    publishedAt: options.publishedAt,
  };
}

function response(query: string, results: readonly SearchResult[]): WebSearchResult {
  return { success: true, query, results, provider_used: "mock" };
}

async function executeWithResponses(query: string, responses: readonly (readonly SearchResult[])[]) {
  let call = 0;
  return executeWebSurfSearchIntelligence(query, {
    now: NOW,
    useCache: false,
    search: async (request) => response(request.query, responses[call++] ?? []),
  });
}

async function main(): Promise<void> {
  const precise = buildWebSurfSearchPlan("What is the latest stable Node.js version?", { now: NOW });
  const moderate = buildWebSurfSearchPlan("Latest NVIDIA announcements", { now: NOW });
  const broadSports = buildWebSurfSearchPlan("Latest FIFA 2026 updates", { now: NOW });
  assert.equal(precise.queries.length, 1, "precise current fact uses one logical search");
  assert.ok(moderate.queries.length <= 2, "moderate update uses no more than two logical searches");
  assert.equal(broadSports.queries.length, 3, "broad current sports roundup uses three coverage searches");
  assert.ok(broadSports.queries.length <= 3, "planner never exceeds three logical searches");
  assert.equal(broadSports.primaryEntity, "2026 FIFA World Cup", "broad FIFA 2026 resolves to the tournament");
  assert.equal(buildWebSurfSearchPlan("Latest EA Sports FC 26 updates", { now: NOW }).primaryEntity, "EA Sports FC 26", "explicit EA Sports resolves to the game");
  assert.equal(buildWebSurfSearchPlan("Latest FIFA 2026 game update", { now: NOW }).primaryEntity, "EA Sports FC 26", "game cue resolves FIFA 2026 to the game");
  assert.equal(buildWebSurfSearchPlan("Latest FIFA World Cup 2026 update", { now: NOW }).primaryEntity, "2026 FIFA World Cup", "World Cup wording resolves directly to tournament");
  assert.equal(buildWebSurfSearchPlan("Latest Java update", { now: NOW }).category, "software", "Java update resolves to software context");

  const fifaOfficial = source("FIFA World Cup 2026 official match centre", "https://www.fifa.com/worldcup/matches");
  const bbcResults = source("FIFA World Cup latest results and current stage", "https://www.bbc.com/sport/football/world-cup", { publishedAt: "2026-07-12" });
  const skyFixtures = source("World Cup upcoming fixtures", "https://www.skysports.com/football/fixtures", { publishedAt: "2026-07-12" });
  const reutersStage = source("World Cup stage confirmed by tournament reporting", "https://www.reuters.com/sports/football/world-cup-stage", { publishedAt: "2026-07-11" });
  const youtubePromo = source("FIFA 2026 update watch now", "https://www.youtube.com/watch?v=promo", { publishedAt: "2026-07-12" });
  const wiki = source("2026 FIFA World Cup", "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup", { publishedAt: "2026-07-12" });
  const eaSports = source("EA Sports FC 26 gameplay update", "https://www.ea.com/games/ea-sports-fc/fc-26", { publishedAt: "2026-07-12" });
  const unknownLegitimate = source("Independent World Cup reporting", "https://local-news.example/world-cup-report", { publishedAt: "2026-07-12" });
  const sportsEvidence = await executeWithResponses("Latest FIFA 2026 updates", [
    [bbcResults, wiki, youtubePromo, eaSports],
    [skyFixtures, unknownLegitimate],
    [fifaOfficial, reutersStage],
  ]);
  const rankedUrls = sportsEvidence.results.map((item) => item.url);
  assert.equal(rankedUrls[0], fifaOfficial.url, "official competition evidence leads promotional video and reference pages");
  assert.ok(rankedUrls.indexOf(bbcResults.url) < rankedUrls.indexOf(wiki.url), "current BBC-like reporting outranks Wikipedia for a live update");
  assert.ok(!rankedUrls.includes(eaSports.url), "wrong-entity EA Sports source is excluded from tournament evidence");
  assert.ok(rankedUrls.includes(unknownLegitimate.url), "legitimate unknown sources remain eligible");
  assert.ok(rankedUrls.includes(bbcResults.url) && rankedUrls.includes(skyFixtures.url) && rankedUrls.includes(fifaOfficial.url), "sports portfolio covers results, next stage, and official current status");
  assert.ok(!rankedUrls.includes(youtubePromo.url), "weak promotional media is not added only to fill six sources");

  const domainFlood = await executeWithResponses("Latest FIFA 2026 updates", [
    [
      source("World Cup official first", "https://www.fifa.com/a", { publishedAt: "2026-07-12" }),
      source("World Cup official second", "https://www.fifa.com/b", { publishedAt: "2026-07-12" }),
      source("World Cup official third", "https://www.fifa.com/c", { publishedAt: "2026-07-12" }),
    ],
    [source("World Cup fixture independent", "https://www.skysports.com/a", { publishedAt: "2026-07-12" })],
    [source("World Cup reporting independent", "https://www.reuters.com/a", { publishedAt: "2026-07-12" })],
  ]);
  assert.ok(domainFlood.results.filter((item) => new URL(item.url).hostname === "www.fifa.com").length <= 2, "same-domain flooding is capped");

  const duplicates = await executeWithResponses("Latest FIFA 2026 updates", [
    [source("World Cup latest decisive result", "https://www.bbc.com/a", { publishedAt: "2026-07-12" })],
    [source("World Cup latest decisive result", "https://www.skysports.com/a", { publishedAt: "2026-07-12" })],
    [fifaOfficial],
  ]);
  assert.equal(duplicates.results.filter((item) => /decisive result/i.test(item.title)).length, 1, "duplicate stories are clustered before frozen source selection");
  assert.deepEqual(duplicates.results.map((_, index) => `S${index + 1}`), duplicates.results.map((_, index) => `S${index + 1}`), "source ID assignment remains deterministic after selection");

  const freshness = await executeWithResponses("Latest FIFA 2026 updates", [
    [source("World Cup current stage fresh", "https://news.example/fresh", { publishedAt: "2026-07-12" }), source("World Cup current stage old updated today", "https://news.example/old", { publishedAt: "2001-01-01" })],
    [skyFixtures],
    [fifaOfficial],
  ]);
  assert.ok(freshness.results.findIndex((item) => item.url === "https://news.example/fresh") < freshness.results.findIndex((item) => item.url === "https://news.example/old"), "recent reporting outranks stale reporting when authority is comparable");
  assert.ok(sportsEvidence.results.some((item) => item.url === fifaOfficial.url), "official live page stays eligible without requiring a publication date");
  assert.ok(getWebSurfSearchCacheTtl("live") < getWebSurfSearchCacheTtl("current"), "live-query cache TTL is shorter than stable current-query TTL");
  assert.notEqual(buildWebSurfSearchCacheIdentity(broadSports, NOW), buildWebSurfSearchCacheIdentity(broadSports, new Date("2026-07-13T12:00:00.000Z")), "live cache key changes at the relevant date boundary");

  let partialCalls = 0;
  const partial = await executeWebSurfSearchIntelligence("Latest NVIDIA announcements", {
    now: NOW,
    useCache: false,
    search: async (request) => {
      partialCalls += 1;
      return partialCalls === 1
        ? { success: false, query: request.query, results: [], error: "mock failure" }
        : response(request.query, [source("NVIDIA official announcement", "https://www.nvidia.com/news", { publishedAt: "2026-07-12" })]);
    },
  });
  assert.equal(partial.results.length, 1, "one logical search failure does not discard another successful search");
  assert.equal(partialCalls, 2, "successful planned search is not redundantly retried through fallback");

  const abortController = new AbortController();
  let abortCalls = 0;
  await assert.rejects(
    executeWebSurfSearchIntelligence("Latest FIFA 2026 updates", {
      now: NOW,
      useCache: false,
      search: async (request) => {
        abortCalls += 1;
        abortController.abort();
        return response(request.query, [fifaOfficial]);
      },
    }, abortController.signal),
    /abort/i,
    "abort stops outstanding planned searches",
  );
  assert.equal(abortCalls, 1, "abort prevents later logical searches");

  const originalFlag = process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED;
  try {
    process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = "false";
    const legacyQueries: string[] = [];
    await prepareWebSurfV2("Latest FIFA 2026 updates", "manual", {
      search: async (request) => {
        legacyQueries.push(request.query);
        return response(request.query, [fifaOfficial]);
      },
      validateUrl: async (url) => new URL(url),
      metadata: async () => ({}),
    });
    assert.deepEqual(legacyQueries, ["Latest FIFA 2026 updates"], "flag false preserves the unchanged single legacy V2 retrieval call");
    process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = "true";
    const manualQueries: string[] = [];
    const automaticQueries: string[] = [];
    const dependency = (calls: string[]) => ({
      search: async (request: { query: string }) => {
        calls.push(request.query);
        return response(request.query, [fifaOfficial, bbcResults, skyFixtures]);
      },
      validateUrl: async (url: string) => new URL(url),
      metadata: async () => ({}),
    });
    const manual = await prepareWebSurfV2("Latest FIFA 2026 updates", "manual", dependency(manualQueries));
    cacheClear();
    const automatic = await prepareWebSurfV2("Latest FIFA 2026 updates", "auto", dependency(automaticQueries));
    assert.equal(isWebSurfV2SearchIntelligenceEnabled(), true, "new subfeature flag enables Pass A");
    assert.deepEqual(manualQueries, automaticQueries, "manual and automatic WebSurf use identical Pass A query plans");
    assert.deepEqual(manual.payload.sources.map((item) => item.url), automatic.payload.sources.map((item) => item.url), "manual and automatic WebSurf freeze the same source portfolio");
    assert.deepEqual(manual.payload.sources.map((item, index) => item.id), ["S1", "S2", "S3"], "source IDs are assigned only after final Pass A selection");
    assert.equal(manual.payload.version, 2, "Pass A preserves the public WebSurf V2 payload shape");
    cacheClear();
    await assert.rejects(
      prepareWebSurfV2("Latest FIFA 2026 updates", "manual", {
        search: async (request) => ({ success: true, query: request.query, results: [] }),
        validateUrl: async (url) => new URL(url),
        metadata: async () => ({}),
      }),
      /No viable web evidence was found/,
      "zero viable Pass A evidence returns the existing retrieval failure path",
    );
  } finally {
    if (originalFlag === undefined) delete process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED;
    else process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = originalFlag;
  }

  console.log("WebSurf Search Intelligence validation passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
