import {
  getInternalGatewayHeaders,
  getInternalGatewayUrl,
  waitForInternalGatewayReady,
} from "../../internalGateway";
import { downloadVisualAssetBuffer } from "./assetStorage";
import { getPdfInfo, renderPdfPage } from "./pdfRenderer";
import { preprocessImage } from "./imagePreprocessor";
import {
  RESOLUTION_POLICIES,
  selectInitialResolutionPolicy,
  shouldRefineAtHigherResolution,
  type MediaResolutionLevel,
} from "./resolutionPolicy";
import { partitionVisualBatches, type BatchItem } from "./visualBatcher";
import {
  computeVisualAnalysisCacheKey,
  getCachedVisualAnalysis,
  setCachedVisualAnalysis,
  VISUAL_ANALYSIS_VERSION,
} from "./visualCache";
import type {
  ImageInputResult,
  PageVisualEvidence,
  VisualAssetRow,
} from "./types";

export interface AnalyzeVisualAssetsArgs {
  readonly assets: readonly VisualAssetRow[];
  readonly query?: string;
  readonly userId?: string;
  readonly userDb?: any;
  readonly forcedResolution?: MediaResolutionLevel;
  readonly bypassCache?: boolean;
}

export async function analyzeVisualAssets(
  args: AnalyzeVisualAssetsArgs,
): Promise<ImageInputResult> {
  if (args.assets.length === 0) {
    return {
      assets: [],
      pages: [],
      canonical_sources: [],
      request_evidence: {
        relevant_text: "No visual assets provided for analysis.",
        relevant_pages: [],
        visual_findings: "",
      },
      warnings: ["No visual assets supplied"],
    };
  }

  // Idempotent cache check
  const combinedSha = args.assets.map((a) => a.sha256).sort().join(":");
  const cacheKey = computeVisualAnalysisCacheKey({
    sha256: combinedSha,
    model: "gemini-3.5-flash-lite",
    requestSpecificQuery: args.query,
  });

  if (!args.bypassCache) {
    const cached = getCachedVisualAnalysis(cacheKey);
    if (cached) {
      return {
        ...cached,
        token_usage: {
          input_tokens: 0,
          output_tokens: 0,
          cached: true,
          model: "gemini-3.5-flash-lite",
        },
      };
    }
  }

  const initialResolution = args.forcedResolution
    ? RESOLUTION_POLICIES[args.forcedResolution]
    : selectInitialResolutionPolicy({
        query: args.query,
        assetType: args.assets[0].asset_type,
        filename: args.assets[0].filename,
      });

  const batchItems: BatchItem[] = [];
  const warnings: string[] = [];

  for (const asset of args.assets) {
    const rawBuffer = await downloadVisualAssetBuffer({
      supabaseClient: args.userDb,
      storageBucket: asset.storage_bucket,
      storagePath: asset.storage_path,
    });

    if (asset.asset_type === "pdf") {
      let pageCount = asset.page_count;
      if (!pageCount || pageCount <= 0) {
        try {
          const info = await getPdfInfo(rawBuffer);
          pageCount = info.pageCount;
        } catch {
          pageCount = 1;
        }
      }

      const MAX_PAGES_TO_ANALYZE = 20; // Bounded protection
      const boundedPages = Math.min(pageCount, MAX_PAGES_TO_ANALYZE);

      for (let p = 1; p <= boundedPages; p += 1) {
        try {
          const rendered = await renderPdfPage({
            pdfBuffer: rawBuffer,
            pageNumber: p,
          });
          const preprocessed = await preprocessImage(rendered.imageBuffer, {
            maxWidth: initialResolution.maxWidth,
            maxHeight: initialResolution.maxHeight,
            format: "jpeg",
            quality: initialResolution.jpegQuality,
          });
          batchItems.push({
            assetId: asset.id,
            pageNumber: p,
            buffer: preprocessed.buffer,
            mimeType: preprocessed.mimeType,
            filename: asset.filename,
          });
        } catch (pageErr) {
          warnings.push(`Page ${p} of ${asset.filename} failed to render`);
        }
      }
    } else {
      // Native image (PNG, JPEG, WEBP, HEIC, HEIF)
      const preprocessed = await preprocessImage(rawBuffer, {
        maxWidth: initialResolution.maxWidth,
        maxHeight: initialResolution.maxHeight,
        format: "jpeg",
        quality: initialResolution.jpegQuality,
      });
      batchItems.push({
        assetId: asset.id,
        pageNumber: 1,
        buffer: preprocessed.buffer,
        mimeType: preprocessed.mimeType,
        filename: asset.filename,
      });
    }
  }

  if (batchItems.length === 0) {
    return {
      assets: args.assets.map((a) => ({
        attachment_id: a.id,
        filename: a.filename,
        asset_type: a.asset_type,
        pages_processed: 0,
      })),
      pages: [],
      canonical_sources: args.assets.map((a) => ({
        attachment_id: a.id,
        status: "failed",
      })),
      request_evidence: {
        relevant_text: "Visual content could not be rendered for analysis.",
        relevant_pages: [],
        visual_findings: "",
      },
      warnings: ["Rendering failed for all visual items"],
    };
  }

  const batches = partitionVisualBatches(batchItems, initialResolution);
  const pages: PageVisualEvidence[] = [];
  const relevantTexts: string[] = [];
  const relevantPages: number[] = [];
  const visualFindingsList: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastKeySlot: number | undefined;

  await waitForInternalGatewayReady();

  for (const batch of batches) {
    const payloadItems = batch.items.map((item) => ({
      filename: item.filename,
      mime_type: item.mimeType,
      image_base64: item.buffer.toString("base64"),
      page_number: item.pageNumber,
    }));

    const response = await fetch(getInternalGatewayUrl("/llm/image-input"), {
      method: "POST",
      headers: getInternalGatewayHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        items: payloadItems,
        query: args.query || "",
        media_resolution: initialResolution.level,
        user_id: args.userId || "authenticated-user",
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Visual analysis gateway error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      result: {
        pages?: PageVisualEvidence[];
        request_evidence?: {
          relevant_text?: string;
          relevant_pages?: number[];
          visual_findings?: string;
        };
      };
      input_tokens?: number;
      output_tokens?: number;
      key_slot?: number;
      model_used?: string;
    };

    totalInputTokens += data.input_tokens || 0;
    totalOutputTokens += data.output_tokens || 0;
    if (data.key_slot !== undefined) lastKeySlot = data.key_slot;

    const resultPages = data.result?.pages || [];
    for (const page of resultPages) {
      pages.push(page);
    }

    if (data.result?.request_evidence?.relevant_text) {
      relevantTexts.push(data.result.request_evidence.relevant_text);
    }
    if (Array.isArray(data.result?.request_evidence?.relevant_pages)) {
      relevantPages.push(...data.result.request_evidence.relevant_pages);
    }
    if (data.result?.request_evidence?.visual_findings) {
      visualFindingsList.push(data.result.request_evidence.visual_findings);
    }
  }

  // Refinement pass for pages with high uncertainty or low confidence if not already at high resolution
  if (initialResolution.level !== "high") {
    for (const page of pages) {
      if (shouldRefineAtHigherResolution(page)) {
        const itemToRefine = batchItems.find((b) => b.pageNumber === page.page_number);
        if (itemToRefine) {
          try {
            const highRes = RESOLUTION_POLICIES.high;
            const highPreprocessed = await preprocessImage(itemToRefine.buffer, {
              maxWidth: highRes.maxWidth,
              maxHeight: highRes.maxHeight,
              format: "jpeg",
              quality: highRes.jpegQuality,
            });

            const refineResponse = await fetch(getInternalGatewayUrl("/llm/image-input"), {
              method: "POST",
              headers: getInternalGatewayHeaders({ "Content-Type": "application/json" }),
              body: JSON.stringify({
                items: [
                  {
                    filename: itemToRefine.filename,
                    mime_type: highPreprocessed.mimeType,
                    image_base64: highPreprocessed.buffer.toString("base64"),
                    page_number: itemToRefine.pageNumber,
                  },
                ],
                query: `Re-examine page ${itemToRefine.pageNumber} with high attention to handwriting, math, and small details. ${args.query || ""}`,
                media_resolution: "high",
                user_id: args.userId || "authenticated-user",
              }),
              signal: AbortSignal.timeout(60_000),
            });

            if (refineResponse.ok) {
              const refineData = (await refineResponse.json()) as Record<string, any>;
              const refinedPage = refineData.result?.pages?.[0];
              if (refinedPage && refinedPage.extracted_text) {
                const targetIdx = pages.findIndex((p) => p.page_number === page.page_number);
                if (targetIdx >= 0) {
                  pages[targetIdx] = {
                    ...refinedPage,
                    confidence: "high",
                    needs_refinement: false,
                  };
                }
              }
              totalInputTokens += refineData.input_tokens || 0;
              totalOutputTokens += refineData.output_tokens || 0;
            }
          } catch {
            // Best effort refinement
          }
        }
      }
    }
  }

  const finalResult: ImageInputResult = {
    assets: args.assets.map((asset) => ({
      attachment_id: asset.id,
      filename: asset.filename,
      asset_type: asset.asset_type,
      pages_processed: pages.length,
    })),
    pages,
    canonical_sources: args.assets.map((asset) => ({
      attachment_id: asset.id,
      status: pages.length > 0 ? "ready" : "failed",
    })),
    request_evidence: {
      relevant_text:
        relevantTexts.join("\n\n") ||
        pages.map((p) => `[Page ${p.page_number}]\n${p.extracted_text}`).join("\n\n"),
      relevant_pages: [...new Set(relevantPages.length > 0 ? relevantPages : pages.map((p) => p.page_number))],
      visual_findings:
        visualFindingsList.join("\n\n") ||
        pages.map((p) => `[Page ${p.page_number} Visuals]: ${p.visual_summary}`).join("\n"),
    },
    warnings,
    token_usage: {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cached: false,
      key_slot: lastKeySlot,
      model: "gemini-3.5-flash-lite",
    },
  };

  setCachedVisualAnalysis(cacheKey, finalResult);
  return finalResult;
}
