import assert from "node:assert/strict";
import {
  ARTIFACT_WORKSPACE_MEDIA_QUERY,
  ARTIFACT_WORKSPACE_VERSION,
  buildArtifactWorkspaceTitle,
  getArtifactWorkspacePlaceholderHeight,
  normalizeArtifactWorkspaceKind,
  shouldOfferArtifactWorkspace,
} from "../scripts/features/artifact-workspace-state.mjs";

assert.equal(ARTIFACT_WORKSPACE_VERSION, "13.2");
assert.match(ARTIFACT_WORKSPACE_MEDIA_QUERY, /min-width: 1100px/);
assert.match(ARTIFACT_WORKSPACE_MEDIA_QUERY, /pointer: fine/);
assert.equal(normalizeArtifactWorkspaceKind("generated-file-panel format-html"), "file");
assert.equal(normalizeArtifactWorkspaceKind("message-chart-container is-ready"), "chart");
assert.equal(normalizeArtifactWorkspaceKind("image-generation-card"), "");
assert.equal(shouldOfferArtifactWorkspace({ mediaMatches: true, connected: true, kind: "file" }), true);
assert.equal(shouldOfferArtifactWorkspace({ mediaMatches: false, connected: true, kind: "file" }), false);
assert.equal(shouldOfferArtifactWorkspace({ mediaMatches: true, connected: false, kind: "chart" }), false);
assert.equal(buildArtifactWorkspaceTitle({ kind: "chart" }), "Generated chart");
assert.equal(buildArtifactWorkspaceTitle({ kind: "file", format: "format-xlsx" }), "XLSX artifact");
assert.equal(buildArtifactWorkspaceTitle({ kind: "file", title: "  Report   Q3  " }), "Report Q3");
assert.equal(getArtifactWorkspacePlaceholderHeight(412.4), "412px");
assert.equal(getArtifactWorkspacePlaceholderHeight(0), "1px");

console.log("Artifact workspace state passed: expansion is large-screen-only, typed, and layout-preserving.");
