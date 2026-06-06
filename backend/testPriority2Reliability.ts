import assert from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";

function sourceBlock(source: string, needle: string, chars = 2200): string {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `Expected source to include ${needle}`);
  return source.slice(start, start + chars);
}

function run(): void {
  const llmService = readFileSync(resolve(__dirname, "llm_service.py"), "utf8");
  const invokeBlock = sourceBlock(llmService, 'async def invoke_llm');
  const safetyIndex = invokeBlock.indexOf('check_input_safety(request.prompt');
  const reserveIndex = invokeBlock.indexOf('reserve_llm_request_slot(user_id)');
  assert.ok(safetyIndex >= 0, "invoke safety check exists");
  assert.ok(reserveIndex >= 0, "invoke quota reservation exists");
  assert.ok(safetyIndex < reserveIndex, "invoke safety runs before quota reservation");

  const fallbackBlock = sourceBlock(llmService, 'def should_fallback_quota_rpc');
  assert.match(fallbackBlock, /return is_missing_quota_rpc_error\(error\)/, "quota fallback is limited to confirmed missing RPC drift");
  assert.doesNotMatch(fallbackBlock, /401|403|500/, "quota fallback must not include auth or server errors");

  const storageService = readFileSync(resolve(__dirname, "../frontend/scripts/services/storage.js"), "utf8");
  const dbPutBlock = sourceBlock(storageService, "async function dbPut");
  assert.match(dbPutBlock, /tx\.oncomplete/, "IndexedDB writes wait for transaction completion");
  assert.match(dbPutBlock, /tx\.onabort/, "IndexedDB writes reject transaction aborts");

  // Historical internal report filename retained as a static test fixture reference.
  const report = readFileSync(resolve(__dirname, "../SentIQGPT_Problems.txt"), "utf8");
  assert.doesNotMatch(report, /Priority 2 - Protect quota, persistence, and recovery correctness/, "Priority 2 roadmap section was removed after completion");

  console.log("Priority 2 reliability guards passed");
}

run();
