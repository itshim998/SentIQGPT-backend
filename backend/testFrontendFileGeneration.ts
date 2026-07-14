import assert from "assert";
import ts from "typescript";
import { readFrontendSources } from "./frontendSource";

const frontend = readFrontendSources();
const html = frontend.combined;

assert.match(html, /const DB_VERSION = 5;/);
assert.match(html, /generatedFiles: "generated_files"/);
assert.match(html, /setActiveUserId/);
assert.match(html, /owner_user_id/);
assert.match(html, /RECENT_CHAT_WARM_LIMIT = 5/);
assert.match(html, /warmRecentChatCache/);
assert.match(html, /last_active_chat_id:/);
assert.match(html, /chat-cache-loader/);
assert.match(html, /sanitizeMessageMeta/);
assert.match(html, /storeGeneratedFile/);
assert.match(html, /getGeneratedFile/);
assert.match(html, /file_token/);
assert.match(html, /file_artifact/);
assert.match(html, /file_generation: "Reading file"/);
assert.match(html, /createFileGenerationStreamingBubble/);
assert.match(html, /Copy/);
assert.match(html, /Edit/);
assert.match(html, /Save/);
assert.match(html, /Cancel/);
assert.match(html, /Download/);
assert.match(html, /Preview/);
assert.match(html, /getGeneratedFileAccessUrl/);
assert.match(html, /updateGeneratedHtmlFile/);
assert.match(html, /getGeneratedFileDownloadName/);
assert.match(html, /detectClarificationDownloadFormat/);
assert.match(html, /typedClarificationDownloadFormat/);
assert.match(html, /callbacks\.onRoute\(parsed\.route,\s*parsed\)/);
assert.match(html, /ensureFileGenerationStreamBubble/);
assert.match(html, /isGeneratedFileCacheFresh/);
assert.match(html, /content_sha256/);
assert.match(html, /storage_bucket/);
assert.match(html, /current\.dirty/);
assert.match(html, /fromEditor/);
assert.match(html, /generated_file_version_conflict|error\?\.status === 409/);
assert.match(html, /normalized\.file_name \|\| getGeneratedFileDownloadName/);
assert.match(html, /generated-sheet-preview/);
assert.match(html, /generated-sheet-tabs/);
assert.match(html, /generated-sheet-summary/);
assert.match(html, /generated-slide-preview/);
assert.match(html, /generated-slide-card/);
assert.match(html, /generated-preview-meta/);
assert.match(html, /generated-pdf-preview/);
assert.doesNotMatch(html, /allow-scripts/, "generated HTML previews must not execute scripts by default");

assert.ok(frontend.scriptFiles.length >= 8, "expected modular frontend scripts to parse");
frontend.scriptFiles.forEach((file) => {
  const result = ts.transpileModule(file.content, {
    fileName: file.relativePath,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(
    errors.length,
    0,
    `${file.relativePath} failed to parse: ${errors.map((diagnostic) => diagnostic.messageText).join("; ")}`,
  );
});

console.log("frontend file generation static checks passed");
