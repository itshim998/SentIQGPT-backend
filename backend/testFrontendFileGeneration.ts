import assert from "assert";
import { readFileSync } from "fs";
import { join } from "path";

const html = readFileSync(join(process.cwd(), "frontend", "index.html"), "utf8");

assert.match(html, /const DB_VERSION = 3;/);
assert.match(html, /generatedFiles: "generated_files"/);
assert.match(html, /storeGeneratedFile/);
assert.match(html, /getGeneratedFile/);
assert.match(html, /file_token/);
assert.match(html, /file_artifact/);
assert.match(html, /file_generation: "Analysing\.\.\."/);
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

const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
assert.ok(inlineScripts.length >= 3, "expected inline scripts to parse");
inlineScripts.forEach((script, index) => {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`inline script ${index + 1} failed to parse: ${error instanceof Error ? error.message : String(error)}`);
  }
});

console.log("frontend file generation static checks passed");
