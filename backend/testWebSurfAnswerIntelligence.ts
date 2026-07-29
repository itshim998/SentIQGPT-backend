import assert from "node:assert/strict";
import { buildChatPrompt } from "./ai/PromptBuilders";
import {
  buildWebSurfAnswerIntelligence,
  isWebSurfV2AnswerIntelligenceEnabled,
  type WebSurfAnswerPlanningSource,
} from "./tools/webSearch/webSurfAnswerIntelligence";
import { WebSurfOutputGuardStream } from "./tools/webSearch/webSurfOutputGuard";
import { prepareWebSurfV2 } from "./tools/webSearch/webSurfV2";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function source(id: string, title: string, url: string, snippet = "Current confirmed reporting."): WebSurfAnswerPlanningSource {
  return { id, title, url, snippet, published_at: "2026-07-12" };
}

function planFor(query: string, sources: readonly WebSurfAnswerPlanningSource[] = []) {
  return buildWebSurfAnswerIntelligence({ query, sources, now: NOW });
}

async function main(): Promise<void> {
  const fifaSources = [
    source("S1", "FIFA World Cup 2026 official match centre", "https://www.fifa.com/worldcup/matches", "Official current stage and completed match results."),
    source("S2", "BBC World Cup latest results", "https://www.bbc.com/sport/football/world-cup", "Latest consequential completed results and confirmed next stage."),
    source("S3", "EA Sports FC 26 gameplay video", "https://www.youtube.com/watch?v=fc26", "Promotional video-game material."),
    source("S4", "EA Sports FC 26", "https://en.wikipedia.org/wiki/EA_Sports_FC_26", "Video game reference page."),
  ];
  const fifa = planFor("Latest FIFA 2026 updates", fifaSources);
  assert.equal(fifa.plan.profile, "sports_update", "broad FIFA updates select sports_update");
  assert.equal(fifa.plan.tablePolicy, "small_only", "broad sports update prevents a giant default table");
  assert.equal(fifa.plan.maxTableRows, 5, "broad sports update limits a compact table to five rows");
  assert.equal(fifa.plan.maxWords, 500, "broad sports update has a bounded word target");
  assert.deepEqual(fifa.plan.sections.map((section) => section.id), ["status", "latest_results", "current_stage", "next"], "sports update separates results, stage, and next fixtures");
  assert.deepEqual(fifa.synthesisSourceIds, ["S1", "S2"], "wrong-entity game evidence is excluded from the synthesis evidence set");
  assert.equal(fifa.plan.citationPolicy.numericClaimsRequireCitation, true, "sports scores require citations");
  assert.equal(fifa.plan.citationPolicy.datesRequireCitation, true, "dates require citations");
  assert.equal(fifa.plan.followUpPolicy, "single_compact_offer", "broad roundup permits at most one compact follow-up");

  const results = planFor("Show all FIFA 2026 World Cup scores", fifaSources);
  assert.equal(results.plan.profile, "sports_results", "explicit scores select sports_results");
  assert.equal(results.plan.tablePolicy, "allowed", "score requests permit a table");
  assert.ok(results.plan.maxTableRows > fifa.plan.maxTableRows, "full score requests permit a larger bounded table");
  assert.ok(results.plan.sections.some((section) => section.id === "results"), "results use a completed-results section");

  const fixtures = planFor("Complete upcoming FIFA fixtures", fifaSources);
  assert.equal(fixtures.plan.profile, "sports_fixtures", "fixture request selects sports_fixtures");
  assert.equal(fixtures.plan.tablePolicy, "allowed", "fixture requests permit a table");
  assert.ok(fixtures.plan.sections.some((section) => section.id === "fixtures"), "fixtures have their own section");

  assert.equal(planFor("Latest NVIDIA news").plan.profile, "company_update", "company news selects company_update");
  assert.equal(planFor("Latest stable Node.js version").plan.profile, "software_release", "stable Node.js query selects software_release");
  assert.equal(planFor("Who won France vs Spain today?").plan.profile, "current_fact", "direct match question stays concise");
  assert.equal(planFor("Compare the latest iPhone and Galaxy models").plan.profile, "comparison", "explicit comparison selects comparison");
  assert.equal(planFor("Latest earthquake news in Japan").plan.profile, "current_event_roundup", "latest current-event roundup remains bounded");

  const conflict = planFor("Latest FIFA 2026 updates", [
    source("S1", "Official result", "https://www.fifa.com/worldcup/matches", "The score is confirmed."),
    source("S2", "Conflicting report", "https://www.bbc.com/sport/football/world-cup", "Reports conflict over the score."),
  ]);
  assert.equal(conflict.plan.uncertaintyPolicy, "state_conflicts", "conflicting evidence requests an uncertainty instruction");
  const missing = planFor("Upcoming FIFA fixtures", [
    source("S1", "Official schedule", "https://www.fifa.com/worldcup/matches", "One opponent is TBD and not confirmed."),
  ]);
  assert.equal(missing.plan.uncertaintyPolicy, "state_missing_data", "missing fixture information is not fabricated");

  const call = buildChatPrompt({
    userMessage: "Latest FIFA 2026 updates",
    routeEvidence: [{ label: "S1", required: true, relevance: 1, content: "official evidence" }],
    webSurfSourceIds: fifa.synthesisSourceIds,
    webSurfAnswerPlan: fifa.plan,
    webSurfAnswerSources: fifa.sources,
    modelOverride: "gpt-oss-120b",
    streaming: true,
  });
  assert.match(call.prompt, /WEBSURF ANSWER CONTRACT/, "existing synthesis prompt is extended with the Pass B contract");
  assert.match(call.prompt, /Resolved primary entity: 2026 FIFA World Cup/, "prompt anchors the resolved entity");
  assert.match(call.prompt, /Table policy: small_only; maximum table rows: 5/, "prompt receives explicit table controls");
  assert.equal(call.max_output_tokens, fifa.plan.maxOutputTokens, "profile uses the existing invocation token configuration");
  assert.equal(
    call.visible_answer_tokens,
    fifa.plan.maxOutputTokens,
    "profile marks its bounded output as a visible-answer target for reasoning-provider budgeting",
  );

  const guard = new WebSurfOutputGuardStream(new Set(["S1"]));
  const chunks = [
    "Latest [0\u2020L12",
    "-L78] result [[S",
    "1]]\nRole: official_",
    "primary\n[WEBSURF_EVIDENCE_START]\nSee [official site](https://example.com) and [[S99]].",
  ];
  const visible = `${chunks.map((chunk) => guard.push(chunk)).join("")}${guard.flush()}`;
  assert.ok(!visible.includes("L12-L78"), "known line-range artefacts are removed across arbitrary chunks");
  assert.ok(!visible.includes("Role: official_primary"), "hidden source-role labels are removed");
  assert.ok(!visible.includes("WEBSURF_EVIDENCE"), "raw evidence delimiters are removed");
  assert.ok(!visible.includes("[[S99]]"), "unknown internal citation IDs are removed");
  assert.ok(visible.includes("[[S1]]"), "registered citation markers remain unchanged");
  assert.ok(visible.includes("[official site](https://example.com)"), "normal Markdown links are preserved");
  assert.ok(guard.removedInternalArtefact, "guard records that an internal artefact was removed");
  const bracketGuard = new WebSurfOutputGuardStream(new Set(["S1"]));
  assert.equal(`${bracketGuard.push("Normal [details]")}${bracketGuard.flush()}`, "Normal [details]", "legitimate bracketed text is preserved");

  const originalPassA = process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED;
  const originalPassB = process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED;
  const dependency = {
    search: async () => ({
      success: true,
      query: "Latest FIFA 2026 updates",
      provider_used: "mock",
      results: fifaSources.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet, source: "tavily" as const })),
    }),
    validateUrl: async (url: string) => new URL(url),
    metadata: async () => ({}),
  };
  try {
    process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = "false";
    process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED = "false";
    const legacy = await prepareWebSurfV2("Latest FIFA 2026 updates", "manual", dependency);
    assert.equal(legacy.answerIntelligence, undefined, "Pass B false preserves the current V2 synthesis preparation shape");
    assert.deepEqual(legacy.synthesisSourceIds, ["S1", "S2", "S3", "S4"], "Pass B false keeps every frozen registry source eligible as before");

    process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED = "true";
    const manual = await prepareWebSurfV2("Latest FIFA 2026 updates", "manual", dependency);
    const automatic = await prepareWebSurfV2("Latest FIFA 2026 updates", "auto", dependency);
    assert.equal(isWebSurfV2AnswerIntelligenceEnabled(), true, "Pass B server-only flag activates answer intelligence");
    assert.equal(manual.answerIntelligence?.plan.profile, "sports_update", "Pass B activates the deterministic answer profile");
    assert.deepEqual(manual.answerIntelligence?.plan, automatic.answerIntelligence?.plan, "manual and automatic WebSurf receive the same answer plan");
    assert.deepEqual(manual.synthesisSourceIds, automatic.synthesisSourceIds, "manual and automatic WebSurf use the same synthesis evidence set");
    assert.deepEqual(manual.payload.sources.map((item) => item.id), ["S1", "S2", "S3", "S4"], "Pass B does not change public source registry IDs or persistence payloads");
  } finally {
    if (originalPassA === undefined) delete process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED;
    else process.env.SENTIQ_WEBSURF_V2_SEARCH_INTELLIGENCE_ENABLED = originalPassA;
    if (originalPassB === undefined) delete process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED;
    else process.env.SENTIQ_WEBSURF_V2_ANSWER_INTELLIGENCE_ENABLED = originalPassB;
  }

  console.log("WebSurf Answer Intelligence validation passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
