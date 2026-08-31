import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// Pre-populate mock DB credentials so offline test runs without database requirements
const candidates = [
  pathResolve(__dirname, "..", ".env"),
  pathResolve(__dirname, "..", "..", ".env"),
  pathResolve(process.cwd(), ".env"),
];
const envPath = candidates.find((c) => existsSync(c));
if (envPath) dotenv.config({ path: envPath });
else dotenv.config();

for (let i = 1; i <= 4; i += 1) {
  process.env[`SUPABASE_URL_${i}`] = process.env[`SUPABASE_URL_${i}`] || `https://mock-shard-${i}.supabase.co`;
  process.env[`SUPABASE_SERVICE_ROLE_KEY_${i}`] = process.env[`SUPABASE_SERVICE_ROLE_KEY_${i}`] || `mock-service-key-${i}`;
}

import assert from "node:assert/strict";
import { composePdf, normalizePdfDocument } from "./tools/fileGeneration/pdfDocument";
import { ensureHtmlDocument, repairSpecForFormat } from "./tools/fileGeneration/fileGenerator";


async function main(): Promise<void> {
  console.log("[testProductionRuntimeClosure] Verifying production runtime dependencies...");

  // 1. Verify pdfDocument and pdfkit runtime execution
  const sampleSpec = {
    title: "Production Runtime Test PDF",
    subtitle: "Verification Document",
    sections: [
      {
        heading: "Section 1",
        body: ["This verifies that pdfkit is available and functional in production runtime."],
        bullets: ["Point A", "Point B"],
      },
    ],
  };

  const doc = normalizePdfDocument(sampleSpec);
  const pdfResult = await composePdf(doc);
  assert(pdfResult.buffer instanceof Buffer, "PDF result must contain a Buffer");
  assert(pdfResult.buffer.length > 0, "PDF buffer must not be empty");
  assert(pdfResult.buffer.subarray(0, 4).toString("utf8") === "%PDF", "Buffer must be a valid PDF");
  console.log(`[testProductionRuntimeClosure] PDF generation verified (size=${pdfResult.buffer.length} bytes, pages=${pdfResult.pageCount}).`);

  // 2. Verify HTML / document helpers
  const html = ensureHtmlDocument("<h1>Hello World</h1>");
  assert(html.includes("<!DOCTYPE html>"), "HTML helper must wrap document");

  const repaired = repairSpecForFormat(sampleSpec, "pdf");
  assert.equal(repaired.format, "pdf", "Format must be pdf");

  console.log("[testProductionRuntimeClosure] All production runtime closure assertions passed successfully!");
}

void main().catch((error) => {
  console.error("[testProductionRuntimeClosure] FATAL:", error);
  process.exit(1);
});
