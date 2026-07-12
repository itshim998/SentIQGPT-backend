import assert from "node:assert/strict";
import {
  cleanWebSurfPresentationText,
  collectWebSurfCitationIds,
  getWebSurfPresentationVersion,
  getWebSurfPublisherLabel,
  selectFeaturedWebSurfSources,
  truncateWebSurfExcerpt,
} from "../frontend/scripts/features/websurf-presentation.mjs";

const sources = [
  { id: "S1", url: "https://www.bbc.com/sport/article", domain: "bbc.com", title: "BBC headline", thumbnail_url: "https://cdn.example/bbc.jpg" },
  { id: "S2", url: "https://sport.bbc.com/other", domain: "bbc.com", title: "Same publisher" },
  { id: "S3", url: "https://www.fifa.com/news", domain: "fifa.com", title: "FIFA headline" },
  { id: "S4", url: "https://www.skysports.com/news", domain: "skysports.com", title: "Sky Sports headline" },
  { id: "S5", url: "https://www.reuters.com/world", domain: "reuters.com", title: "Reuters headline" },
];

assert.equal(getWebSurfPresentationVersion({ presentationVersion: 1 }), 1, "Pass C marker selects the presentation renderer");
assert.equal(getWebSurfPresentationVersion({}), 0, "V2 payload without marker retains legacy presentation");
assert.equal(getWebSurfPresentationVersion({ presentationVersion: 2 }), 0, "unknown future marker safely falls back");

assert.deepEqual(
  selectFeaturedWebSurfSources(sources).map((source) => source.id),
  ["S1", "S3", "S4"],
  "featured cards keep frozen order and prefer unique domains",
);
assert.equal(getWebSurfPublisherLabel(sources[0]), "BBC", "known publisher labels are polished deterministically");
assert.equal(getWebSurfPublisherLabel(sources[2]), "FIFA", "acronym publisher labels stay readable");
assert.equal(getWebSurfPublisherLabel({ domain: "nodejs.org" }), "Node.js", "small awkward-domain override is supported");
assert.equal(getWebSurfPublisherLabel({ domain: "unfamiliar-news.example" }), "Unfamiliar News", "unfamiliar domains humanize without a catalog");

assert.deepEqual(
  collectWebSurfCitationIds(
    "Claim [[S1]][[S3]]. `code [[S4]]` [label [[S4]]](https://example.com/[[S5]]) unknown [[S99]]",
    new Set(sources.map((source) => source.id)),
  ),
  ["S1", "S3"],
  "only valid prose citations are grouped as cited sources",
);
assert.equal(truncateWebSurfExcerpt("A ".repeat(180), 220).endsWith("…"), true, "long excerpts are bounded with an ellipsis");
assert.equal(cleanWebSurfPresentationText("<img src=x>\n hello", 80), "<img src=x> hello", "untrusted text stays text for safe DOM insertion");

console.log("WebSurf V2.1 presentation helper validation passed.");
