import { getNemotronRolloutSnapshot } from "../nemotronRolloutFlags";
import {
  getRequestBudgetContext,
  releaseFutureTokenObligation,
  reserveFutureTokenObligation,
  type FutureTokenObligation,
} from "../context/requestBudgetContext";
import {
  INTUITIVE_GENERATION_POLICIES,
  estimateInputTokens,
  resolveInputContextCeiling,
  type RequestComplexity,
} from "./contextBudgetManager";
import type { ExecutionMode } from "./executionProfile";
import type { RouteEvidenceItem } from "./contextComposer";
import type { SentIQToolName } from "./toolContract";
import type { VisualAssetContext } from "../context/contextBuilder";

export const INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID = "intuitive-final-synthesis";

export function isNemotronIntuitiveLaneEnabled(mode: ExecutionMode | undefined): boolean {
  const flags = getNemotronRolloutSnapshot();
  return mode === "intuitive" && flags.nvidiaProvider && flags.nemotronIntuitive;
}

export function protectIntuitiveFinalSynthesis(args: {
  readonly userMessage: string;
  readonly complexity?: RequestComplexity;
  readonly knownContext?: readonly string[];
  readonly messageCount?: number;
}): FutureTokenObligation | null {
  const complexity = args.complexity ?? "normal";
  const requestContext = getRequestBudgetContext();
  const knownInput = [
    args.userMessage,
    ...(args.knownContext ?? []),
  ].filter(Boolean).join("\n\n");
  // Covers final prompt framing and a compact bounded tool-evidence block while
  // never reserving beyond the canonical composed-input ceiling.
  const conservativeInputEstimate = Math.min(
    resolveInputContextCeiling({
      planCode: requestContext.planCode,
      executionMode: "intuitive",
      complexity,
    }),
    estimateInputTokens(knownInput, args.messageCount ?? 1).tokens + 256,
  );
  return reserveFutureTokenObligation({
    id: INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID,
    protectedInputTokens: conservativeInputEstimate,
    protectedOutputTokens: INTUITIVE_GENERATION_POLICIES[complexity].protectedVisibleAnswerTokens,
  });
}

export function releaseIntuitiveFinalSynthesisProtection(): boolean {
  return releaseFutureTokenObligation(INTUITIVE_FINAL_SYNTHESIS_OBLIGATION_ID);
}

export function buildIntuitiveToolSelectionPrompt(
  userMessage: string,
  allowedTools: readonly SentIQToolName[],
  visualAssets?: readonly VisualAssetContext[],
): string {
  const parts: string[] = [
    "SYSTEM: Decide only whether one available SentIQ tool must run before the final answer.",
    "Do not answer the user's question and do not draft an answer.",
    "If a tool is required, call exactly one available tool with the smallest sufficient arguments.",
    "If no tool is required, output exactly NO_TOOL.",
    `Available SentIQ tools: ${allowedTools.join(", ") || "none"}`,
  ];

  if (visualAssets && visualAssets.length > 0) {
    parts.push("");
    parts.push("AVAILABLE VISUAL INPUTS:");
    for (const asset of visualAssets) {
      const isRequired = asset.visual_analysis_required ?? (asset.visual_analysis_status === "required" || asset.visual_required);
      const isAvailable = asset.canonical_text_available ?? Boolean(asset.canonical_source_document_id || asset.visual_analysis_status === "ready");
      const analysisStatus = isRequired ? "required" : "ready";
      const textStatus = isAvailable ? "available" : "none";
      parts.push(
        `- Asset ID: ${asset.asset_id} | File: ${asset.filename} | Type: ${asset.mime_type} | Visual Analysis: ${analysisStatus} | Canonical Text: ${textStatus}`,
      );
    }
    parts.push("When visual analysis is required for an attached visual input or image, call image_input with the target asset_id.");
  }

  parts.push("");
  parts.push("User request:");
  parts.push(userMessage);

  return parts.join("\n");
}

