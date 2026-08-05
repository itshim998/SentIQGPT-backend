# Phase 4 — Full long-PDF ingestion

## Objective

Remove irreversible PDF text loss without increasing model usage or placing full documents directly in prompts.

The previous upload path called `getText()` for the complete PDF, flattened every page into one string, and truncated that string at 50,000 characters before durable source persistence. Any content after that boundary could never be retrieved later.

## Implemented architecture

### Bounded browser preview

`FileIngestionHandler` now returns only a bounded preview in `extracted_text`.

Defaults:

- `SENTIQ_PDF_PREVIEW_CHARS=16000`
- `SENTIQ_PDF_PREVIEW_PAGES=12`
- `SENTIQ_PDF_MAX_PAGES=600`
- `SENTIQ_MAX_UPLOAD_BYTES=10485760`

The existing transport limit remains 10 MB. Phase 4 makes the parser and persistence path bounded before any future product decision to increase that limit.

### Canonical page source

For an authenticated upload, the parser handle is registered in a short-lived in-process handoff registry. The registry is keyed by owner, filename, size, and exact preview content. The immediately following durable-ingestion call consumes it once.

The handoff stores the parser, not a flattened full-document string. It expires automatically and destroys the parser if persistence never consumes it.

Defaults:

- `SENTIQ_PDF_CANONICAL_REGISTRY_TTL_MS=300000`
- `SENTIQ_PDF_CANONICAL_REGISTRY_MAX_PENDING=8`

### Page-by-page extraction and persistence

Canonical ingestion calls `pdf-parse` with `partial: [pageNumber]` and processes one page at a time.

Every extracted page is represented as:

```ts
type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
  characterCount: number;
  extractionStatus: "text" | "empty" | "failed";
};
```

Text pages are chunked independently. Parent and child chunks preserve:

- `page_number`;
- page start and end metadata;
- detected heading;
- document/page path;
- global parent and child indices;
- document title through the context prefix.

Parents and children are inserted in bounded batches. Progress metadata is checkpointed while the document remains `processing`.

Defaults:

- `SENTIQ_SOURCE_INSERT_BATCH_SIZE=100`
- `SENTIQ_PDF_PROGRESS_PAGE_BATCH=8`
- `SENTIQ_PDF_MAX_STORED_TOKENS=1000000`
- `SENTIQ_PDF_INGESTION_TIMEOUT_MS=90000`
- `SENTIQ_SOURCE_PROCESSING_STALE_MS=900000`

The ingestion deadline is checked before each page. If it is reached after some pages were indexed, the document is retained as an explicit partial index. If no page was indexed, the document is marked failed.

### Completion states

The database status constraint remains compatible with the existing values:

- `processing` while ingestion is underway;
- `ready` when at least one page was indexed, including a partial index;
- `failed` when no selectable text exists or ingestion fails.

The more precise state is stored in `metadata.ingestion_status`:

- `ready`;
- `partial`;
- `ocr_required`;
- `failed`.

A partial result is explicit when any of the following occurs:

- the configured page ceiling is reached;
- the configured stored-token ceiling is reached;
- the configured ingestion deadline is reached;
- one or more pages fail extraction.

### Scanned PDFs

Pages with fewer than 24 cleaned characters are treated as empty. If every inspected page is empty and none failed, the document is marked:

- database status: `failed`;
- `metadata.ingestion_status`: `ocr_required`;
- `metadata.ocr_required`: `true`.

No provider-based OCR or additional model call is introduced. The system does not claim to understand scanned pages.

### Idempotency and interrupted ingestion

The SHA-256 hash of the original PDF bytes is the canonical content hash.

On re-upload:

- an existing ready document is reused;
- a currently active processing document is reused;
- failed or stale processing rows are removed before retry, with chunk cleanup handled by existing cascading foreign keys.

The Phase 4 migration adds indexes for owner/hash/status lookup and page-aware chunk access.

## Prompt behavior

The complete PDF body is never inserted directly into ordinary prompts. Prompt construction continues to resolve the durable `source_document_id` and retrieve bounded parent/child excerpts. The browser preview remains only a compatibility fallback when durable retrieval is unavailable.

## Deployment

Apply the following migration to data shards 2, 3, and 4 only:

```text
supabase/migrations/20260805043000_harden_long_pdf_ingestion.sql
```

The migration is index-only. The code remains functionally compatible before it is applied, but idempotency and page-map lookups will be less efficient.

## Validation

`backend/testLongPdfIngestion.ts` covers:

- a generated 14-page real PDF whose canonical text exceeds the former 50,000-character boundary;
- late-page content and page-number preservation;
- page-aware incremental parent/child persistence;
- bounded preview/canonical separation contracts;
- failed and empty page accounting;
- partial indexing;
- scanned-PDF `ocr_required` classification;
- content-hash reuse;
- parser cleanup;
- migration contracts.
