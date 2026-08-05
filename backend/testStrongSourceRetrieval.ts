import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIGRATION = "supabase/migrations/20260805100000_strengthen_source_fts_retrieval.sql";

function mustMatch(source: string, pattern: RegExp, message: string): void {
  assert.match(source, pattern, message);
}

async function main(): Promise<void> {
  const migration = await readFile(path.resolve(MIGRATION), "utf8");
  const service = await readFile(path.resolve("backend/services/sourceRetrievalService.ts"), "utf8");

  mustMatch(migration, /Database 2, 3, 4 only/i, "migration must stay data-shard-only");
  mustMatch(migration, /fts_weighted tsvector generated always as/i, "weighted generated FTS vector is required");
  mustMatch(migration, /setweight\([^;]+heading[^;]+'A'\)/is, "heading must carry the highest FTS weight");
  mustMatch(migration, /source_chunks_fts_weighted_idx[\s\S]+using gin\(fts_weighted\)/i, "weighted FTS must be GIN indexed");

  mustMatch(migration, /source_expand_query_terms/i, "deterministic query expansion function is required");
  mustMatch(migration, /v_token \|\| ' percent'/i, "percentage wording must be expanded");
  mustMatch(migration, /v_number := v_base::numeric \/ 100/i, "percentage decimals must be expanded");
  mustMatch(migration, /acronym_expansions/i, "document-derived acronym expansions must be used");
  mustMatch(migration, /regexp_replace\(v_normalized, '\[-_\/\]\+'/i, "hyphenated and unhyphenated forms must be normalized");
  mustMatch(migration, /v_token \|\| 's'/i, "singular/plural variants must be generated");

  mustMatch(migration, /source_exact_phrase_boost/i, "exact phrase ranking boost is required");
  mustMatch(migration, /source_special_term_boost/i, "numbers, dates, percentages and identifiers must be boosted");
  mustMatch(migration, /ts_rank_cd\(base\.fts_weighted, v_original_query\) \* 4\.0/i, "original field-aware query must dominate ranking");
  mustMatch(migration, /to_tsvector\('simple', coalesce\(base\.title/i, "document title must contribute to ranking");

  mustMatch(migration, /neighbour\.chunk_index in \(anchor\.chunk_index - 1, anchor\.chunk_index \+ 1\)/i,
    "preceding and following child chunks must be expanded around anchors");
  mustMatch(migration, /parent_rank <= 2 and page_rank <= 2/i, "pinpoint retrieval needs parent/page concentration limits");
  mustMatch(migration, /ntile\(v_per_document\)/i, "summary retrieval needs deterministic page/section diversity buckets");
  mustMatch(migration, /document_rank <= v_per_document/i, "comparison retrieval needs an independent document quota");

  for (const mode of ["pinpoint", "section", "summary", "comparison", "timeline", "exhaustive"]) {
    mustMatch(migration, new RegExp(`'${mode}'`, "i"), `retrieval mode ${mode} must be represented`);
  }
  mustMatch(migration, /source_extract_sort_date/i, "timeline retrieval must detect sortable dates");
  mustMatch(migration, /COVERAGE LIMIT:[\s\S]+did not inspect every page simultaneously/i,
    "summary and exhaustive extraction must disclose coverage limits");

  mustMatch(migration, /refresh_source_document_map\(/i, "deterministic document-map builder is required");
  mustMatch(migration, /after update of status on public\.source_documents/i,
    "document maps must be generated when ingestion marks a document ready");
  for (const field of [
    "table_of_contents",
    "heading_hierarchy",
    "sections",
    "page_start",
    "page_end",
    "repeated_key_terms",
    "repeated_entities",
    "acronym_expansions",
    "table_pages",
    "appendix_pages",
    "first_sentence",
    "last_sentence",
  ]) {
    mustMatch(migration, new RegExp(`'${field}'`, "i"), `document map must contain ${field}`);
  }

  mustMatch(migration, /create or replace function public\.search_source_chunks\(\s*p_owner_user_id uuid,\s*p_document_ids uuid\[\],\s*p_query text,\s*p_limit integer default 12/is,
    "the production RPC signature must remain backward compatible");
  mustMatch(service, /userDb\.rpc\("search_source_chunks"/i,
    "the existing production singleton must continue calling the replaced RPC transparently");
  mustMatch(service, /export const sourceRetrievalService = new SourceRetrievalService\(\);/i,
    "Phase 5 must not claim semantic retrieval is wired when it is not");

  assert(!/embedding\s*\(/i.test(migration), "Phase 5 must not generate embeddings");
  assert(!/provider|openai|gemini|groq|nvidia|pollinations/i.test(migration),
    "Phase 5 migration must remain provider-neutral and no-model-cost");

  console.log("Strong PostgreSQL FTS retrieval Phase 5 tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