interface SynthesisStep {
  readonly tool: string;
  readonly reply?: string;
  readonly web_search?: {
    readonly query: string;
    readonly sources: readonly { title: string; url: string }[];
    readonly results?: readonly {
      title?: string;
      url?: string;
      content?: string;
      snippet?: string;
    }[];
  };
  readonly image?: {
    readonly success: boolean;
    readonly prompt: string;
    readonly persisted?: boolean;
  };
  readonly chart?: {
    readonly success: boolean;
    readonly chart_type: string;
    readonly renderer: string;
  };
  readonly file?: {
    readonly success: boolean;
    readonly format: string;
    readonly file_name: string;
    readonly mime_type: string;
    readonly text?: string;
  };
  readonly memory?: {
    readonly stored: boolean;
    readonly scope?: "global" | "chat";
    readonly persisted?: boolean;
    readonly deduplicated?: boolean;
  };
  readonly image_input?: {
    readonly success: boolean;
    readonly evidence: {
      readonly relevant_text: string;
      readonly relevant_pages?: readonly number[];
      readonly visual_findings?: readonly string[];
      readonly canonical_sources?: readonly {
        readonly attachment_id: string;
        readonly source_document_id?: string;
        readonly status: string;
      }[];
    };
    readonly assets_processed?: number;
    readonly pages_processed?: number;
  };
}

function truncate(value: string | undefined, maximum = 8_000): string | undefined {
  if (!value) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[trusted result truncated]`;
}

export function buildIntuitiveToolSynthesisEvidence(step: SynthesisStep): readonly RouteEvidenceItem[] {
  let trustedResult: Record<string, unknown>;
  if (step.image_input) {
    trustedResult = {
      tool: "image_input",
      success: step.image_input.success,
      relevant_text: truncate(step.image_input.evidence.relevant_text, 6_000),
      visual_findings: step.image_input.evidence.visual_findings?.slice(0, 5),
      relevant_pages: step.image_input.evidence.relevant_pages,
      canonical_sources: step.image_input.evidence.canonical_sources,
    };
  } else if (step.web_search) {
    trustedResult = {
      tool: "web_search",
      query: step.web_search.query,
      sources: step.web_search.sources.slice(0, 12),
      results: (step.web_search.results ?? []).slice(0, 8).map((result) => ({
        title: result.title,
        url: result.url,
        content: truncate(result.content ?? result.snippet, 2_000),
      })),
    };
  } else if (step.image) {
    trustedResult = {
      tool: "image_generation",
      success: step.image.success,
      prompt: truncate(step.image.prompt, 1_000),
      persisted: step.image.persisted === true,
    };
  } else if (step.chart) {
    trustedResult = {
      tool: "chart_generation",
      success: step.chart.success,
      chart_type: step.chart.chart_type,
      renderer: step.chart.renderer,
    };
  } else if (step.file) {
    trustedResult = {
      tool: "file_generation",
      success: step.file.success,
      format: step.file.format,
      file_name: step.file.file_name,
      mime_type: step.file.mime_type,
      text_preview: truncate(step.file.text, 4_000),
    };
  } else if (step.memory) {
    trustedResult = {
      tool: "memory_update",
      stored: step.memory.stored,
      scope: step.memory.scope,
      persisted: step.memory.persisted === true,
      deduplicated: step.memory.deduplicated === true,
    };
  } else {
    trustedResult = {
      tool: step.tool,
      result: truncate(step.reply, 4_000),
    };
  }

  return [{
    label: "trusted SentIQ tool result",
    content: JSON.stringify(trustedResult),
    required: true,
    relevance: 1,
  }];
}

export function shouldRunIntuitiveFinalSynthesis(step: SynthesisStep): boolean {
  if (step.image_input?.success) return true;
  if (step.web_search) return true;
  if (step.image?.success) return true;
  if (step.chart?.success) return true;
  if (step.file?.success) return true;
  return step.memory?.stored === true;
}
